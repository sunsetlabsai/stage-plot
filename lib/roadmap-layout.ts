// ── Roadmap Builder — the shared, pdf-lib-free layout core ────────────────────
// The ONE place section→systems→bars geometry is computed. BOTH the PDF drawer
// (lib/roadmap-render.ts) and the React builder preview consume this, so the two
// can never lay bars out differently — the "no-drift" guarantee (design §3): one
// algorithm, each surface passing its own `barsPerLine` + target width.
//
// CRITICAL: this module imports NO pdf-lib. roadmap-render imports pdf-lib at top
// level and is server-only; the client preview imports THIS module, so it never
// transitively pulls pdf-lib into the browser bundle. Keep it that way.
//
// Coordinate model: every geometry value is normalized 0..1 within its page
// (top→bottom for y, left→right for x). The PDF draw denormalizes to points; the
// preview consumes the GROUPING decisions (which bars on which line) and the
// constant-width rule, computing its own pixel geometry from its container width.

import type { SectionAnchor } from './types';
import type { RoadmapSpec, RoadmapSection } from './roadmap-spec';

// ── Layout constants (the ONE shared grid; PDF + calibration both read these) ──
// Points (1/72"). US Letter portrait. A "system" is one chart line of up to
// barsPerLine bars; each section starts a fresh system (matches SectionAnchor at
// a section head). Change these and BOTH the PDF and the calibration move together.
export const PAGE_W = 612;            // 8.5"
export const PAGE_H = 792;            // 11"
export const MARGIN_X = 48;
export const MARGIN_TOP = 96;         // room for the title/key header
export const MARGIN_BOTTOM = 48;
export const SYSTEM_LABEL_H = 16;     // section label strip above the bar row of its first system
export const SYSTEM_BARS_H = 48;      // the bar row height
export const SYSTEM_GAP = 18;         // vertical gap between systems

// ── Glyph geometry the PDF draws above a bar row (points; roadmap-render reads these) ──
export const LABEL_BASELINE = 12;     // section label baseline below the label strip top (11 pt bold)
export const LABEL_SIZE = 11;
export const NOTE_SIZE = 9;           // the direction line
export const DIRECTIVE_SIZE = 9;      // Segno / Coda / To Coda / Fine / D.C. / D.S.
export const DIRECTIVE_BASELINE = 8;  // a directive's row-0 baseline above the bar row
export const CODA_CY = 12;            // coda sign centre above the bar row
export const CODA_R = 5;              // its circle radius; the cross arms reach CODA_R + CODA_ARM
export const CODA_ARM = 2;
export const VOLTA_Y = 10;            // an ending bracket's top rule above the bar row

// Helvetica's font bounding boxes (AFM FontBBox, per 1000 em): the worst case for
// ANY glyph, accented capitals and descenders included — so the clearances below
// hold whatever letters a label or direction uses.
const HELV_TOP = 0.931;
const HELV_BOTTOM = 0.225;
const HELV_BOLD_BOTTOM = 0.228;
const STROKE = 0.5;                   // half a 1 pt line
const CLEAR = 1;                      // air between two glyph boxes

// The direction line sits under the label, clear of the label's lowest descender.
export const NOTE_BASELINE = Math.ceil(LABEL_BASELINE + HELV_BOLD_BOTTOM * LABEL_SIZE + CLEAR + HELV_TOP * NOTE_SIZE); // 24

// How far above the bar row the PDF's directive band reaches on a system whose
// deepest stack is `depth` rows (directiveRows): the coda sign's arm, an ending
// bracket, or the top row's text — whichever is highest.
export function directiveBandTop(depth: number): number {
  const coda = CODA_CY + CODA_R + CODA_ARM + STROKE;
  const volta = VOLTA_Y + STROKE;
  const text = depth > 0 ? DIRECTIVE_BASELINE + (depth - 1) * DIRECTIVE_ROW_DY + HELV_TOP * DIRECTIVE_SIZE : 0;
  return Math.max(coda, volta, text);
}

// A noted/open section's first label strip: label, direction line, then the whole
// directive band below it, so a full-width direction never meets a directive.
// Charts with no direction keep SYSTEM_LABEL_H exactly.
export function noteStripH(depth: number): number {
  const noteBottom = NOTE_BASELINE + HELV_BOTTOM * NOTE_SIZE;
  return Math.ceil(noteBottom + CLEAR + directiveBandTop(depth));
}
export const DEFAULT_BARS_PER_LINE = 4;

