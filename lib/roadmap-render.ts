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
// → idempotent re-render/replace. We get it from fixed layout constants (below),
// stripped PDF dates, StandardFonts (byte-stable for the text), and VECTOR music
// symbols (no binary font asset). The save path re-renders + re-hashes per save,
// so within-version byte-stability is sufficient; a custom-bundled font would only
// add cross-pdf-lib-version robustness and is deferred until/if that's needed.
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

export interface RenderOptions {
  songTitle?: string;  // printed in the header; the spec carries only renderKey
}

// ── Public entry point ────────────────────────────────────────────────────────
// Assumes `spec` already passed validateRoadmapSpec — the renderer is a pure
// projection, not a second validator. Callers (save route) gate first.
export async function renderRoadmap(spec: RoadmapSpec, opts: RenderOptions = {}): Promise<RenderResult> {
  const layout = layoutRoadmap(spec);
  const calibration = buildCalibration(spec, layout);
  const pdfBytes = await drawRoadmapPdf(spec, layout, opts);
  return { pdfBytes, calibration };
}

// A (sectionIndex, barInSection) → laid bar lookup. The single source both the
// calibration projection and the PDF glyph pass use to resolve repeats/navigation
// to concrete bars, so the two can't disagree on where a marker lands.
function barIndex(layout: RoadmapLayout): Map<string, LaidBar> {
  const m = new Map<string, LaidBar>();
  for (const b of layout.bars) m.set(`${b.sectionIndex}:${b.barInSection}`, b);
  return m;
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

  // Shared (sectionIndex, barInSection) → bar lookup for BarRef resolution and
  // section-edge anchoring.
  const barAt = barIndex(layout);
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
// Draws the substrate: header (title + key), section labels, system baselines,
// barlines, split-bar-aware Nashville chord text with held diamonds, and the
// roadmap glyph pass (repeat |: :| dots, volta 1./2. brackets, coda ⊕ sign,
// Segno / To Coda / Fine / D.S./D.C. directives). None of this touches the
// calibration — structure is exact upstream; this is pure visual projection.
//
// Music symbols are drawn as VECTOR shapes (not a music font): Helvetica has no
// segno/coda/diamond glyphs, and vectors are deterministic with zero binary asset.
// StandardFonts is already byte-stable (proven by the determinism test); the save
// path re-renders + re-hashes per save, so within-version byte-stability — which
// StandardFonts + vectors give us — is all the source_hash/replace logic needs.
async function drawRoadmapPdf(spec: RoadmapSpec, layout: RoadmapLayout, opts: RenderOptions): Promise<Uint8Array> {
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

  // Header (page 1): song title (if provided by the save layer) + key.
  if (opts.songTitle) {
    drawText(pages[0], fontBold, opts.songTitle, MARGIN_X, MARGIN_TOP - 36, 18);
  }
  drawText(pages[0], fontBold, `Key: ${spec.renderKey}`, MARGIN_X, MARGIN_TOP - 58, 12);

  const beats = spec.timeSig.beats;
  for (const sys of layout.systems) {
    const pg = pages[sys.page - 1];
    if (sys.label) {
      drawText(pg, fontBold, sys.label, denormX(sys.xStart), denormYTop(sys.labelYTop) - 12, 11);
    }
    const yTopPt = denormYTop(sys.yTop);
    const yBottomPt = denormYTop(sys.yBottom);
    drawLine(pg, denormX(sys.xStart), yBottomPt, denormX(sys.xEnd), yBottomPt, 1);

    for (const bar of sys.bars) {
      drawLine(pg, denormX(bar.xStart), yTopPt, denormX(bar.xStart), yBottomPt, 1); // leading barline
      drawBarContent(pg, font, bar, beats, yTopPt);
    }
    drawLine(pg, denormX(sys.xEnd), yTopPt, denormX(sys.xEnd), yBottomPt, 1); // trailing barline
  }

  drawRoadmapGlyphs(pages, fontBold, spec, layout);

  return doc.save();
}

// Per-bar Nashville chord content. Sparse: a bar with no addressed change draws
// nothing. Split bars place each chord at its beat offset and drop a thin
// subdividing tick at each interior boundary; held chords get a diamond.
function drawBarContent(page: PDFPage, font: PDFFont, bar: LaidBar, beats: number, bandTopPt: number): void {
  const change = bar.section.changes?.find((c) => c.bar === bar.barInSection);
  if (!change) return;

  const x0 = denormX(bar.xStart);
  const x1 = denormX(bar.xEnd);
  const w = x1 - x0;
  const textY = bandTopPt - 18;

  const n = change.chords.length;
  let cumBeats = 0;
  change.chords.forEach((c, i) => {
    const frac = beats > 0 ? cumBeats / beats : i / n;
    const cx = x0 + 4 + frac * w;
    if (i > 0) {
      const tx = x0 + frac * w;
      drawLine(page, tx, bandTopPt, tx, bandTopPt - 8, 0.5); // interior split tick
    }
    const label = `${c.degree}${c.quality ?? ''}${c.bass ? `/${c.bass}` : ''}`;
    drawText(page, font, label, cx, textY, 12);
    if (c.held) {
      const dx = cx + font.widthOfTextAtSize(label, 12) + 5;
      drawDiamond(page, dx, textY + 4, 3.5);
    }
    cumBeats += c.beats ?? (beats > 0 ? beats / n : 0);
  });
}

// The roadmap glyph pass — resolves repeats + navigation to laid bars (the SAME
// barIndex the calibration uses) and draws the printed symbols.
function drawRoadmapGlyphs(pages: PDFPage[], font: PDFFont, spec: RoadmapSpec, layout: RoadmapLayout): void {
  const barAt = barIndex(layout);
  const pageOf = (b: LaidBar): PDFPage => pages[b.page - 1];

  spec.sections.forEach((section, si) => {
    const repeat = section.repeat;
    if (!repeat) return;
    const first = barAt.get(`${si}:1`);
    const last = barAt.get(`${si}:${section.bars}`);
    if (!first || !last) return;

    drawRepeatStart(pageOf(first), first);
    if (repeat.kind === 'plain') {
      drawRepeatEnd(pageOf(last), last, font, repeat.times);
    } else {
      repeat.endings.forEach((ending) => {
        const startBar = barAt.get(`${si}:${ending.bars.start}`);
        const endBar = barAt.get(`${si}:${ending.bars.start + ending.bars.count - 1}`);
        // Bracket math only makes sense within one system/page; voltas sit at a
        // section's tail and are short, so this holds in practice.
        if (startBar && endBar && startBar.page === endBar.page && startBar.systemId === endBar.systemId) {
          drawVoltaBracket(pageOf(startBar), startBar, endBar, font, ending.passes);
        }
      });
    }
  });

  const nav = spec.navigation;
  if (!nav) return;
  const at = (ref: BarRef): LaidBar | undefined => barAt.get(`${ref.section}:${ref.bar}`);

  if (nav.segno) { const b = at(nav.segno); if (b) drawDirective(pageOf(b), font, b, 'start', 'Segno'); }
  if (nav.coda) {
    const b = at(nav.coda);
    if (b) {
      const cx = denormX(b.xStart) + 8;
      const cy = denormYTop(b.yTop) + 12;
      drawCodaSign(pageOf(b), cx, cy, 5);
      drawDirective(pageOf(b), font, b, 'start', 'Coda', 18);
    }
  }
  if (nav.toCoda) { const b = at(nav.toCoda); if (b) drawDirective(pageOf(b), font, b, 'end', 'To Coda'); }
  if (nav.fine) { const b = at(nav.fine); if (b) drawDirective(pageOf(b), font, b, 'end', 'Fine'); }
  if (nav.jump) { const b = at(nav.jump.at); if (b) drawDirective(pageOf(b), font, b, 'end', jumpLabel(nav.jump.from, nav.jump.until)); }
}

// "D.C." / "D.S." with an optional al-Fine / al-Coda suffix.
function jumpLabel(from: 'capo' | 'segno', until: 'end' | 'fine' | 'coda'): string {
  const head = from === 'capo' ? 'D.C.' : 'D.S.';
  if (until === 'fine') return `${head} al Fine`;
  if (until === 'coda') return `${head} al Coda`;
  return head;
}

// ── Glyph primitives (vector; deterministic) ──────────────────────────────────

// |: — thick start barline + two dots just inside the bar's left edge.
function drawRepeatStart(page: PDFPage, bar: LaidBar): void {
  const x = denormX(bar.xStart) + 2;
  const top = denormYTop(bar.yTop);
  const bottom = denormYTop(bar.yBottom);
  const h = top - bottom;
  drawLine(page, x, top, x, bottom, 2.5);
  drawDot(page, x + 4, bottom + h * 0.38, 1.6);
  drawDot(page, x + 4, bottom + h * 0.62, 1.6);
}

// :| — two dots + thick end barline just inside the bar's right edge; ×N if >2.
function drawRepeatEnd(page: PDFPage, bar: LaidBar, font: PDFFont, times: number): void {
  const x = denormX(bar.xEnd) - 2;
  const top = denormYTop(bar.yTop);
  const bottom = denormYTop(bar.yBottom);
  const h = top - bottom;
  drawDot(page, x - 4, bottom + h * 0.38, 1.6);
  drawDot(page, x - 4, bottom + h * 0.62, 1.6);
  drawLine(page, x, top, x, bottom, 2.5);
  if (times > 2) drawText(page, font, `\u00d7${times}`, x - 18, top + 3, 9);
}

// Volta bracket: a horizontal line above the ending bars, a down-tick at the
// start, and the pass numbers (e.g. "1." or "2.–3.").
function drawVoltaBracket(page: PDFPage, startBar: LaidBar, endBar: LaidBar, font: PDFFont, passes: number[]): void {
  const x0 = denormX(startBar.xStart);
  const x1 = denormX(endBar.xEnd);
  const y = denormYTop(startBar.yTop) + 10;
  drawLine(page, x0, y, x1, y, 1);          // top of bracket
  drawLine(page, x0, y, x0, y - 8, 1);      // left down-tick
  const label = passes.length > 1 ? `${passes[0]}.\u2013${passes[passes.length - 1]}.` : `${passes[0]}.`;
  drawText(page, font, label, x0 + 3, y - 9, 8);
}

// ⊕ — coda sign: outline circle with a vertical + horizontal line through it.
function drawCodaSign(page: PDFPage, cx: number, cy: number, r: number): void {
  page.drawCircle({ x: cx, y: cy, size: r, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  drawLine(page, cx, cy - r - 2, cx, cy + r + 2, 1);
  drawLine(page, cx - r - 2, cy, cx + r + 2, cy, 1);
}

// ◇ — held/whole-note diamond (4-line rhombus).
function drawDiamond(page: PDFPage, cx: number, cy: number, half: number): void {
  drawLine(page, cx, cy + half, cx + half, cy, 1);
  drawLine(page, cx + half, cy, cx, cy - half, 1);
  drawLine(page, cx, cy - half, cx - half, cy, 1);
  drawLine(page, cx - half, cy, cx, cy + half, 1);
}

// A text directive (Segno / Coda / To Coda / Fine / D.S. al Coda…) anchored above
// the band at the bar's start or end edge. `dx` nudges past an adjacent glyph.
function drawDirective(page: PDFPage, font: PDFFont, bar: LaidBar, edge: 'start' | 'end', text: string, dx = 0): void {
  const y = denormYTop(bar.yTop) + 8;
  const x = edge === 'start'
    ? denormX(bar.xStart) + dx
    : denormX(bar.xEnd) - font.widthOfTextAtSize(text, 9) - dx;
  drawText(page, font, text, x, y, 9);
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

function drawLine(page: PDFPage, x1: number, y1: number, x2: number, y2: number, thickness: number): void {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: rgb(0, 0, 0) });
}

function drawDot(page: PDFPage, x: number, y: number, r: number): void {
  page.drawCircle({ x, y, size: r, color: rgb(0, 0, 0) });
}
