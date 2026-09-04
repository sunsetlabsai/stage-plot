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
