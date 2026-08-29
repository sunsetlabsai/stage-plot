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
  System,
} from './types';
import type { BarRef, RoadmapSpec } from './roadmap-spec';
// The section→systems→bars geometry lives in a pure, pdf-lib-free module shared
// with the React preview (design §4.1). This file owns ONLY the PDF projection.
import {
  PAGE_W,
  PAGE_H,
  MARGIN_X,
  layoutRoadmap,
  lineStartNumbers,
  type LaidBar,
  type RoadmapLayout,
} from './roadmap-layout';
import { slashBeats } from './roadmap-rhythm';

// The bar band (SYSTEM_BARS_H = 48pt) splits into a chord row on top and a rhythm
// strip below, in the SAME 20/28 proportion as the preview's h-5 / h-7 rows, so a
// bar reads as a two-line staff in both. The chord baseline (yTop − 18) sits in
// the chord row; the top rule at yTop − CHORD_ROW_PT divides it from the strip.
const CHORD_ROW_PT = 20;

export interface RenderResult {
  pdfBytes: Uint8Array;
  calibration: ChartCalibration;
}

export interface RenderOptions {
  songTitle?: string;  // printed in the header; the spec carries only renderKey
  artist?: string;     // song-level credit under the title (from the songs row)
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

  // Header (page 1): song title + artist credit (if provided by the save layer)
  // then an authored-key tag. The body is pure Nashville degrees (key-invariant),
  // so the LIVE key is resolved at view time in the app chrome from the show's
  // setlist override (chunk 4, Option A) — NOT read off this PDF. This tag is a
  // demoted, informational provenance note ("authored in X"), not the live key,
  // so a standalone/printed PDF isn't keyless without claiming a key it can't honor.
  // It drops a line when a credit is present so they never collide.
  // Bug A fix (design §4.0): every header baseline is a clean TOP-origin offset
  // (see headerBaselinesPt), flipped to pdf-lib's bottom origin via denormYTopPt,
  // so the whole header band sits in the top MARGIN_TOP strip, title highest.
  const header = headerBaselinesPt({ hasArtist: Boolean(opts.artist) });
  if (opts.songTitle) {
    drawText(pages[0], fontBold, opts.songTitle, MARGIN_X, header.title, 18);
  }
  if (opts.artist) {
    drawText(pages[0], font, opts.artist, MARGIN_X, header.artist, 11);
  }
  drawText(pages[0], font, `Nashville (authored in ${spec.renderKey})`, MARGIN_X, header.key, 10);

  const beats = spec.timeSig.beats;
  // Line-start measure numbers by the ONE shared rule (design §3.3 item 1): each
  // system's number is the absNumber of its first bar. Same rule the preview runs.
  const lineNumbers = lineStartNumbers(layout.systems.map((s) => s.bars));
  for (const [i, sys] of layout.systems.entries()) {
    const pg = pages[sys.page - 1];
    if (sys.label) {
      drawText(pg, fontBold, sys.label, denormX(sys.xStart), denormYTop(sys.labelYTop) - 12, 11);
    }
    const yTopPt = denormYTop(sys.yTop);
    const yBottomPt = denormYTop(sys.yBottom);
    const stripTopPt = yTopPt - CHORD_ROW_PT;
    drawLine(pg, denormX(sys.xStart), yBottomPt, denormX(sys.xEnd), yBottomPt, 1); // staff bottom rule
    // Staff TOP rule (design): the rhythm strip needs both rules to read as a
    // staff like the preview; the PDF drew only the bottom rule before.
    drawLine(pg, denormX(sys.xStart), stripTopPt, denormX(sys.xEnd), stripTopPt, 1);

    // Measure number in the left gutter (design §3.1): 8pt, right-aligned 3pt clear
    // of the leading barline so it is subordinate to the 11pt bold label and never
    // enters the staff. Bound (§3.1): if the glyph would run off the page's left
    // edge, omit rather than overflow — never draw across the barline.
    const measureNo = lineNumbers[i];
    if (measureNo != null) {
      const label = String(measureNo);
      const w = font.widthOfTextAtSize(label, 8);
      const x = denormX(sys.xStart) - w - 3;
      if (x >= 3) drawText(pg, font, label, x, yTopPt - 8, 8);
    }

    for (const bar of sys.bars) {
      drawLine(pg, denormX(bar.xStart), yTopPt, denormX(bar.xStart), yBottomPt, 1); // leading barline
      drawSlashBand(pg, bar, beats, stripTopPt, yBottomPt); // rhythm strip: EVERY bar
      drawBarContent(pg, font, bar, beats, yTopPt);          // chord labels: sparse
    }
    drawLine(pg, denormX(sys.xEnd), yTopPt, denormX(sys.xEnd), yBottomPt, 1); // trailing barline
  }

