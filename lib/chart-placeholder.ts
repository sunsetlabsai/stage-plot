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
// What a placeholder lacks is CHORDS: a title and one key, never a progression. Word counts
// alone could not tell "Love Shack / C" from "Blues / Verse: A D E A / Chorus: F#m D E A",
// a real text-only chart with no ink (Codex R2, #207). A title that happens to hold a
// chord-like word ("A Day in the Life", "9 to 5") only pushes toward "chart" — the safe way.
//
// KNOWN LIMIT (Codex R3; accepted by Graham 2026-10-27): no content rule can tell a one-chord
// vamp chart ("A7sus4 vamp / Repeat until cue") from a title + key. So a match is ADVISORY:
// it hides Build overlay — which the server already refuses for staff-less text — and says
// so, but never hides Calibrate. A wrong match costs a misleading line, not a stuck chart.
//
// Segments, never path OPERATIONS: pdf.js packs a whole drawing into one `constructPath`,
// so counting ops called a real one-staff chart a placeholder. Any path data this module
// cannot decode counts as ink, so an unrecognised encoding errs toward "chart".

export const PLACEHOLDER_MAX_WORDS = 12;
export const PLACEHOLDER_MAX_SEGMENTS = 6;
/** The key printed under the title is the one chord-like token a placeholder carries. */
export const PLACEHOLDER_MAX_CHORDS = 1;

export interface PdfContentCounts {
  words: number;
  segments: number; // drawn (inked) path segments; clip-only paths excluded
  images: number;
  chords: number; // chord-like text tokens (letter or Nashville), see chordTokens
}

/** True when a PDF is a title page and nothing else. Any image means a scan — a chart. */
export function isPlaceholderCounts(c: PdfContentCounts): boolean {
  return (
    c.images === 0 &&
    c.words <= PLACEHOLDER_MAX_WORDS &&
    c.segments <= PLACEHOLDER_MAX_SEGMENTS &&
    c.chords <= PLACEHOLDER_MAX_CHORDS
  );
}

// A whole token that reads as a chord: letter root (A–G, accidental, quality, extension,
// slash bass) or a Nashville degree (1–7, same tail). Anchored, so ordinary words that
// merely start with A–G ("Dancing", "Each", "Add") never match.
const QUAL = '(?:maj|min|m|dim|aug|sus|add|M|°|ø|△|Δ|\\+|-|–|\\d|b|#|♭|♯)*';
const LETTER_CHORD = new RegExp(`^[A-G][#b♭♯]?${QUAL}(?:/[A-G][#b♭♯]?)?$`);
const NNS_CHORD = new RegExp(`^[#b♭♯]?[1-7]${QUAL}(?:/[1-7])?$`);

/** Count chord-like tokens across text runs (punctuation such as "Verse:" is dropped). */
export function chordTokens(runs: string[]): number {
  let n = 0;
  // Barline pipes separate chords too: "|A|D|E|A|" is four (Codex R3, #207).
  for (const tok of runs.join(' ').split(/[\s|]+/)) {
    const t = tok.replace(/^[([{"']+|[)\]}"',.:;!?]+$/g, '');
    if (t && (LETTER_CHORD.test(t) || NNS_CHORD.test(t))) n++;
  }
  return n;
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
  const counts: PdfContentCounts = { words: 0, segments: 0, images: 0, chords: 0 };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const text = await page.getTextContent();
    const runs = text.items.map((i) => ('str' in i ? i.str : ''));
    counts.words += runs.join(' ').split(/\s+/).filter(Boolean).length;
    counts.chords += chordTokens(runs);
    const list = await page.getOperatorList();
    list.fnArray.forEach((fn, i) => {
      if (fn === ops.constructPath) counts.segments += inkedSegments(list.argsArray[i], ops);
      else if (imageOps.has(fn)) counts.images++;
    });
  }
  return counts;
}
