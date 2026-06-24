// ── Roadmap Builder — chunk 1: the deterministic renderer ─────────────────────
// RoadmapSpec (the validated source of truth) → { pdfBytes, ChartCalibration }.
//
// This is the inverse of the converter: instead of recovering structure from an
// opaque PDF via vision, we OWN the structure and emit BOTH the PDF substrate and
// a born-`verified` ChartCalibration from a SINGLE deterministic layout pass. The
// PDF and the calibration are projected from the same `RoadmapLayout`, so they can
// never drift — the spec↔calibration parity the save route asserts (design NB1) is
// structural here, not hoped-for.
//
// Determinism is load-bearing: same spec → byte-identical PDF → stable source_hash
// → idempotent re-render/replace. So layout uses fixed constants (below) and an
// embedded, bundled font (TODO: bundle a font file; StandardFonts for the scaffold).
//
// Coordinate model: ChartCalibration coords are normalized 0..1 within a page
// (top→bottom for y, left→right for x), matching System/Bar/SectionAnchor. The
// layout computes normalized coords directly; the PDF draw projects normalized →
// PDF points (PDF y is bottom-up, so y_pt = PAGE_H * (1 - y_norm)).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { CALIBRATION_SCHEMA_VERSION } from './chart-calibration';
import type {
  Bar,
  ChartCalibration,
  RoadmapMarker,
  SectionAnchor,
  System,
} from './types';
import type { BarRef, RoadmapSpec, RoadmapSection } from './roadmap-spec';

// ── Layout constants (the ONE shared grid; PDF + calibration both read these) ──
// Points (1/72"). US Letter portrait. A "system" is one chart line of up to
// barsPerLine bars; each section starts a fresh system (matches SectionAnchor at
// a section head). Change these and BOTH the PDF and the calibration move together.
const PAGE_W = 612;            // 8.5"
const PAGE_H = 792;            // 11"
const MARGIN_X = 48;
const MARGIN_TOP = 96;         // room for the title/key header
const MARGIN_BOTTOM = 48;
const SYSTEM_LABEL_H = 16;     // section label strip above the bar row of its first system
const SYSTEM_BARS_H = 48;      // the bar row height
const SYSTEM_GAP = 18;         // vertical gap between systems
const DEFAULT_BARS_PER_LINE = 4;

const CONTENT_W = PAGE_W - 2 * MARGIN_X;
const SYSTEM_TOTAL_H = SYSTEM_LABEL_H + SYSTEM_BARS_H;

// ── Layout result (the shared substrate both projections read) ────────────────
// Every geometry value here is already normalized 0..1 within its page, so the
// calibration is a near-direct copy and the PDF draw is a single denormalize.