export const CONTENT_W = PAGE_W - 2 * MARGIN_X;
export const SYSTEM_TOTAL_H = SYSTEM_LABEL_H + SYSTEM_BARS_H;

// ── Directive rows (the one stacking rule; the PDF and the layout both read it) ──
// The PDF prints text directives above a bar's start or end edge (ending label,
// Segno, Coda; ×N count, To Coda, Fine, D.C./D.S.). Co-located ones stack in rows
// DIRECTIVE_ROW_DY apart so they never overprint each other. Row order is the
// claim order below. The renderer reads its lift from here, and the layout uses
// the same rows to clear a direction line above the deepest stack — so the two
// can't disagree about how tall a stack is.
export const DIRECTIVE_ROW_DY = 10;
export type DirectiveKind = 'repeatTimes' | 'ending' | 'segno' | 'coda' | 'toCoda' | 'fine' | 'jump';
export type DirectiveEdge = 'start' | 'end';
export type DirectiveRows = Map<string, DirectiveKind[]>;

const rowKey = (section: number, bar: number, edge: DirectiveEdge) => `${section}:${bar}:${edge}`;

export function directiveRows(spec: RoadmapSpec): DirectiveRows {
  const rows: DirectiveRows = new Map();
  const claim = (section: number, bar: number, edge: DirectiveEdge, kind: DirectiveKind) => {
    const sec = spec.sections[section];
    if (!sec || bar < 1 || bar > sec.bars) return; // an unresolvable ref draws nothing
    const k = rowKey(section, bar, edge);
    rows.set(k, [...(rows.get(k) ?? []), kind]);
  };
  // Section repeats first (the renderer's section pass precedes nav).
  spec.sections.forEach((sec, si) => {
    const r = sec.repeat;
    if (!r) return;
    if (r.kind === 'plain') {
      if (r.times > 2) claim(si, sec.bars, 'end', 'repeatTimes'); // ×2 prints no count
    } else {
      for (const e of r.endings) if (e.bars.count > 0) claim(si, e.bars.start, 'start', 'ending');
    }
  });
  const nav = spec.navigation;
  if (nav?.segno) claim(nav.segno.section, nav.segno.bar, 'start', 'segno');
  if (nav?.coda) claim(nav.coda.section, nav.coda.bar, 'start', 'coda');
  if (nav?.toCoda) claim(nav.toCoda.section, nav.toCoda.bar, 'end', 'toCoda');
  if (nav?.fine) claim(nav.fine.section, nav.fine.bar, 'end', 'fine');
  if (nav?.jump) claim(nav.jump.at.section, nav.jump.at.bar, 'end', 'jump');
  return rows;
}

// The lift (points) for one directive: its row × DIRECTIVE_ROW_DY.
export function directiveDy(rows: DirectiveRows, kind: DirectiveKind, section: number, bar: number, edge: DirectiveEdge): number {
  const i = (rows.get(rowKey(section, bar, edge)) ?? []).indexOf(kind);
  return Math.max(0, i) * DIRECTIVE_ROW_DY;
}

// The deepest stack over bars [from..to] of a section (0 = no directives).
function deepestStack(rows: DirectiveRows, section: number, from: number, to: number): number {
  let n = 0;
  for (let bar = from; bar <= to; bar += 1) {
    for (const edge of ['start', 'end'] as const) n = Math.max(n, rows.get(rowKey(section, bar, edge))?.length ?? 0);
  }
  return n;
}

// The text of a section's direction line, or null when it has none: `OPEN · until
// keys signal`, `until keys signal`, or `OPEN`. One source for the PDF and the
// preview. Fits by NOTE_MAX alone (docs/design-song-form-from-lyrics.md §2.4.4).
export function noteLineText(section: Pick<RoadmapSection, 'note' | 'open'>): string | null {
  if (section.open) return section.note ? `OPEN · ${section.note}` : 'OPEN';
  return section.note ?? null;
}

// ── Responsive bars/line — the musical set {2,4,8} (design §4.2) ──────────────
// On-SCREEN preview picks bars/line from a musical set, never an arbitrary "cram
// N to width": 2 phone-portrait, 4 narrow, 8 wide. The PDF is fixed (its own
// barsPerLine); this picker is for the responsive preview. Breakpoints are the
// §5 spike's confirmed hypothesis — named so the spike can adjust them in one place.
export const BARS_PER_LINE_BREAKPOINTS = { phone: 480, wide: 700 } as const;

