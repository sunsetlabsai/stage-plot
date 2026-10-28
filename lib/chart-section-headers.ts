// ── Section headers from a chart's text layer (docs/design-common-roadmap.md §4.1) ──
//
// PURE. The one header grammar, shared by two consumers: the section-anchor read
// (headers → `SectionAnchor`s, Track B anchors) and, later, the lyrics proposer
// (headers + counts → `RoadmapSpec`, docs/design-song-form-from-lyrics.md §2). One
// grammar, two consumers — a second recognizer is how the anchors and the proposed
// form would come to disagree about what a header is.
//
// A header read spends nothing and produces no uncertain badges, so neither overlay
// never-gate applies to it (§4.1 step 1): `overlaySkipReason` still means "never send to
// the converter", and nothing here goes near the converter.
//
// Evidence of presence only: a line is a header when the WHOLE line is one — a section
// word, an optional number, an optional count — or a whole line in [brackets] that opens
// with one. A section word inside a lyric line ("the chorus of the night") never counts.

import { isValidSectionAnchor } from './chart-calibration';
import type { SectionAnchor } from './types';

/** A pdf.js text item, as much of it as this module reads. */
export interface HeaderTextItem {
  str: string;
  transform: number[]; // [a, b, c, d, e, f]; e/f = baseline origin in PDF user space
  width?: number; // advance width in user space, when pdf.js supplies it
  height?: number; // font height in user space, when pdf.js supplies it
}

/**
 * One page's text, with the viewport the page is RENDERED through (pdf.js
 * `page.getViewport({ scale: 1 })`). Positions are normalized through that viewport, not the
 * raw page box: the viewer renders through it (`pdf-viewer.ts`), so it is the only frame in
 * which a mark lands on its text — including on a page with a /Rotate (Codex R1: a 90°
 * page put a header drawn at x≈0.88 at x=0.10).
 */
export interface HeaderPage {
  page: number; // 1-based
  viewport: { transform: number[]; width: number; height: number };
  items: HeaderTextItem[];
}

export interface SectionHeader {
  page: number;
  x: number; // 0..1, left edge of the line's first glyph
  y: number; // 0..1, top→bottom, at the glyph top
  label: string; // as printed, count and trailing colon stripped ("VERSE 1", "Outro (Fade out)")
  /** The printed count, kept for the proposer: `8x` = bars in the section, `x2` = plays. */
  count: { bars: number } | { plays: number } | null;
}

// The section vocabulary (§1's measured rule). `pre-` / `post-` combine with any of them
// ("Pre-Chorus", "Pre-Verse", "Post-Chorus").
const SECTION_WORDS = [
  'intro', 'verse', 'chorus', 'bridge', 'solo', 'outro', 'out', 'tag', 'ending',
  'interlude', 'break', 'breakdown', 'vamp', 'refrain', 'hook', 'instrumental', 'coda',
  'turnaround',
];
const WORD = `(?:(?:pre|post)[- ]?)?(?:${SECTION_WORDS.join('|')})`;
// Label = one or two section words ("Chorus Instrumental", "Intro Vamp") + optional ordinal
// number ("Verse 2"). Count = `8x` (bars) or `x2` (plays), optionally parenthesised; × is
// accepted for x.
// ⚠ The ordinal may not run into an x or another digit: "VERSE 16X" is a 16-bar verse, not
// verse 1 with a count of 6 — the browser drive caught that reading on a live sheet.
const CORE = `${WORD}(?:\\s+${WORD})?(?:\\s+\\d{1,2}(?![\\dx×]))?`;
const LABEL = `(${CORE})`;
// Bars are written tight ("8X" — every one of the 1,000+ on the live library); a lone "X" or
// "?X" is a count the author left blank, so "VERSE 1 X" is verse 1, count unknown — not a
// one-bar verse.
const COUNT = `\\(?\\s*(?:(\\d{1,2})[x×]|[x×]\\s*(\\d{1,2})|\\??[x×])\\s*\\)?`;
const BARE_RE = new RegExp(`^${LABEL}\\s*:?\\s*(?:${COUNT})?\\s*:?$`, 'i');
// Bracketed: the SAME label grammar as a bare line, plus an optional note in parentheses
// kept as printed ("[Outro (Fade out)]"). Nothing else: a bracketed backing vocal that merely
// opens with a section word ("[Break my heart]", Codex R1) is a lyric. A parenthesised count
// ("(x2)") is a count, not a note.
const NOTE = `\\((?!\\s*(?:\\d{1,2}[x×]|[x×]\\s*\\d{1,2}|\\??[x×])\\s*\\))[^)]*\\)`;
const BRACKET_RE = new RegExp(`^\\[\\s*(${CORE}(?:\\s*${NOTE})?)\\s*(?:${COUNT})?\\s*:?\\s*\\]$`, 'i');

