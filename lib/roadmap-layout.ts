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
export const DEFAULT_BARS_PER_LINE = 4;

export const CONTENT_W = PAGE_W - 2 * MARGIN_X;
export const SYSTEM_TOTAL_H = SYSTEM_LABEL_H + SYSTEM_BARS_H;

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

  spec.sections.forEach((section, sectionIndex) => {
    const sectionAnchorId = `sec-${sectionIndex}`;
    const lineCount = Math.ceil(section.bars / barsPerLine);
    let barInSection = 1;
    let sectionAnchorEmitted = false;

    for (let line = 0; line < lineCount; line += 1) {
      // Page break if this system (incl. its label strip) would overrun.
      if (cursorY + SYSTEM_TOTAL_H > PAGE_H - MARGIN_BOTTOM) {
        page += 1;
        cursorY = MARGIN_TOP;
      }

      const isFirstSystemOfSection = line === 0;
      const labelTopPt = cursorY;
      const barsTopPt = cursorY + SYSTEM_LABEL_H;
      const barsBottomPt = barsTopPt + SYSTEM_BARS_H;

      const systemId = `sys-${sectionIndex}-${line}`;
      const barsThisLine = Math.min(barsPerLine, section.bars - line * barsPerLine);
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
