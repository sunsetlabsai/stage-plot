'use client';

import { useEffect, useState } from 'react';
import type { Chart, Song } from '@/lib/types';
import { loadPdfDoc } from '@/lib/pdf-viewer';
import { measurePage, toPositionedText, isGeometryComplete } from '@/lib/chart-measure';
import { extractPageGeometry, RENDER_SCALE } from '@/lib/chart-measure-canvas';

// ── RENDER_SCALE device profile (docs/design-chart-measurement.md §Answered by B1 #3) ──
//
// `RENDER_SCALE = 3` is the ONE assumption in the measurement engine that was never
// measured — it was chosen on a laptop, against the corpus, and the corpus cannot say
// what it costs on the phone the owner actually builds overlays on. This page exists so
// a real device can answer, and it must be opened ON THAT DEVICE: nothing here can be
// run for you from a terminal.
//
// It is not a correctness cliff. Scales 2, 3, 4 and 8 all score 464/464 on the corpus;
// scale 1 scores 439/464. The trade is HEADROOM: pdf.js clamps strokes to ≥1 device
// pixel, so the recovered stroke-width floor is 1/scale points — 0.33pt at scale 3,
// 0.07pt at scale 2 — against a barline filter that discriminates at ~0.1pt on strokes
// as narrow as 0.43pt. So the question this page answers is narrow and empirical: on
// THIS phone, is scale 3 fast enough and does it fit in memory? If it is, keep the
// headroom. If it is not, 2 still scores 464/464 with almost none.
//
// The correctness columns are here for the same reason: a timing win that changes the
// verdicts is not a win, and on the owner's own charts that is directly observable.

const SCALES = [2, 3];
const PASSES = 2; // the first pass pays for font loading and worker warm-up

interface PageRow {
  page: number;
  ms: number;
  systems: number;
  validated: number;
  complete: boolean;
}

interface ScaleRun {
  scale: number;
  pass: number;
  totalMs: number;
  megapixels: number;
  heapMb: number | null;
  pages: PageRow[];
}

function heapMb(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : null;
}

/**
 * The measured run, at module scope on purpose: it is a timing harness, and `performance
 * .now()` inside a component body is exactly the impurity the React compiler refuses —
 * rightly, since a re-render must not silently re-time anything.
 */
async function runProfile(
  chart: Chart,
  label: string,
  report: (status: string, runs: ScaleRun[]) => void,
): Promise<void> {
  report(`Loading ${label}…`, []);
  const loaded = await loadPdfDoc(chart);
  if (!loaded) {
    report(`Could not load ${label}.`, []);
    return;
  }
  const out: ScaleRun[] = [];
  for (let pass = 1; pass <= PASSES; pass++) {
    for (const scale of SCALES) {
      report(`${label} — scale ${scale}, pass ${pass}…`, [...out]);
      // Yield so the status paints before a long synchronous burst.
      await new Promise((r) => setTimeout(r, 0));
      const run: ScaleRun = { scale, pass, totalMs: 0, megapixels: 0, heapMb: null, pages: [] };
      for (let p = 1; p <= loaded.doc.numPages; p++) {
        const page = await loaded.doc.getPage(p);
        const t0 = performance.now();
        const geo = await extractPageGeometry(page, scale);
        const ms = Math.round(performance.now() - t0);
        const [vx0, vy0, vx1, vy1] = page.view;
        const m = measurePage(
          geo.segments,
          toPositionedText(
            (await page.getTextContent()).items as { str: string; transform: number[] }[],
            vy1,
          ),
          { number: p, width: vx1 - vx0, height: vy1 - vy0 },
        );
        run.totalMs += ms;
        run.megapixels = Math.max(
          run.megapixels,
          Math.round(((vx1 - vx0) * (vy1 - vy0) * scale * scale) / 100000) / 10,
        );
        run.pages.push({
          page: p,
          ms,
          systems: m.systems.length,
          validated: m.systems.filter((s) => s.verdict === 'validated').length,
          complete: isGeometryComplete(geo),
        });
        run.heapMb = heapMb();
      }
      out.push(run);
      report(`${label} — scale ${scale}, pass ${pass} done.`, [...out]);
    }
  }
  report(`${label} — done.`, [...out]);
}

