/**
 * Acceptance harness for the chart measurement engine (docs/design-chart-measurement.md
 * §Acceptance harness). Dev-only: never imported by the app, never run in CI.
 *
 * Run with: npx tsx scripts/chart-measure-acceptance.ts
 *   --corpus <dir>     default ~/chart-spike
 *   --expected <file>  default <corpus>/measure-expected.json
 *   --write            (re)write the expected file from this run instead of checking
 *   --scale <n>        override RENDER_SCALE, for re-deriving the scale floor
 *   --only <substr>    restrict to matching filenames, for debugging one chart
 *
 * The corpus is real, copyrighted charts and stays OUT of the repo, along with the
 * expected-results file derived from it. The engine is what ships; this is the thing
 * that says the engine still works.
 *
 * ★ The score IS the objective function. The pipeline self-validates — measured span
 * counts are checked against the measure numbers the engraver printed on the page — so
 * any rule change that helps or hurts shows up as score movement on 464 real systems.
 * Change a constant in lib/chart-measure.ts, run this, or you are guessing.
 *
 * Requires a local Chrome (the recording shim needs a real Canvas2D + Path2D) and the
 * puppeteer-core devDependency. lib/chart-measure-canvas.ts is transpiled on the fly
 * with the TypeScript compiler API and served to the page, so this exercises the actual
 * repo source rather than a copy that can drift.
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import puppeteer, { type Page } from 'puppeteer-core';
import { measurePage, toPositionedText, type MeasuredSegment } from '../lib/chart-measure';
import { resegment } from '../lib/chart-resegment';
import { RENDER_SCALE } from '../lib/chart-measure-canvas';

/** Installed on the page by PAGE_HTML below; only this script ever calls them. */
declare global {
  var __extract: (
    url: string,
    pageNum: number,
    scale: number,
  ) => Promise<{ segments: MeasuredSegment[]; warnings: string[]; opaque: Record<string, number> }>;
  var __pages: (url: string) => Promise<number>;
}

const REPO = path.resolve(__dirname, '..');
const PDFJS_BUILD = path.join(REPO, 'node_modules/pdfjs-dist/build');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const HAS = (name: string) => process.argv.includes(`--${name}`);

const CORPUS = arg('corpus') ?? path.join(os.homedir(), 'chart-spike');
const EXPECTED = arg('expected') ?? path.join(CORPUS, 'measure-expected.json');
const SCALE = Number(arg('scale') ?? RENDER_SCALE);
const ONLY = arg('only');

interface FileResult {
  file: string;
  pages: number;
  classification: Record<string, number>;
  staves: number;
  systems: number;
  spans: number;
  validated: number;
  scored: number;
  /**
   * `fillRect` calls PER PAGE, indexed page 1 → `[0]`. Every entry must be exactly 1.
   *
   * ★ Pins ONE empirical assumption the never-gate rests on (see
   * docs/design-chart-measurement.md §`fillRect` is bounded, not excluded). The
   * completeness predicate admits `fillRect <= 1` per page because pdf.js emits exactly
   * one structural page-background fill. That bound is NOT symmetrically safe: extra
   * fillRects fail closed, but ZERO would let a hiding fill become the first on its page
   * and be admitted. No count-based clause can close that, so the assumption is asserted
   * every run rather than reasoned about — a silent drift to zero is the failure mode,
   * and it is invisible in every other number this harness prints.
   *
   * ★★ PER PAGE, not a file total (Codex, #176). A file sum is the WRONG SHAPE for a
   * per-page predicate: a 2-page file counting [0, 2] sums to 2 over 2 pages and passes,
   * while page 1 has lost its background fill (fails OPEN — a hiding fill would be
   * admitted as the first on that page) and page 2 carries an extra one. The aggregate
   * hides both. Keep the categories the predicate is written over.
   */
  fillRectByPage: number[];
  /**
   * C5 — the count fallback, scored on real charts (docs/design-chart-review-step.md §C5).
   *
   * Arm 1 (fidelity): for every `validated` system, pin N to its known span count and
   * re-segment from the stage-2 clusters ALONE. The split must come back identical.
   *
   * ⚠ Arm 1 is NOT self-protecting. `spans === clusters.length - (lineStartRepeat ? 1 : 0)`
   * exactly, so a re-segmenter could re-derive the engine's own answer and echo it. That
   * is why `forced` is reported: where the cluster count already equals N there was no
   * choice to make and the arm proves nothing about ranking.
   *
   * Arm 2 (load-bearing): ask for N ± 1, a count the engine never produced. There is no
   * answer to echo, so the only honest outcomes are a genuinely all-observed segmentation
   * or a refusal. `wrongAccepted` is the measured size of the floor's
   * necessary-not-sufficient gap.
   */
  arm1Total: number;
  arm1Exact: number;
  arm1Forced: number;
  arm1Failures: string[];
  arm2Total: number;
  arm2Accepted: number;
  /** Accepted split by direction — an undercount and an overcount fail very differently. */
  arm2AcceptedMinus: number;
  arm2AcceptedPlus: number;
  arm2RankedMinus: number;
  arm2Invented: string[];
  /** Pages whose MediaBox origin is not (0,0) — see the text-flip note at the call site. */
  shiftedOrigin: number[];
  failures: string[];
}