export function pickBarsPerLine(containerWidthPx: number): 2 | 4 | 8 {
  if (containerWidthPx < BARS_PER_LINE_BREAKPOINTS.phone) return 2;
  if (containerWidthPx < BARS_PER_LINE_BREAKPOINTS.wide) return 4;
  return 8;
}

// Resolve the effective bars/line. Q1 (design §6) is enforced HERE, not by the
// caller: an explicit `spec.barsPerLine` always wins. `override` is purely the
// responsive preview pick and is consulted ONLY when the spec leaves barsPerLine
// unset. Falls back to the default when neither is a positive integer.
function resolveBarsPerLine(spec: RoadmapSpec, override?: number): number {
  const explicit = spec.barsPerLine && spec.barsPerLine > 0 ? spec.barsPerLine : undefined;
  const responsive = override && override > 0 ? override : undefined;
  return explicit ?? responsive ?? DEFAULT_BARS_PER_LINE;
}

// The grouping decision the React preview consumes (design §4.3): split a
// section's bars into lines of `perLine`. Same ceil(N/perLine) / last-line-size
// rule layoutRoadmap applies, so preview wrapping can't drift from the PDF's.
// (The preview then renders each line as a constant-width grid; it does NOT reuse
// the PDF's absolute point coordinates.)
export function chunkIntoLines<T>(items: T[], perLine: number): T[][] {
  const n = perLine >= 1 ? Math.floor(perLine) : 1;
  const lines: T[][] = [];
  for (let i = 0; i < items.length; i += n) lines.push(items.slice(i, i + n));
  return lines;
}

// ── The one line-start numbering rule (design §3.3 item 1) ────────────────────
// A resolved line's measure number is the `absNumber` of its FIRST bar — full
// stop. Both surfaces call this over their OWN resolved lines (LaidSystem[] for
// the PDF, the preview's chunked lines), so a given bar carries one number
// everywhere even when the two surfaces wrap at different bars — and therefore
// show DIFFERENT sets of line-start numbers. That divergence is by design (§3.3
// item 2), NOT drift: the *rule* is single-sourced here, the visible wrap is not.
// Reading `absNumber` off each real line's first bar is what keeps the rule one.
// An empty line is never numbered (null).
export function lineStartNumbers(
  lines: ReadonlyArray<ReadonlyArray<{ absNumber: number }>>,
): (number | null)[] {
  return lines.map((line) => (line.length > 0 ? line[0].absNumber : null));
}

// ── Layout result (the shared substrate both projections read) ────────────────
// Every geometry value here is already normalized 0..1 within its page, so the
// calibration is a near-direct copy and the PDF draw is a single denormalize.

export interface LaidBar {
  id: string;
  systemId: string;
  page: number;          // 1-based
  xStart: number;        // normalized
  xEnd: number;          // normalized
  yTop: number;          // normalized (band top — mirrors the system)
  yBottom: number;       // normalized
  absNumber: number;     // 1-based, reading order
  sectionId: string;
  sectionIndex: number;  // 0-based index into spec.sections
  barInSection: number;  // 1-based position within the section
  section: RoadmapSection;
}

export interface LaidSystem {
  id: string;
  page: number;
  yTop: number;          // normalized (top of the bar row)
  yBottom: number;       // normalized
  xStart: number;        // normalized
  xEnd: number;          // normalized (tracks the LAST REAL bar — partial lines do NOT stretch)
  labelYTop: number;     // normalized top of the label strip (first system of a section only)
  label: string | null;  // section label on the section's first system; null otherwise
  noteLine: string | null; // direction line under the label (first system of a noted/open section); null otherwise
  barsThisLine: number;  // grouping decision the preview reads (for partial-line logic)
  bars: LaidBar[];
}

export interface RoadmapLayout {
  pageCount: number;
  systems: LaidSystem[];
  sections: SectionAnchor[];
  bars: LaidBar[];
}

export interface LayoutOptions {
  // The responsive preview pick. An explicit spec.barsPerLine still wins (Q1,
  // enforced in resolveBarsPerLine); this is consulted only when the spec leaves
  // barsPerLine unset. The PDF path passes nothing and falls through to spec/default.
  barsPerLine?: number;
}

