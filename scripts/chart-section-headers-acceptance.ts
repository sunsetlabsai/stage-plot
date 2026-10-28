/**
 * Acceptance run for the section-header recognizer (docs/design-common-roadmap.md §4.1
 * step 2). Dev-only: never imported by the app, never run in CI.
 *
 * Run with: npx tsx scripts/chart-section-headers-acceptance.ts --dir <pdf dir> [--show]
 *
 * Reads every PDF's text layer with pdf.js (Node legacy build — the recognizer is pure,
 * so unlike the measurement harness no browser is needed), runs `findSectionHeaders`,
 * and prints how many PDFs reach `MIN_HEADERS_TO_OFFER`. `--show` prints every header
 * found, for the hand-check that no lyric line was misread as a header.
 *
 * The PDFs are real, copyrighted charts and stay OUT of the repo.
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  findSectionHeaders,
  MIN_HEADERS_TO_OFFER,
  type HeaderPage,
  type HeaderTextItem,
} from '../lib/chart-section-headers';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DIR = arg('dir');
if (!DIR) {
  console.error('usage: --dir <pdf dir> [--show]');
  process.exit(2);
}
const SHOW = process.argv.includes('--show');

async function pagesOf(file: string): Promise<HeaderPage[]> {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
  const pages: HeaderPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const text = await page.getTextContent();
    pages.push({
      page: p,
      viewport: (({ transform, width, height }) => ({ transform: [...transform], width, height }))(page.getViewport({ scale: 1 })),
      items: text.items.filter((it): it is HeaderTextItem & typeof it => 'str' in it),
    });
  }
  await doc.destroy();
  return pages;
}

async function main(dir: string): Promise<void> {
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
let offered = 0;
let failed = 0;
const none: string[] = [];
for (const f of files) {
  try {
    const headers = findSectionHeaders(await pagesOf(path.join(dir, f)));
    if (headers.length >= MIN_HEADERS_TO_OFFER) offered++;
    else none.push(`${f} (${headers.length})`);
    if (SHOW) {
      console.log(`== ${f}`);
      for (const h of headers) console.log(`   p${h.page} y=${h.y.toFixed(3)} ${JSON.stringify(h.label)}`);
    }
  } catch (err) {
    failed++;
    console.error(`!! ${f}: ${(err as Error).message}`);
  }
}
console.log(`\n${offered}/${files.length} PDFs have >= ${MIN_HEADERS_TO_OFFER} headers (${failed} unreadable)`);
if (none.length) console.log(`below the bar:\n  ${none.join('\n  ')}`);
}

main(DIR).catch((err) => {
  console.error(err);
  process.exit(1);
});