export default function MeasureProfilePage() {
  const [charts, setCharts] = useState<{ song: string; chart: Chart }[]>([]);
  const [status, setStatus] = useState('Loading your library…');
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<ScaleRun[]>([]);
  const [device, setDevice] = useState('');

  useEffect(() => {
    (async () => {
      // Inside the async body, not the effect body: the device string reads `navigator`
      // and `window`, which do not exist during SSR, and a synchronous setState in an
      // effect is what the repo's lint refuses.
      const nav = navigator as Navigator & { deviceMemory?: number };
      setDevice(
        [
          `dpr ${window.devicePixelRatio}`,
          `screen ${window.screen.width}×${window.screen.height}`,
          `cores ${nav.hardwareConcurrency ?? '?'}`,
          `deviceMemory ${nav.deviceMemory ?? '?'}GB`,
          navigator.userAgent,
        ].join(' · '),
      );
      const res = await fetch('/api/songs');
      if (!res.ok) {
        setStatus('Sign in as the owner first — this reads your library.');
        return;
      }
      const data = (await res.json()) as { songs: Song[] };
      const seen = new Set<string>();
      const list: { song: string; chart: Chart }[] = [];
      for (const song of data.songs ?? []) {
        for (const chart of song.charts ?? []) {
          if (!chart.fileId || seen.has(chart.fileId)) continue;
          seen.add(chart.fileId);
          list.push({ song: song.title, chart });
        }
      }
      setCharts(list);
      setStatus(list.length ? `${list.length} charts. Pick one.` : 'No charts in this library.');
    })();
  }, []);

  async function profile(chart: Chart, label: string) {
    setRunning(true);
    setRuns([]);
    await runProfile(chart, label, (s, r) => {
      setStatus(s);
      setRuns(r);
    });
    setRunning(false);
  }

  const byScale = (scale: number) => runs.filter((r) => r.scale === scale);
  const verdictsDiffer = (() => {
    const [a, b] = SCALES.map((s) => byScale(s).at(-1));
    if (!a || !b) return null;
    const sum = (r: ScaleRun) => r.pages.reduce((n, p) => n + p.validated, 0);
    const sys = (r: ScaleRun) => r.pages.reduce((n, p) => n + p.systems, 0);
    return sum(a) !== sum(b) || sys(a) !== sys(b);
  })();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-4 text-sm">
      <h1 className="text-lg font-bold mb-1">RENDER_SCALE device profile</h1>
      <p className="text-zinc-400 mb-3">
        Shipping scale is <b>{RENDER_SCALE}</b>. Each chart runs at scale 2 and 3, twice —
        the first pass pays for warm-up. Timing is the geometry extraction only.
      </p>
      <p className="text-zinc-500 text-xs break-words mb-4">{device}</p>

      <p className="mb-3 text-zinc-300">{status}</p>

      {!running && (
        <div className="flex flex-col gap-2 mb-6">
          {charts.map(({ song, chart }) => (
            <button
              key={chart.fileId}
              onClick={() => profile(chart, `${song} · ${chart.role}`)}
              className="text-left px-3 py-3 rounded bg-zinc-900 border border-zinc-800 active:bg-zinc-800"
            >
              <span className="font-bold">{song}</span>
              <span className="text-zinc-500"> · {chart.role}</span>
            </button>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="space-y-4">
          <table className="w-full text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="text-left">scale/pass</th>
                <th className="text-right">total ms</th>
                <th className="text-right">ms/page</th>
                <th className="text-right">MP/page</th>
                <th className="text-right">heap MB</th>
                <th className="text-right">systems</th>
                <th className="text-right">validated</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={`${r.scale}-${r.pass}`} className="border-t border-zinc-800">
                  <td>{r.scale} / pass {r.pass}</td>
                  <td className="text-right font-bold">{r.totalMs}</td>
                  <td className="text-right">{Math.round(r.totalMs / r.pages.length)}</td>
                  <td className="text-right">{r.megapixels}</td>
                  <td className="text-right">{r.heapMb ?? '—'}</td>
                  <td className="text-right">{r.pages.reduce((n, p) => n + p.systems, 0)}</td>
                  <td className="text-right">{r.pages.reduce((n, p) => n + p.validated, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {verdictsDiffer !== null && (
            <p className={verdictsDiffer ? 'text-amber-400' : 'text-emerald-400'}>
              {verdictsDiffer
                ? '⚠ Scale 2 and 3 DISAGREE on this chart — the cheaper scale changes the measurement, not just the timing.'
                : '✓ Scale 2 and 3 agree on systems and validated counts for this chart.'}
            </p>
          )}
          {runs[0]?.heapMb === null && (
            <p className="text-zinc-500 text-xs">
              Heap size is unavailable in this browser (Chrome-only API) — the honest
              memory signal here is whether a scale-3 run completes at all. A tab reload
              mid-run IS the out-of-memory result, and worth reporting as one.
            </p>
          )}
          {runs.some((r) => r.pages.some((p) => !p.complete)) && (
            <p className="text-zinc-500 text-xs">
              Some page reported incomplete geometry — that chart routes to the VLM
              regardless of scale.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