// ── Stage 1: layout (pure, deterministic, the testable backbone) ──────────────
// Flows sections → systems (barsPerLine bars each, new system per section) →
// bars (CONSTANT width within a system, design §4.1 / Bug B), stacking systems
// down the page and spilling to a new page when the next system would cross
// MARGIN_BOTTOM. All coords normalized. Reading order = page → system
// (top→bottom) → bar (left→right).
export function layoutRoadmap(spec: RoadmapSpec, opts: LayoutOptions = {}): RoadmapLayout {
  const barsPerLine = resolveBarsPerLine(spec, opts.barsPerLine);

  const systems: LaidSystem[] = [];
  const allBars: LaidBar[] = [];
  const sections: SectionAnchor[] = [];

  let page = 1;
  let cursorY = MARGIN_TOP;                         // points from page top
  let absNumber = 1;
  const rows = directiveRows(spec);

  spec.sections.forEach((section, sectionIndex) => {
    const sectionAnchorId = `sec-${sectionIndex}`;
    const lineCount = Math.ceil(section.bars / barsPerLine);
    let barInSection = 1;
    let sectionAnchorEmitted = false;

    for (let line = 0; line < lineCount; line += 1) {
      const isFirstSystemOfSection = line === 0;
      const barsThisLine = Math.min(barsPerLine, section.bars - line * barsPerLine);
      // A noted/open section's first system gets the taller strip (noteStripH),
      // sized by the deepest directive stack on that system; every other system
      // keeps today's geometry exactly.
      const noteLine = isFirstSystemOfSection ? noteLineText(section) : null;
      const stack = noteLine ? deepestStack(rows, sectionIndex, barInSection, barInSection + barsThisLine - 1) : 0;
      const labelH = noteLine ? noteStripH(stack) : SYSTEM_LABEL_H;

      // Page break if this system (incl. its label strip) would overrun.
      if (cursorY + labelH + SYSTEM_BARS_H > PAGE_H - MARGIN_BOTTOM) {
        page += 1;
        cursorY = MARGIN_TOP;
      }

      const labelTopPt = cursorY;
      const barsTopPt = cursorY + labelH;
      const barsBottomPt = barsTopPt + SYSTEM_BARS_H;

      const systemId = `sys-${sectionIndex}-${line}`;
      // Bug B fix (design §4.1): cell width is CONSTANT = CONTENT_W / barsPerLine,
      // independent of barsThisLine. A partial last line keeps that width and is
      // left-aligned; it does NOT stretch to fill the content box. (A FULL line is
      // byte-identical to the old CONTENT_W / barsThisLine, so existing full-width
      // charts render unchanged.)
      const cellW = CONTENT_W / barsPerLine;
      const systemRightPt = MARGIN_X + barsThisLine * cellW; // tracks the last real bar

      const laidBars: LaidBar[] = [];
      for (let b = 0; b < barsThisLine; b += 1) {
        const xStartPt = MARGIN_X + b * cellW;
        const xEndPt = xStartPt + cellW;
        const bar: LaidBar = {
          id: `bar-${sectionIndex}-${barInSection}`,
          systemId,
          page,
          xStart: xStartPt / PAGE_W,
          xEnd: xEndPt / PAGE_W,
          yTop: barsTopPt / PAGE_H,
          yBottom: barsBottomPt / PAGE_H,
          absNumber,
          sectionId: sectionAnchorId,
          sectionIndex,
          barInSection,
          section,
        };
        laidBars.push(bar);
        allBars.push(bar);
        absNumber += 1;
        barInSection += 1;
      }

      systems.push({
        id: systemId,
        page,
        yTop: barsTopPt / PAGE_H,
        yBottom: barsBottomPt / PAGE_H,
        xStart: MARGIN_X / PAGE_W,
        xEnd: systemRightPt / PAGE_W, // partial lines stop at the last real bar
        labelYTop: labelTopPt / PAGE_H,
        label: isFirstSystemOfSection ? section.label : null,
        noteLine,
        barsThisLine,
        bars: laidBars,
      });

      if (isFirstSystemOfSection && !sectionAnchorEmitted) {
        sections.push({
          id: sectionAnchorId,
          page,
          x: MARGIN_X / PAGE_W,
          y: labelTopPt / PAGE_H,
          label: section.label,
        });
        sectionAnchorEmitted = true;
      }

      cursorY = barsBottomPt + SYSTEM_GAP;
    }
  });

  return { pageCount: page, systems, sections, bars: allBars };
}