  drawRoadmapGlyphs(pages, fontBold, spec, layout);

  return doc.save();
}

// The rhythm strip — one slash per beat across the FULL width of EVERY bar (the
// staff band the preview always drew but the PDF never did, so slashes could never
// reach the printed show). Held beats are suppressed by the SHARED slashBeats rule
// so the strip agrees with the diamond drawn above it. Slashes are diagonal
// STROKES, not a ╱ glyph: Helvetica/WinAnsi can't encode U+2571 — the same
// constraint the accidental prefix works around (see drawBarContent).
function drawSlashBand(page: PDFPage, bar: LaidBar, beats: number, stripTopPt: number, stripBotPt: number): void {
  if (beats <= 0) return;
  const change = bar.section.changes?.find((c) => c.bar === bar.barInSection);
  const slots = slashBeats(change?.chords, beats);
  const x0 = denormX(bar.xStart);
  const w = denormX(bar.xEnd) - x0;
  const midY = (stripTopPt + stripBotPt) / 2;
  const rise = 5; // ±5pt tall (10pt within the 28pt strip)…
  const run = 3;  // …and ±3pt wide, so each stroke leans like ╱ (low-left → high-right)
  for (let b = 0; b < beats; b += 1) {
    if (!slots[b]) continue;
    const cx = x0 + (b + 0.5) * (w / beats);
    drawLine(page, cx - run, midY - rise, cx + run, midY + rise, 0.75);
  }
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
    // A chromatic root accidental (♭/♯) is a VECTOR prefix glyph — Helvetica
    // (WinAnsi) cannot encode U+266D/U+266F, so it must NOT be interpolated into
    // the drawText label. It claims a fixed advance (accW) immediately left of the
    // degree, shifting the alphanumeric label right; alter 0/undefined adds nothing
    // (existing charts render byte-identically).
    const accW = c.alter ? 6 : 0;
    if (c.alter) drawAccidental(page, c.alter, cx, textY, 12);
    const label = `${c.degree}${c.quality ?? ''}${c.bass ? `/${c.bass}` : ''}`;
    drawText(page, font, label, cx + accW, textY, 12);
    if (c.held) {
      const dx = cx + accW + font.widthOfTextAtSize(label, 12) + 5;
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

  // Co-located markers must not overprint. The resolver allows distinct kinds on
  // one bar (e.g. a times>2 repeatEnd and a same-bar D.S. jump, or To Coda + D.S.
  // across passes), so every label anchored above a bar's start/end edge claims a
  // row in this shared stack and is lifted clear of the ones already there.
  const rows = new Map<string, number>();
  const stackDy = (b: LaidBar, edge: 'start' | 'end'): number => {
    const key = `${b.page}:${b.id}:${edge}`;
    const n = rows.get(key) ?? 0;
    rows.set(key, n + 1);
    return n * 10;
  };

  spec.sections.forEach((section, si) => {
    const repeat = section.repeat;
    if (!repeat) return;
    const first = barAt.get(`${si}:1`);
    const last = barAt.get(`${si}:${section.bars}`);
    if (!first || !last) return;

    drawRepeatStart(pageOf(first), first);
    if (repeat.kind === 'plain') {
      // The ×N count only prints (and only claims an end-edge row) when times>2.
      const dy = repeat.times > 2 ? stackDy(last, 'end') : 0;
      drawRepeatEnd(pageOf(last), last, font, repeat.times, dy);
    } else {
      repeat.endings.forEach((ending) => {
        const bars: LaidBar[] = [];
        for (let k = 0; k < ending.bars.count; k++) {
          const b = barAt.get(`${si}:${ending.bars.start + k}`);
          if (b) bars.push(b);
        }
        drawVoltaBracket(pages, bars, font, ending.passes);
        // The volta pass-label sits above the ending's first bar at the start
        // edge. Claim its start-edge row so any nav directive later landing on
        // that same bar stacks above it instead of overprinting. The label
        // always renders first (section pass precedes nav), so it keeps row 0 —
        // its own position is unchanged.
        if (bars.length > 0) stackDy(bars[0], 'start');
      });
    }
  });

  const nav = spec.navigation;
  if (!nav) return;
  const at = (ref: BarRef): LaidBar | undefined => barAt.get(`${ref.section}:${ref.bar}`);

  if (nav.segno) { const b = at(nav.segno); if (b) drawDirective(pageOf(b), font, b, 'start', 'Segno', 0, stackDy(b, 'start')); }
  if (nav.coda) {
    const b = at(nav.coda);
    if (b) {
      const cx = denormX(b.xStart) + 8;
      const cy = denormYTop(b.yTop) + 12;
      drawCodaSign(pageOf(b), cx, cy, 5);
      drawDirective(pageOf(b), font, b, 'start', 'Coda', 18, stackDy(b, 'start'));
    }
  }
  if (nav.toCoda) { const b = at(nav.toCoda); if (b) drawDirective(pageOf(b), font, b, 'end', 'To Coda', 0, stackDy(b, 'end')); }
  if (nav.fine) { const b = at(nav.fine); if (b) drawDirective(pageOf(b), font, b, 'end', 'Fine', 0, stackDy(b, 'end')); }
  if (nav.jump) { const b = at(nav.jump.at); if (b) drawDirective(pageOf(b), font, b, 'end', jumpLabel(nav.jump.from, nav.jump.until), 0, stackDy(b, 'end')); }
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
// `dy` lifts the ×N count into the shared end-edge row stack so it never
// overprints a co-located navigation directive on the same bar.
function drawRepeatEnd(page: PDFPage, bar: LaidBar, font: PDFFont, times: number, dy = 0): void {
  const x = denormX(bar.xEnd) - 2;
  const top = denormYTop(bar.yTop);
  const bottom = denormYTop(bar.yBottom);
  const h = top - bottom;
  drawDot(page, x - 4, bottom + h * 0.38, 1.6);
  drawDot(page, x - 4, bottom + h * 0.62, 1.6);
  drawLine(page, x, top, x, bottom, 2.5);
  if (times > 2) drawText(page, font, `\u00d7${times}`, x - 18, top + 3 + dy, 9);
}

// Volta bracket: a horizontal line above the ending bars, a down-tick at the
// start, and the pass numbers (e.g. "1." or "2.–3."). An ending may span systems
// (or pages) for a valid spec, so we draw one bracket segment per contiguous
// run of bars sharing a page+system; the down-tick and label sit on the first.
function drawVoltaBracket(pages: PDFPage[], bars: LaidBar[], font: PDFFont, passes: number[]): void {
  if (bars.length === 0) return;
  const groups: LaidBar[][] = [];
  for (const b of bars) {
    const last = groups[groups.length - 1];
    if (last && last[0].page === b.page && last[0].systemId === b.systemId) last.push(b);
    else groups.push([b]);
  }
  const label = voltaLabel(passes);
  groups.forEach((group, gi) => {
    const page = pages[group[0].page - 1];
    const x0 = denormX(group[0].xStart);
    const x1 = denormX(group[group.length - 1].xEnd);
    const y = denormYTop(group[0].yTop) + 10;
    drawLine(page, x0, y, x1, y, 1);        // top of bracket
    if (gi === 0) {
      drawLine(page, x0, y, x0, y - 8, 1);  // left down-tick on the first segment
      drawText(page, font, label, x0 + 3, y - 9, 8);
    }
  });
}

// Pass-number label for a volta ending. The validator allows any pass set
// (unsorted, non-contiguous), so we sort and collapse only genuinely adjacent
// runs into "a.–b."; gaps stay separate terms ("1. 3.") so the printed label
// never implies a pass the ending doesn't actually take.
export function voltaLabel(passes: number[]): string {
  const sorted = [...passes].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (i < sorted.length && cur === prev + 1) { prev = cur; continue; }
    runs.push(start === prev ? `${start}.` : `${start}.\u2013${prev}.`);
    start = cur;
    prev = cur;
  }
  return runs.join(' ');
}

// ⊕ — coda sign: outline circle with a vertical + horizontal line through it.
function drawCodaSign(page: PDFPage, cx: number, cy: number, r: number): void {
  page.drawCircle({ x: cx, y: cy, size: r, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  drawLine(page, cx, cy - r - 2, cx, cy + r + 2, 1);
  drawLine(page, cx - r - 2, cy, cx + r + 2, cy, 1);
}

// ♭ / ♯ — chromatic-root accidental prefix, drawn as a vector (Helvetica/WinAnsi
// can't encode U+266D/U+266F), consistent with the other music glyphs. (cx,
// baseline) is the lower-left corner; the glyph is sized to the chord font and
// sits on the text baseline, immediately left of the degree number.
function drawAccidental(page: PDFPage, alter: -1 | 1, cx: number, baseline: number, size: number): void {
  const w = size * 0.34;
  const h = size * 0.74;
  if (alter < 0) {
    // ♭ — vertical stem with a bowl on the lower-right.
    drawLine(page, cx, baseline, cx, baseline + h, 0.9);                                  // stem
    drawLine(page, cx, baseline + h * 0.5, cx + w, baseline + h * 0.28, 0.9);             // bowl upper
    drawLine(page, cx + w, baseline + h * 0.28, cx, baseline, 0.9);                       // bowl lower
  } else {
    // ♯ — two verticals crossed by two (slightly rising) horizontals.
    const xa = cx + w * 0.3;
    const xb = cx + w * 0.72;
    drawLine(page, xa, baseline, xa, baseline + h, 0.9);
    drawLine(page, xb, baseline, xb, baseline + h, 0.9);
    drawLine(page, cx, baseline + h * 0.36, cx + w, baseline + h * 0.46, 0.9);
    drawLine(page, cx, baseline + h * 0.6, cx + w, baseline + h * 0.7, 0.9);
  }
}

// ◇ — held/whole-note diamond (4-line rhombus).
function drawDiamond(page: PDFPage, cx: number, cy: number, half: number): void {
  drawLine(page, cx, cy + half, cx + half, cy, 1);
  drawLine(page, cx + half, cy, cx, cy - half, 1);
  drawLine(page, cx, cy - half, cx - half, cy, 1);
  drawLine(page, cx - half, cy, cx, cy + half, 1);
}

// A text directive (Segno / Coda / To Coda / Fine / D.S. al Coda…) anchored above
// the band at the bar's start or end edge. `dx` nudges past an adjacent glyph;
// `dy` lifts the row so co-located directives stack instead of overprinting.
function drawDirective(page: PDFPage, font: PDFFont, bar: LaidBar, edge: 'start' | 'end', text: string, dx = 0, dy = 0): void {
  const y = denormYTop(bar.yTop) + 8 + dy;
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
// A TOP-measured offset (points from the page's top edge) → pdf-lib's bottom
// origin. Mirrors denormYTop for raw point offsets, so the header band is
// expressed top-down (the natural way) and lands correctly top-up (Bug A, §4.0).
function denormYTopPt(topOffsetPt: number): number {
  return PAGE_H - topOffsetPt;
}

// Header baselines as clean TOP-origin offsets (points from the top edge),
// descending so title is highest, then artist, then the authored-key tag. Larger
// offset = lower on the page. The key tag drops below the artist credit when one
// is present (else it takes the artist slot) so they never collide. EVERY value
// is < MARGIN_TOP, so flipped via denormYTopPt the whole band sits in the top
// margin strip. Pure + exported so the ordering/band invariant is unit-testable
// without rasterizing the PDF (design §8).
export function headerBaselinesPt(opts: { hasArtist: boolean }): { title: number; artist: number; key: number } {
  const titleOffset = 36;
  const artistOffset = 52;
  const keyOffset = opts.hasArtist ? 70 : artistOffset;
  return {
    title: denormYTopPt(titleOffset),
    artist: denormYTopPt(artistOffset),
    key: denormYTopPt(keyOffset),
  };
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