/** Recognize one line of text. Pure; exported for the tests and the proposer. */
export function parseHeaderLine(text: string): Pick<SectionHeader, 'label' | 'count'> | null {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  // A bare header must start with a capital. A lyric's last word wrapped onto a line of
  // its own ("…shake it / out", "…take a / break") is otherwise a perfect bare header:
  // measured on the 342 live lyric sheets, all 3 lowercase hits were wrapped lyrics and all
  // 2,408 real headers were capitalised. Brackets are a deliberate tag; no rule needed.
  const bare = /^[A-Z]/.test(line) ? BARE_RE.exec(line) : null;
  const m = bare ?? BRACKET_RE.exec(line);
  if (!m) return null;
  const label = m[1].replace(/\s*:\s*$/, '').trim();
  const bars = m[2] !== undefined ? Number(m[2]) : null;
  const plays = m[3] !== undefined ? Number(m[3]) : null;
  const count = bars !== null && bars > 0 ? { bars } : plays !== null && plays > 0 ? { plays } : null;
  return { label, count };
}

interface Line {
  text: string;
  size: number; // tallest glyph height in the line, user space
  x: number; // user space, left of first item
  xEnd: number; // user space, right of last item
  base: number; // user space (PDF y-up), baseline
  top: number; // user space (PDF y-up), top of the tallest glyph
}

function fontHeight(it: HeaderTextItem): number {
  if (typeof it.height === 'number' && it.height > 0) return it.height;
  const [, , c, d] = it.transform;
  return Math.hypot(c, d) || 1;
}

// Group items into lines by baseline. Runs of one printed line share a baseline to within
// a fraction of a point; a two-column sheet puts a header and the OTHER column's lyric a
// couple of points apart (measured: 2.25pt and 2.7pt on live sheets, the second with only
// a 34pt gutter, too narrow for the gutter split below). So: within BASELINE_EMS of the
// smaller glyph height.
// Wider than any run of spaces between chords on one line; narrower than a column gutter.
const COLUMN_GAP_EMS = 6;
const BASELINE_EMS = 0.15;

function linesOf(items: HeaderTextItem[], gutterX: number | null): Line[] {
  const runs = items
    .filter((it) => typeof it.str === 'string' && it.str.trim() !== '' && it.transform?.length >= 6)
    .map((it) => ({ it, x: it.transform[4], base: it.transform[5], h: fontHeight(it) }))
    .sort((a, b) => b.base - a.base || a.x - b.x);

  const groups: (typeof runs)[] = [];
  for (const r of runs) {
    const g = groups.find((grp) => Math.abs(grp[0].base - r.base) <= BASELINE_EMS * Math.min(grp[0].h, r.h));
    if (g) g.push(r);
    else groups.push([r]);
  }

  // Split each baseline group at column gutters. A two-column sheet prints a left-column
  // header on the same baseline as a right-column lyric (measured on the live library:
  // "VERSE 1" at x=36 beside "Like thoughts inside a dream" at x=320), and joining them
  // made the header unreadable. A gutter is a horizontal gap of more than
  // COLUMN_GAP_EMS glyph heights — far wider than the spaces between chords on a line.
  const segments: (typeof runs)[] = [];
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x);
    let cur: typeof runs = [];
    let prevEnd: number | null = null;
    for (const r of g) {
      // A detected page gutter is a hard split, however narrow the gap on this line (a
      // header on exactly a lyric's baseline across a tight gutter); the em gap is the
      // fallback for pages where no gutter was detected.
      const crossesGutter = gutterX !== null && cur.length > 0 && cur[0].x < gutterX && r.x >= gutterX;
      if (cur.length && (crossesGutter || (prevEnd !== null && r.x - prevEnd > COLUMN_GAP_EMS * r.h))) {
        segments.push(cur);
        cur = [];
      }
      cur.push(r);
      const end = typeof r.it.width === 'number' ? r.x + r.it.width : r.x;
      prevEnd = prevEnd === null ? end : Math.max(prevEnd, end);
    }
    if (cur.length) segments.push(cur);
  }

  return segments.map((g) => {
    let text = '';
    let prevEnd: number | null = null;
    for (const r of g) {
      // A visible gap becomes a space; adjacent runs (one word split into several items)
      // join directly. Without a width we cannot tell, so a space is the safe default —
      // the grammar collapses whitespace anyway.
      const gap = prevEnd === null ? 0 : r.x - prevEnd;
      if (text !== '' && (prevEnd === null || gap > 0.15 * r.h) && !text.endsWith(' ')) text += ' ';
      text += r.it.str;
      prevEnd = typeof r.it.width === 'number' ? r.x + r.it.width : null;
    }
    return {
      text,
      x: Math.min(...g.map((r) => r.x)),
      xEnd: Math.max(...g.map((r) => r.x + (typeof r.it.width === 'number' ? r.it.width : 0))),
      base: Math.min(...g.map((r) => r.base)),
      top: Math.max(...g.map((r) => r.base + r.h)),
      size: Math.max(...g.map((r) => r.h)),
    };
  });
}