interface LaidBar {
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

interface LaidSystem {
  id: string;
  page: number;
  yTop: number;          // normalized (top of the bar row)
  yBottom: number;       // normalized
  xStart: number;        // normalized
  xEnd: number;          // normalized
  labelYTop: number;     // normalized top of the label strip (first system of a section only)
  label: string | null;  // section label on the section's first system; null otherwise
  bars: LaidBar[];
}

interface RoadmapLayout {
  pageCount: number;
  systems: LaidSystem[];
  sections: SectionAnchor[];
  bars: LaidBar[];
}

export interface RenderResult {
  pdfBytes: Uint8Array;
  calibration: ChartCalibration;
}

// ── Public entry point ────────────────────────────────────────────────────────
// Assumes `spec` already passed validateRoadmapSpec — the renderer is a pure
// projection, not a second validator. Callers (save route) gate first.
export async function renderRoadmap(spec: RoadmapSpec): Promise<RenderResult> {
  const layout = layoutRoadmap(spec);
  const calibration = buildCalibration(spec, layout);
  const pdfBytes = await drawRoadmapPdf(spec, layout);
  return { pdfBytes, calibration };
}

// ── Stage 1: layout (pure, deterministic, the testable backbone) ──────────────
// Flows sections → systems (barsPerLine bars each, new system per section) →
// bars (equal-width within a system), stacking systems down the page and spilling
// to a new page when the next system would cross MARGIN_BOTTOM. All coords
// normalized. Reading order = page → system (top→bottom) → bar (left→right).
export function layoutRoadmap(spec: RoadmapSpec): RoadmapLayout {
  const barsPerLine = spec.barsPerLine && spec.barsPerLine > 0 ? spec.barsPerLine : DEFAULT_BARS_PER_LINE;

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
      const cellW = CONTENT_W / barsThisLine;

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
        xEnd: (PAGE_W - MARGIN_X) / PAGE_W,
        labelYTop: labelTopPt / PAGE_H,
        label: isFirstSystemOfSection ? section.label : null,
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

// ── Stage 2: calibration projection (layout → ChartCalibration) ───────────────
// Born `verified`: the geometry is exact by construction. Maps systems/bars/
// sections straight across, and projects spec repeats + navigation onto the
// existing RoadmapMarker vocabulary (so resolveRoadmap/Perform/conductor consume
// builder charts with zero new plumbing).
export function buildCalibration(spec: RoadmapSpec, layout: RoadmapLayout): ChartCalibration {
  const systems: System[] = layout.systems.map((s) => ({
    id: s.id,
    page: s.page,
    yTop: s.yTop,
    yBottom: s.yBottom,
    xStart: s.xStart,
    xEnd: s.xEnd,
  }));

  const bars: Bar[] = layout.bars.map((b) => ({
    id: b.id,
    systemId: b.systemId,
    xStart: b.xStart,
    xEnd: b.xEnd,
    absNumber: b.absNumber,
    sectionId: b.sectionId,
  }));

  const roadmap = buildMarkers(spec, layout);

  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    status: 'verified',
    sections: layout.sections,
    systems,
    bars,
    ...(roadmap.length > 0 ? { roadmap } : {}),
  };
}

// Project section repeats + global navigation onto RoadmapMarkers.
function buildMarkers(spec: RoadmapSpec, layout: RoadmapLayout): RoadmapMarker[] {
  const markers: RoadmapMarker[] = [];

  // A lookup from (sectionIndex, barInSection) → barId for BarRef resolution and
  // section-edge anchoring.
  const barAt = new Map<string, LaidBar>();
  for (const b of layout.bars) barAt.set(`${b.sectionIndex}:${b.barInSection}`, b);
  const refBarId = (ref: BarRef): string | null => barAt.get(`${ref.section}:${ref.bar}`)?.id ?? null;

  // Section-scoped repeats.
  spec.sections.forEach((section, sectionIndex) => {
    const repeat = section.repeat;
    if (!repeat) return;

    const firstBar = barAt.get(`${sectionIndex}:1`);
    const lastBar = barAt.get(`${sectionIndex}:${section.bars}`);
    if (!firstBar || !lastBar) return; // unreachable for a validated spec

    const repeatStartId = `mk-rs-${sectionIndex}`;
    markers.push({ id: repeatStartId, kind: 'repeatStart', barId: firstBar.id, edge: 'start' });

    if (repeat.kind === 'plain') {
      markers.push({
        id: `mk-re-${sectionIndex}`,
        kind: 'repeatEnd',
        barId: lastBar.id,
        edge: 'end',
        repeatStartId,
        times: repeat.times,
      });
    } else {
      repeat.endings.forEach((ending, ei) => {
        const barIds: string[] = [];
        for (let n = 0; n < ending.bars.count; n += 1) {
          const bb = barAt.get(`${sectionIndex}:${ending.bars.start + n}`);
          if (bb) barIds.push(bb.id);
        }
        markers.push({
          id: `mk-end-${sectionIndex}-${ei}`,
          kind: 'ending',
          repeatStartId,
          barIds,
          numbers: ending.passes,
        });
      });
    }
  });

  // Global navigation.
  const nav = spec.navigation;
  if (nav) {
    if (nav.segno) {
      const id = refBarId(nav.segno);
      if (id) markers.push({ id: 'mk-segno', kind: 'segno', barId: id, edge: 'start' });
    }
    if (nav.coda) {
      const id = refBarId(nav.coda);
      if (id) markers.push({ id: 'mk-coda', kind: 'coda', barId: id, edge: 'start' });
    }
    if (nav.toCoda) {
      const id = refBarId(nav.toCoda);
      if (id) markers.push({ id: 'mk-tocoda', kind: 'toCoda', barId: id, edge: 'end' });
    }
    if (nav.fine) {
      const id = refBarId(nav.fine);
      if (id) markers.push({ id: 'mk-fine', kind: 'fine', barId: id, edge: 'end' });
    }
    if (nav.jump) {
      const id = refBarId(nav.jump.at);
      if (id) {
        markers.push({
          id: 'mk-jump',
          kind: 'jump',
          barId: id,
          edge: 'end',
          from: nav.jump.from,
          until: nav.jump.until,
        });
      }
    }
  }

  return markers;
}

// ── Stage 3: PDF projection (layout → bytes) ──────────────────────────────────
// SCAFFOLD draw: page(s), a title/key header, section labels, system baselines,
// barlines, and per-bar Nashville chord text. Richer glyph fidelity is TODO and
// does NOT affect the calibration (structure is already exact above):
//   TODO: repeat |: :| brackets, volta 1./2. brackets, segno/coda/D.S./D.C./Fine
//         symbols, diamond (held) noteheads, split-bar beat subdivisions/dots.
//   TODO: bundle + embed a deterministic font (StandardFonts here is fine for the
//         scaffold but ties bytes to pdf-lib's bundled metrics).
async function drawRoadmapPdf(spec: RoadmapSpec, layout: RoadmapLayout): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Strip non-deterministic metadata so identical specs → identical bytes.
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pages: PDFPage[] = [];
  for (let p = 0; p < layout.pageCount; p += 1) {
    pages.push(doc.addPage([PAGE_W, PAGE_H]));
  }