// ── Serving the engine + corpus to the browser ───────────────────────────────

function transpile(file: string): string {
  const src = readFileSync(path.join(REPO, file), 'utf8');
  return ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
}

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>measure acceptance</title>
<script type="module">
  import * as pdfjsLib from '/pdfjs/pdf.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
  const { extractPageGeometry } = await import('/engine/chart-measure-canvas.js');
  globalThis.__extract = async (url, pageNum, scale) => {
    const doc = await pdfjsLib.getDocument({ url, useSystemFonts: true }).promise;
    const page = await doc.getPage(pageNum);
    const geo = await extractPageGeometry(page, scale);
    await doc.destroy();
    return geo;
  };
  globalThis.__pages = async (url) => {
    const doc = await pdfjsLib.getDocument({ url }).promise;
    const n = doc.numPages;
    await doc.destroy();
    return n;
  };
  globalThis.__ready = true;
</script>`;

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.pdf': 'application/pdf',
};

function startServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE_HTML);
      return;
    }
    if (url === '/engine/chart-measure-canvas.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(transpile('lib/chart-measure-canvas.ts'));
      return;
    }
    const file = url.startsWith('/pdfjs/')
      ? path.join(PDFJS_BUILD, path.basename(url))
      : url.startsWith('/corpus/')
        ? path.join(CORPUS, path.basename(url))
        : null;
    if (!file || !existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

/** Corpus PDFs, deduped by content hash — the corpus holds several copies of some charts. */
function corpusFiles(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of readdirSync(CORPUS).filter((n) => n.toLowerCase().endsWith('.pdf')).sort()) {
    const hash = createHash('md5').update(readFileSync(path.join(CORPUS, f))).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (!ONLY || f.includes(ONLY)) out.push(f);
  }
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────

async function measureFile(browser: Page, nodePdfjs: typeof import('pdfjs-dist'), file: string) {
  const url = `/corpus/${encodeURIComponent(file)}`;
  const pages: number = await browser.evaluate((u) => globalThis.__pages(u), url);
  const doc = await nodePdfjs.getDocument({ url: path.join(CORPUS, file), useSystemFonts: true })
    .promise;

  const result: FileResult = {
    file,
    pages,
    classification: {},
    staves: 0,
    systems: 0,
    spans: 0,
    validated: 0,
    scored: 0,
    fillRectByPage: [],
    shiftedOrigin: [],
    failures: [],
    arm1Total: 0,
    arm1Exact: 0,
    arm1Forced: 0,
    arm1Failures: [],
    arm2Total: 0,
    arm2Accepted: 0,
    arm2AcceptedMinus: 0,
    arm2AcceptedPlus: 0,
    arm2RankedMinus: 0,
    arm2Invented: [],
  };

  for (let p = 1; p <= pages; p++) {
    const geo = await browser.evaluate((u, n, s) => globalThis.__extract(u, n, s), url, p, SCALE);
    if (geo.warnings.length) result.failures.push(`p${p} WARN ${geo.warnings.join(',')}`);
    result.fillRectByPage.push(geo.opaque.fillRect ?? 0);
    const pdfPage = await doc.getPage(p);
    const text = await pdfPage.getTextContent();

    // ★ Two DIFFERENT quantities, deliberately not the same expression (Codex, #176).
    //
    // `textFlipY` is the baseline B1 flips text against. B1 used `view[3]` raw, i.e.
    // assuming a MediaBox origin at (0,0), and that is preserved verbatim: "correcting"
    // it would move measured output on a shifted-origin page, and parity is the gate.
    //
    // The page DIMENSIONS are a different thing and must be honest, because B2
    // normalizes bar geometry against them — a wrong denominator puts every bar in the
    // wrong place. pdf.js viewport dimensions are the view box's EXTENT, not its far
    // corner. Conflating the two (as the first cut of this PR did) silently exports B1's
    // origin assumption into B2's normalization.
    const [vx0, vy0, vx1, vy1] = pdfPage.view;
    const textFlipY = vy1;
    if (vx0 !== 0 || vy0 !== 0) result.shiftedOrigin.push(p);

    const m = measurePage(
      geo.segments,
      toPositionedText(text.items as { str: string; transform: number[] }[], textFlipY),
      { number: p, width: vx1 - vx0, height: vy1 - vy0 },
    );
    result.classification[m.classification] = (result.classification[m.classification] ?? 0) + 1;
    result.staves += m.staffCount;
    for (const s of m.systems) {
      result.systems++;
      result.spans += s.spans;
      if (s.verdict === 'validated') {
        result.validated++;
        result.scored++;

        // ── C5 arm 1 — fidelity at the true N ──────────────────────────────
        // The re-segmenter sees clusters + lineStartRepeat + the staff bounds and the
        // pinned count. It is NOT handed `s.bars` or `s.spans`; the expected split is
        // held out here and compared only after it returns.
        const inp = {
          clusters: s.clusters,
          lineStartRepeat: s.lineStartRepeat,
          x0: s.x0,
          x1: s.x1,
          modalWidth: m.modalWidth,
        };
        result.arm1Total++;
        const usable = s.lineStartRepeat ? s.clusters.length - 1 : s.clusters.length;
        if (usable === s.spans) result.arm1Forced++;
        const got = resegment(inp, s.spans);
        const same =
          got.ok &&
          got.bars!.length === s.bars.length &&
          got.bars!.every(
            (b, i) =>
              Math.abs(b.xStart - s.bars[i].xStart) < 1e-9 &&
              Math.abs(b.xEnd - s.bars[i].xEnd) < 1e-9,
          );
        if (same) result.arm1Exact++;
        else
          result.arm1Failures.push(
            `p${p} y${Math.round(s.yTop)} n=${s.spans} clusters=${s.clusters.length} ` +
              `lsr=${s.lineStartRepeat} ${got.ok ? 'MISMATCH' : `refused:${got.reason}`}`,
          );

        // ── C5 arm 2 — a count the engine never produced ───────────────────
        // No engine answer exists at N ± 1, so a splitter cannot echo one. Accepting
        // a wrong N is not automatically a bug — a surplus cluster can make N-1 or N+1
        // genuinely all-observed — but the RATE is the measured size of the gap, and
        // inventing an edge is always a bug, so both are reported.
        for (const delta of [-1, 1]) {
          const n = s.spans + delta;
          if (n < 1) continue;
          result.arm2Total++;
          const out = resegment(inp, n);
          if (!out.ok) continue;
          result.arm2Accepted++;
          if (delta < 0) {
            result.arm2AcceptedMinus++;
            // usable > n here means the ranking actually had to choose which cluster to
            // drop — the only place on this corpus where clusterScore runs at all.
            if (usable > n) result.arm2RankedMinus++;
          } else result.arm2AcceptedPlus++;
          const edges = new Set(s.clusters.map((c) => c.x));
          const leading = s.lineStartRepeat && s.clusters.length ? s.clusters[0].x : s.x0;
          const invented =
            out.bars!.some((b) => !edges.has(b.xEnd)) ||
            (out.bars!.length > 0 && out.bars![0].xStart !== leading);
          if (invented) {
            result.arm2Invented.push(`p${p} y${Math.round(s.yTop)} n=${n} INVENTED AN EDGE`);
          }
        }
      } else if (s.verdict === 'uncertain') {
        result.scored++;
        result.failures.push(
          `p${p} y${Math.round(s.yTop)} spans=${s.spans} expected=${s.expectedSpans} ` +
            `mr=[${s.multirests.map((r) => `${r.count}@${Math.round(r.xStart)}-${Math.round(r.xEnd)}`).join(',')}]`,
        );
      }
    }
  }
  await doc.destroy();
  return result;
}

async function main() {
  const { server, port } = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('globalThis.__ready === true', { timeout: 30_000 });

  // pdf.js in node, for the text layer only — identical code either side, so the
  // geometry source is the only variable this harness is measuring.
  const nodePdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist');

  const files = corpusFiles();
  const results: FileResult[] = [];
  for (const f of files) {
    try {
      results.push(await measureFile(page, nodePdfjs, f));
    } catch (e) {
      console.log(`ERROR ${f}: ${(e as Error).message.slice(0, 120)}`);
      process.exitCode = 1;
    }
  }
  await browser.close();
  server.close();
  for (const e of pageErrors) console.log(`PAGE ERROR: ${e}`);

  const validated = results.reduce((a, r) => a + r.validated, 0);
  const scored = results.reduce((a, r) => a + r.scored, 0);
  const zeroStaff = results.filter((r) => r.staves === 0);
  const notNotation = zeroStaff.filter((r) => (r.classification['not-notation'] ?? 0) > 0).length;
  console.log(`\nscale=${SCALE}  files=${results.length}`);
  console.log(`validation: ${validated}/${scored} scored systems validated`);
  console.log(`staves=${results.reduce((a, r) => a + r.staves, 0)}  spans=${results.reduce((a, r) => a + r.spans, 0)}`);
  // Both halves matter: the never-gate fires on `not-notation`, while `raster` routes to
  // the whole-page VLM instead. Reporting only one hides a chart moving between them.
  console.log(
    `zero-staff files=${zeroStaff.length} (not-notation=${notNotation}, raster=${zeroStaff.length - notNotation})`,
  );

  // ── C5: the count fallback's score ─────────────────────────────────────────
  const a1Total = results.reduce((a, r) => a + r.arm1Total, 0);
  const a1Exact = results.reduce((a, r) => a + r.arm1Exact, 0);
  const a1Forced = results.reduce((a, r) => a + r.arm1Forced, 0);
  const a2Total = results.reduce((a, r) => a + r.arm2Total, 0);
  const a2Accepted = results.reduce((a, r) => a + r.arm2Accepted, 0);
  const invented = results.flatMap((r) => r.arm2Invented.map((f) => `${r.file} ${f}`));
  const a1Fails = results.flatMap((r) => r.arm1Failures.map((f) => `${r.file} ${f}`));

  console.log(`\nC5 arm 1 (true N): ${a1Exact}/${a1Total} exact`);
  // ★ Reported, not buried: where the cluster count already equals N the re-segmenter had
  // no choice to make, so arm 1 proves nothing about ranking for those systems. A high
  // forced fraction means arm 2 is carrying the test, which is exactly what §C5 says.
  console.log(
    `  forced (no choice available): ${a1Forced}/${a1Total}` +
      ` — ${a1Total - a1Forced} systems actually exercised the ranking`,
  );
  for (const f of a1Fails.slice(0, 10)) console.log(`  FAIL ${f}`);
  const a2Minus = results.reduce((a, r) => a + r.arm2AcceptedMinus, 0);
  const a2Plus = results.reduce((a, r) => a + r.arm2AcceptedPlus, 0);
  const a2Ranked = results.reduce((a, r) => a + r.arm2RankedMinus, 0);
  console.log(
    `C5 arm 2 (N±1): ${a2Accepted}/${a2Total} accepted` +
      ` — the measured size of the floor's necessary-not-sufficient gap`,
  );
  // The two directions are different failures and must not be reported as one number.
  // N+1 accepted would mean the endpoint contract leaks (trap 2). N-1 accepted is
  // expected: dropping a real barline yields a fully-observed, wrong split, which is
  // precisely what the floor cannot see.
  console.log(
    `  by direction: N-1 accepted ${a2Minus}, N+1 accepted ${a2Plus}` +
      ` (N+1 must be 0 — that is trap 2)`,
  );
  console.log(`  ranking exercised on ${a2Ranked} of the N-1 cases`);
  if (a2Plus > 0) {
    console.log(`\n*** C5 ARM 2: an overcount was accepted — endpoint contract leaks ***`);
    process.exitCode = 1;
  }
  for (const f of invented.slice(0, 10)) console.log(`  ${f}`);

  // Arm 1 is a hard gate: at the true N the re-segmenter must reproduce the engine.
  if (a1Exact !== a1Total) {
    console.log(`\n*** C5 ARM 1 FAILED: ${a1Total - a1Exact} systems did not reproduce ***`);
    process.exitCode = 1;
  }
  // Inventing an edge is unconditionally a bug at ANY N — the floor's one absolute.
  if (invented.length > 0) {
    console.log(`\n*** C5 ARM 2 FAILED: ${invented.length} segmentations invented an edge ***`);
    process.exitCode = 1;
  }

  // ★ The pinned assumption behind the never-gate's `fillRect <= 1` clause. Asserted
  // rather than reported, because the dangerous direction — pdf.js emitting NO page
  // background fill — fails OPEN and shows up in no other number here.
  //
  // Evaluated PER PAGE. A file total would let [0, 2] pass as "2 over 2 pages" while
  // both of its pages violate the predicate in opposite directions.
  const offenders: string[] = [];
  let pagesChecked = 0;
  let fillRectTotal = 0;
  for (const r of results) {
    for (const [i, n] of r.fillRectByPage.entries()) {
      pagesChecked++;
      fillRectTotal += n;
      if (n !== 1) offenders.push(`  FILLRECT ${r.file} p${i + 1}: ${n} (expected 1)`);
    }
  }
  console.log(
    `fillRect: ${fillRectTotal} over ${pagesChecked} pages, ` +
      `${pagesChecked - offenders.length}/${pagesChecked} pages exactly 1`,
  );
  const shifted = results.flatMap((r) => r.shiftedOrigin.map((p) => `${r.file} p${p}`));
  console.log(
    shifted.length === 0
      ? 'MediaBox origin: (0,0) on every page — B1\'s raw view[3] text flip is exact here'
      : `MediaBox origin: SHIFTED on ${shifted.length} page(s) — ${shifted.slice(0, 3).join(', ')}`,
  );
  if (offenders.length > 0) {
    for (const line of offenders) console.log(line);
    console.log(
      `\nFILLRECT ASSERTION FAILED — ${offenders.length} page(s) not exactly 1.\n` +
        `  The completeness predicate admits fillRect <= 1 assuming one structural\n` +
        `  background fill per page. Re-measure before trusting the never-gate: a drop\n` +
        `  toward zero fails OPEN (docs/design-chart-measurement.md).`,
    );
    process.exitCode = 1;
  }

  if (HAS('write')) {
    writeFileSync(EXPECTED, `${JSON.stringify(results, null, 1)}\n`);
    console.log(`\nwrote ${EXPECTED} (${results.length} files) — REVIEW the score before trusting it`);
    return;
  }

  if (!existsSync(EXPECTED)) {
    console.log(`\nno expected file at ${EXPECTED}; run once with --write`);
    process.exitCode = 1;
    return;
  }

  // Compare every field, not just the headline score: two runs can total the same while
  // disagreeing chart by chart.
  const expected: FileResult[] = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const byFile = new Map(results.map((r) => [r.file, r]));
  let diffs = 0;
  for (const e of expected) {
    const got = byFile.get(e.file);
    if (!got) {
      console.log(`MISSING ${e.file}`);
      diffs++;
      continue;
    }
    for (const k of ['pages', 'staves', 'systems', 'spans', 'validated', 'scored', 'classification'] as const) {
      if (JSON.stringify(got[k]) !== JSON.stringify(e[k])) {
        console.log(`DIFF ${e.file} ${k}: expected ${JSON.stringify(e[k])} got ${JSON.stringify(got[k])}`);
        diffs++;
      }
    }
  }
  for (const r of results) if (!expected.some((e) => e.file === r.file)) console.log(`EXTRA ${r.file}`);

  console.log(diffs === 0 ? '\nPARITY: clean' : `\nPARITY: ${diffs} field diffs`);
  if (diffs > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