const TITLE_SIZE_RATIO = 1.5;

function medianSize(lines: Line[]): number {
  if (lines.length === 0) return Infinity;
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A user-space box → its rendered box, normalized 0..1 (top-left origin), any rotation. */
function toRendered(
  vp: HeaderPage['viewport'],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { left: number; top: number; right: number; bottom: number } {
  const [a, b, c, d, e, f] = vp.transform;
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [
    (a * x + c * y + e) / vp.width,
    (b * x + d * y + f) / vp.height,
  ]);
  return {
    left: Math.min(...pts.map((p) => p[0])),
    right: Math.max(...pts.map((p) => p[0])),
    top: Math.min(...pts.map((p) => p[1])),
    bottom: Math.max(...pts.map((p) => p[1])),
  };
}

// The page box in user space, recovered from the viewport (its inverse maps the rendered
// rectangle back onto the box). Reading order and columns are judged HERE — in the frame the
// author laid the text out in — so a /Rotate changes where marks are drawn, never the order
// the sections are read in.
function userBox(vp: HeaderPage['viewport']): { x0: number; y0: number; w: number; h: number } | null {
  const [a, b, c, d, e, f] = vp.transform;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = ([X, Y]: number[]) => [(d * (X - e) - c * (Y - f)) / det, (-b * (X - e) + a * (Y - f)) / det];
  const pts = [[0, 0], [vp.width, 0], [0, vp.height], [vp.width, vp.height]].map(inv);
  const x0 = Math.min(...pts.map((q) => q[0]));
  const y0 = Math.min(...pts.map((q) => q[1]));
  const w = Math.max(...pts.map((q) => q[0])) - x0;
  const h = Math.max(...pts.map((q) => q[1])) - y0;
  return w > 0 && h > 0 ? { x0, y0, w, h } : null;
}

// Column detection (Graham, 2026-10-27: "if we can reliably detect and parse two columns, we
// should"). Two columns keep a song to one legible phone page; the FORM still reads left
// column top→bottom, then right — and the order headers come out in is the order the proposer
// builds a roadmap from and the order Mark sections writes. Measured: 339 of 347 live lyric
// pages are two-column with a clean empty gutter (right column at ~0.52); 102 of 106 notation
// pages are not.
//
// A gutter is a vertical strip in the middle half of the page, at least GUTTER_MIN wide, that
// no text run crosses, with at least GUTTER_MIN_LINES runs wholly on each side. The top
// TITLE_BAND is ignored: a long artist line under the title can span both columns.
const GUTTER_MIN = 0.03;
const GUTTER_MIN_LINES = 5;
const TITLE_BAND = 0.1;

interface Span {
  left: number; // 0..1, user space, left→right
  right: number;
  top: number; // 0..1, user space, top→bottom
}

function columnGutter(spans: Span[]): number | null {
  const body = spans.filter((s) => s.top >= TITLE_BAND);
  let best: { from: number; to: number } | null = null;
  let run: { from: number; to: number } | null = null;
  for (let g = 0.25; g <= 0.75 + 1e-9; g += 0.005) {
    const clear =
      !body.some((s) => s.left < g && s.right > g) &&
      body.filter((s) => s.right <= g).length >= GUTTER_MIN_LINES &&
      body.filter((s) => s.left >= g).length >= GUTTER_MIN_LINES;
    if (clear) {
      run = run ? { from: run.from, to: g } : { from: g, to: g };
      if (!best || run.to - run.from > best.to - best.from) best = { ...run };
    } else {
      run = null;
    }
  }
  return best && best.to - best.from >= GUTTER_MIN ? (best.from + best.to) / 2 : null;
}

/**
 * Every header on every page, in READING order: page, then column (left before right, on a
 * page with a detected gutter), then top→bottom, then left→right — all judged in the page's
 * own layout. Positions are where the header is DRAWN (through the viewport).
 */
export function findSectionHeaders(pages: HeaderPage[]): SectionHeader[] {
  const out: (SectionHeader & { column: number; readTop: number; readLeft: number })[] = [];
  for (const p of pages) {
    const vp = p.viewport;
    if (!(vp && vp.width > 0 && vp.height > 0 && vp.transform?.length === 6)) continue;
    const ub = userBox(vp);
    if (!ub) continue;
    // The gutter is judged on the raw text runs (pdf.js never emits a run across a column
    // gutter), then lines are split at it.
    const norm = (x: number) => (x - ub.x0) / ub.w;
    const normTop = (y: number) => (ub.y0 + ub.h - y) / ub.h;
    const gutter = columnGutter(
      p.items
        .filter((it) => typeof it.str === 'string' && it.str.trim() !== '' && it.transform?.length >= 6)
        .map((it) => ({
          left: norm(it.transform[4]),
          right: norm(it.transform[4] + (typeof it.width === 'number' ? it.width : 0)),
          top: normTop(it.transform[5] + fontHeight(it)),
        })),
    );
    const lines = linesOf(p.items, gutter === null ? null : ub.x0 + gutter * ub.w);
    const body = medianSize(lines);
    const spans: Span[] = lines.map((l) => ({ left: norm(l.x), right: norm(Math.max(l.xEnd, l.x)), top: normTop(l.top) }));
    lines.forEach((line, i) => {
      // A title is never a header. Measured on the live library: Tom Petty's "Breakdown"
      // prints its title at 21pt over 11.5pt headers and 14pt lyrics, and was read as a
      // section. Headers print at or below body size; titles well above it.
      if (line.size >= TITLE_SIZE_RATIO * body) return;
      const parsed = parseHeaderLine(line.text);
      if (!parsed) return;
      const drawn = toRendered(vp, line.x, line.base, Math.max(line.xEnd, line.x), line.top);
      out.push({
        page: p.page,
        x: clamp01(drawn.left),
        y: clamp01(drawn.top),
        ...parsed,
        column: gutter !== null && spans[i].left >= gutter ? 1 : 0,
        readTop: spans[i].top,
        readLeft: spans[i].left,
      });
    });
  }
  return out
    .sort((a, b) => a.page - b.page || a.column - b.column || a.readTop - b.readTop || a.readLeft - b.readLeft)
    .map((h): SectionHeader => ({ page: h.page, x: h.x, y: h.y, label: h.label, count: h.count }));
}

/**
 * The minimum the Perform strip offers on (§4.1 step 3): one header is a title or a stray
 * word as often as it is a form; two is a chart with a structure.
 */
export const MIN_HEADERS_TO_OFFER = 2;

// ── The write: POST /api/charts/sections ─────────────────────────────────────

/** Most headers a sheet plausibly carries; past this it is not a form, it is noise. */
export const MAX_SECTION_HEADERS = 200;
export const MAX_HEADER_LABEL = 80;

/** What the client posts: the headers it read, positions only (the server assigns ids). */
export interface SectionsRequest {
  chart_id: string;
  source_hash: string;
  sections: { page: number; x: number; y: number; label: string }[];
}

// 'exists' is NOT a failure: a row for these bytes already exists (another tab, an
// overlay build, an owner's own calibration), and the hash-addressed GET is the one
// authority on whether it describes the bytes on screen — same rule as
// `buildOverlayStep`. 'authored' is the builder chart, born verified already.
export type SectionsReason = 'exists' | 'authored' | 'unsupported_type' | 'failed';

export interface SectionsResult {
  generated: boolean;
  reason?: SectionsReason;
}

/**
 * Validate the posted headers and turn them into `SectionAnchor`s with server-assigned
 * ids, or null if any is malformed. All-or-nothing: a partly-valid read is a read the
 * owner never saw, and writing the valid half would silently drop sections.
 */
export function toSectionAnchors(raw: unknown): SectionAnchor[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < MIN_HEADERS_TO_OFFER || raw.length > MAX_SECTION_HEADERS) return null;
  const out: SectionAnchor[] = [];
  for (const [i, r] of raw.entries()) {
    if (!r || typeof r !== 'object') return null;
    const { page, x, y, label } = r as Record<string, unknown>;
    if (typeof label !== 'string') return null;
    const anchor = { id: `h${i + 1}`, page, x, y, label: label.trim() };
    // A blank label could never verify (`canVerify`), so it is a malformed read, not a
    // draft to fix later. The length cap is this route's own: a header is a few words.
    if (anchor.label === '' || anchor.label.length > MAX_HEADER_LABEL) return null;
    if (!isValidSectionAnchor(anchor)) return null;
    out.push(anchor);
  }
  return out;
}
