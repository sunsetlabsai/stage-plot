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

/** One page's text, with the page box (pdf.js `page.view`). */
export interface HeaderPage {
  page: number; // 1-based
  view: [number, number, number, number]; // [x0, y0, x1, y1]
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
// Label = section word + optional ordinal number ("Verse 2"). Count = `8x` (bars) or
// `x2` (plays), optionally parenthesised. ×  is accepted for x.
const LABEL = `(${WORD}(?:\\s+\\d{1,2})?)`;
const COUNT = `\\(?\\s*(?:(\\d{1,2})\\s*[x×]|[x×]\\s*(\\d{1,2}))\\s*\\)?`;
const BARE_RE = new RegExp(`^${LABEL}\\s*:?\\s*(?:${COUNT})?\\s*:?$`, 'i');
// Bracketed: the content must OPEN with a section word; trailing words are part of the
// label as printed ("[Outro (Fade out)]"). A bracketed lyric aside ("[Spoken]") is not one.
const BRACKET_RE = new RegExp(`^\\[\\s*(${WORD}\\b[^\\]]*?)\\s*(?:${COUNT})?\\s*:?\\s*\\]$`, 'i');

/** Recognize one line of text. Pure; exported for the tests and the proposer. */
export function parseHeaderLine(text: string): Pick<SectionHeader, 'label' | 'count'> | null {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  const m = BARE_RE.exec(line) ?? BRACKET_RE.exec(line);
  if (!m) return null;
  const label = m[1].replace(/\s*:\s*$/, '').trim();
  const bars = m[2] !== undefined ? Number(m[2]) : null;
  const plays = m[3] !== undefined ? Number(m[3]) : null;
  const count = bars !== null && bars > 0 ? { bars } : plays !== null && plays > 0 ? { plays } : null;
  return { label, count };
}

interface Line {
  text: string;
  x: number; // user space, left of first item
  top: number; // user space (PDF y-up), top of the tallest glyph
}

function fontHeight(it: HeaderTextItem): number {
  if (typeof it.height === 'number' && it.height > 0) return it.height;
  const [, , c, d] = it.transform;
  return Math.hypot(c, d) || 1;
}

// Group items into lines by baseline. Two items share a line when their baselines sit
// within half a glyph height — tight enough that a lyric line and the chord line printed
// just above it stay separate (they are a full line apart), loose enough to absorb the
// sub-point jitter between runs of one line.
function linesOf(items: HeaderTextItem[]): Line[] {
  const runs = items
    .filter((it) => typeof it.str === 'string' && it.str.trim() !== '' && it.transform?.length >= 6)
    .map((it) => ({ it, x: it.transform[4], base: it.transform[5], h: fontHeight(it) }))
    .sort((a, b) => b.base - a.base || a.x - b.x);

  const groups: (typeof runs)[] = [];
  for (const r of runs) {
    const g = groups.find((grp) => Math.abs(grp[0].base - r.base) <= 0.5 * Math.max(grp[0].h, r.h));
    if (g) g.push(r);
    else groups.push([r]);
  }

  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
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
      top: Math.max(...g.map((r) => r.base + r.h)),
    };
  });
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Every header on every page, in reading order (page, then top→bottom, then left→right). */
export function findSectionHeaders(pages: HeaderPage[]): SectionHeader[] {
  const out: SectionHeader[] = [];
  for (const p of pages) {
    const [x0, y0, x1, y1] = p.view;
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0 && h > 0)) continue;
    for (const line of linesOf(p.items)) {
      const parsed = parseHeaderLine(line.text);
      if (!parsed) continue;
      out.push({
        page: p.page,
        x: clamp01((line.x - x0) / w),
        y: clamp01((y1 - line.top) / h),
        ...parsed,
      });
    }
  }
  return out.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
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
