import type { ChartCalibration } from './types';
import { resolveRoadmap } from './chart-calibration';

// ── Converter review queue (chunk 3) ────────────────────────────────────────
// Pure flagging seam for the calibrate-mode review queue. The converter seeds a
// draft overlay with per-element `confidence`; this module decides which
// elements the human should look at — those the model wasn't sure about, plus
// any roadmap markers that don't resolve. All UI surfacing (dashed-amber flag,
// the toolbar stepper) reads ONLY from here, so the logic is unit-testable under
// vitest env=node (the React overlay itself is not).
//
// Lifecycle note (chunk 1): editing an element clears its `confidence`
// (`withoutConfidence` in chart-calibration.ts), so a flag self-clears the
// instant the human touches it — the queue can never strand a reviewed-but-still
// -flagged item. Absent confidence (manual elements) is never flagged.

// Start conservative — flag anything the model was less than this sure of. A
// single uniform threshold to begin; a per-element-type split is a one-line
// change to a Record once real charts justify specific values (design open-Q3).
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

function isLowConfidence(confidence: number | undefined): boolean {
  return confidence !== undefined && confidence < REVIEW_CONFIDENCE_THRESHOLD;
}

// A flagged element, tagged with the calibrate tool that renders it and the page
// it lives on, so the stepper can switch tool + page + select it in one tap.
export type FlaggedRef =
  | { type: 'section'; id: string; tool: 'sections'; page: number }
  | { type: 'system'; id: string; tool: 'bars'; page: number }
  | { type: 'marker'; id: string; tool: 'roadmap'; page: number };

export interface ReviewFlags {
  sectionIds: Set<string>;
  systemIds: Set<string>; // a band is flagged if it OR any of its bars is low-confidence
  markerIds: Set<string>; // low-confidence markers ∪ resolveRoadmap error markers
  count: number; // total distinct flagged elements (= ordered.length)
  ordered: FlaggedRef[]; // page → top → left walk order for the review stepper
}

// Compute the review-queue flags for a calibration. Sets are keyed by element id
// (disjoint id spaces, so the three are non-overlapping and count == ordered.length).
export function reviewFlags(cal: ChartCalibration): ReviewFlags {
  const sections = cal.sections ?? [];
  const systems = cal.systems ?? [];
  const bars = cal.bars ?? [];
  const markers = cal.roadmap ?? [];

  // Sections: directly low-confidence.
  const sectionIds = new Set<string>();
  for (const s of sections) if (isLowConfidence(s.confidence)) sectionIds.add(s.id);

  // Systems: low-confidence on the band OR any child bar (bars roll up to the
  // band — bars are authored by count, not placed, so a per-tick flag isn't
  // actionable; the human fixes the band).
  const lowBarSystemIds = new Set<string>();
  for (const b of bars) if (isLowConfidence(b.confidence)) lowBarSystemIds.add(b.systemId);
  const systemIds = new Set<string>();
  for (const sys of systems) {
    if (isLowConfidence(sys.confidence) || lowBarSystemIds.has(sys.id)) systemIds.add(sys.id);
  }

  // Markers: low-confidence ∪ resolve-error (Set dedups a marker that is both).
  const markerIds = new Set<string>();
  for (const m of markers) if (isLowConfidence(m.confidence)) markerIds.add(m.id);
  const resolved = resolveRoadmap(cal);
  if (!resolved.ok) for (const id of resolved.error.markerIds) markerIds.add(id);

  // Walk order: page → top → left across all flagged elements, so the stepper
  // moves through the chart the way a human reads it.
  const sysById = new Map(systems.map((s) => [s.id, s] as const));
  const barById = new Map(bars.map((b) => [b.id, b] as const));
  type Keyed = { ref: FlaggedRef; key: [number, number, number] };
  const keyed: Keyed[] = [];

  for (const s of sections) {
    if (sectionIds.has(s.id)) {
      keyed.push({ ref: { type: 'section', id: s.id, tool: 'sections', page: s.page }, key: [s.page, s.y, s.x] });
    }
  }
  for (const sys of systems) {
    if (systemIds.has(sys.id)) {
      keyed.push({ ref: { type: 'system', id: sys.id, tool: 'bars', page: sys.page }, key: [sys.page, sys.yTop, sys.xStart] });
    }
  }
  for (const m of markers) {
    if (!markerIds.has(m.id)) continue;
    // Derive the marker's position from its (first) bar's system band.
    const barId = m.kind === 'ending' ? m.barIds[0] : m.barId;
    const bar = barId ? barById.get(barId) : undefined;
    const sys = bar ? sysById.get(bar.systemId) : undefined;
    const page = sys?.page ?? Number.MAX_SAFE_INTEGER;
    const y = sys?.yTop ?? 1;
    const x = bar?.xStart ?? 1;
    keyed.push({ ref: { type: 'marker', id: m.id, tool: 'roadmap', page }, key: [page, y, x] });
  }

  keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);

  return {
    sectionIds,
    systemIds,
    markerIds,
    count: keyed.length,
    ordered: keyed.map((k) => k.ref),
  };
}