  // Header (page 1): title placeholder + key. Title comes from the chart row at
  // save time; the spec itself carries only renderKey, so the renderer prints the
  // key and leaves the title strip to the save layer (TODO: thread songTitle in).
  drawText(pages[0], fontBold, `Key: ${spec.renderKey}`, MARGIN_X, MARGIN_TOP - 36, 14);

  for (const sys of layout.systems) {
    const pg = pages[sys.page - 1];
    if (sys.label) {
      drawText(pg, fontBold, sys.label, denormX(sys.xStart), denormYTop(sys.labelYTop) - 12, 11);
    }
    // System baseline.
    const yTopPt = denormYTop(sys.yTop);
    const yBottomPt = denormYTop(sys.yBottom);
    drawLine(pg, denormX(sys.xStart), yBottomPt, denormX(sys.xEnd), yBottomPt);

    for (const bar of sys.bars) {
      const xs = denormX(bar.xStart);
      // Leading barline.
      drawLine(pg, xs, yTopPt, xs, yBottomPt);
      // Chord text for this bar (if any change is addressed to it).
      const label = chordLabelForBar(bar);
      if (label) drawText(pg, font, label, xs + 4, yTopPt - 16, 12);
    }
    // Trailing barline at the end of the system.
    const xe = denormX(sys.xEnd);
    drawLine(pg, xe, yTopPt, xe, yBottomPt);
  }

  return doc.save();
}

// The Nashville chord text for a bar, built from its section's changes (sparse;
// a bar with no change renders blank). Split bars join with a thin space.
function chordLabelForBar(bar: LaidBar): string | null {
  const change = bar.section.changes?.find((c) => c.bar === bar.barInSection);
  if (!change) return null;
  return change.chords
    .map((c) => {
      const quality = c.quality ?? '';
      const bass = c.bass ? `/${c.bass}` : '';
      const held = c.held ? '◇' : '';
      return `${c.degree}${quality}${bass}${held}`;
    })
    .join('  ');
}

// ── PDF coordinate helpers (normalized 0..1 → PDF points, y flipped) ──────────
function denormX(xNorm: number): number {
  return xNorm * PAGE_W;
}
// PDF y is bottom-up; our normalized y is top-down.
function denormYTop(yNorm: number): number {
  return PAGE_H * (1 - yNorm);
}

function drawText(page: PDFPage, font: PDFFont, text: string, x: number, y: number, size: number): void {
  page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
}

function drawLine(page: PDFPage, x1: number, y1: number, x2: number, y2: number): void {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: rgb(0, 0, 0) });
}
