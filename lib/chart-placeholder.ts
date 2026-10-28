import type { PDFDocumentProxy } from 'pdfjs-dist';

// ── Placeholder PDFs are not charts (backlog #204, Graham 2026-10-27) ────────
//
// A page carrying only a song title and key ("Love Shack / C") stands in for a chart
// that was never uploaded. It must not be offered an overlay or a calibration: there is
// nothing on it to perform from. Measured on the 87-chart corpus (2026-10-27): every one of
// the 17 placeholders inks exactly one filled box (4 segments) beside 2–7 words, and no
// images. A chart inks its staff, barlines or grid: the smallest — one staff, four bars —
// is 10 segments (Codex R1, #207).
//
// Segments, never path OPERATIONS: pdf.js packs a whole drawing into one `constructPath`,
// so counting ops called a real one-staff chart a placeholder. Any path data this module
// cannot decode counts as ink, so an unrecognised encoding errs toward "chart".

export const PLACEHOLDER_MAX_WORDS = 12;
export const PLACEHOLDER_MAX_SEGMENTS = 6;

export interface PdfContentCounts {
  words: number;
  segments: number; // drawn (inked) path segments; clip-only paths excluded
  images: number;
}

/** True when a PDF is a title page and nothing else. Any image means a scan — a chart. */
export function isPlaceholderCounts(c: PdfContentCounts): boolean {
  return c.images === 0 && c.words <= PLACEHOLDER_MAX_WORDS && c.segments <= PLACEHOLDER_MAX_SEGMENTS;
}

type Ops = { constructPath: number; endPath: number } & Record<string, number>;
const IMAGE_OPS = [
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintImageXObjectRepeat',
  'paintInlineImageXObjectGroup',
  'paintImageMaskXObjectGroup',
];

// pdf.js 5 path data interleaves draw codes with their coordinates:
// 0 moveTo (2), 1 lineTo (2), 2 curveTo (6), 3 quadraticCurveTo (4), 4 closePath (0).
const ARGC: Record<number, number> = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0 };
/** Unreadable data returns a count far over any placeholder limit. */
const UNREADABLE = 1_000;

function segmentsIn(data: unknown): number {
  if (!(data instanceof Float32Array) && !Array.isArray(data)) return UNREADABLE;
  const d = data as ArrayLike<number>;
  let n = 0;
  for (let i = 0; i < d.length; ) {
    const code = d[i];
    const argc = ARGC[code];
    if (argc === undefined) return UNREADABLE;
    if (code !== 0) n++; // every code but moveTo inks an edge (closePath draws the last one)
    i += 1 + argc;
  }
  return n;
}

/** Inked segments in one `constructPath` op's args ([paintOp, [data…], bbox] in pdf.js 5). */
function inkedSegments(args: unknown, ops: Ops): number {
  if (!Array.isArray(args) || !Array.isArray(args[1])) return UNREADABLE;
  if (args[0] === ops.endPath) return 0; // a clip: defines a region, paints nothing
  return (args[1] as unknown[]).reduce<number>((sum, d) => sum + segmentsIn(d), 0);
}

/**
 * Count text words, inked path segments and image paints across every page. Reads the
 * text layer and the operator list only — nothing is rendered, so it is cheap enough to
 * run when an owner opens a chart. `ops` is pdf.js's `OPS` table, passed in so this
 * module never loads pdf.js itself.
 */
export async function countPdfContent(doc: PDFDocumentProxy, ops: Ops): Promise<PdfContentCounts> {
  const imageOps = new Set(IMAGE_OPS.map((k) => ops[k]).filter((v): v is number => typeof v === 'number'));
  const counts: PdfContentCounts = { words: 0, segments: 0, images: 0 };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const text = await page.getTextContent();
    counts.words += text.items
      .map((i) => ('str' in i ? i.str : ''))
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    const list = await page.getOperatorList();
    list.fnArray.forEach((fn, i) => {
      if (fn === ops.constructPath) counts.segments += inkedSegments(list.argsArray[i], ops);
      else if (imageOps.has(fn)) counts.images++;
    });
  }
  return counts;
}
