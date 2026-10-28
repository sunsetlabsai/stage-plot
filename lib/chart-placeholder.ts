import type { PDFDocumentProxy } from 'pdfjs-dist';

// ── Placeholder PDFs are not charts (backlog #204, Graham 2026-10-27) ────────
//
// A page carrying only a song title and key ("Love Shack / C") stands in for a chart
// that was never uploaded. It must not be offered an overlay or a calibration: there is
// nothing on it to perform from. Measured on the 87-chart corpus (2026-10-27): all 17
// placeholders have 2–7 words, exactly 2 drawing paths (page furniture) and no images;
// the nearest real chart has 92 words and 91 paths, and a chords-over-lyrics sheet has
// 150+ words. The limits below sit far inside that gap on both sides.

export const PLACEHOLDER_MAX_WORDS = 12;
export const PLACEHOLDER_MAX_PATHS = 4;

export interface PdfContentCounts {
  words: number;
  paths: number;
  images: number;
}

/** True when a PDF is a title page and nothing else. Any image means a scan — a chart. */
export function isPlaceholderCounts(c: PdfContentCounts): boolean {
  return c.images === 0 && c.words <= PLACEHOLDER_MAX_WORDS && c.paths <= PLACEHOLDER_MAX_PATHS;
}

type Ops = { constructPath: number } & Record<string, number>;
const IMAGE_OPS = [
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintImageXObjectRepeat',
  'paintInlineImageXObjectGroup',
  'paintImageMaskXObjectGroup',
];

/**
 * Count text words, path constructions and image paints across every page. Reads the
 * text layer and the operator list only — nothing is rendered, so it is cheap enough to
 * run when an owner opens a chart. `ops` is pdf.js's `OPS` table, passed in so this
 * module never loads pdf.js itself.
 */
export async function countPdfContent(doc: PDFDocumentProxy, ops: Ops): Promise<PdfContentCounts> {
  const imageOps = new Set(IMAGE_OPS.map((k) => ops[k]).filter((v): v is number => typeof v === 'number'));
  const counts: PdfContentCounts = { words: 0, paths: 0, images: 0 };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const text = await page.getTextContent();
    counts.words += text.items
      .map((i) => ('str' in i ? i.str : ''))
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    const list = await page.getOperatorList();
    for (const fn of list.fnArray) {
      if (fn === ops.constructPath) counts.paths++;
      else if (imageOps.has(fn)) counts.images++;
    }
  }
  return counts;
}
