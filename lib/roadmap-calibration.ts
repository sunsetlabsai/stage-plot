// ── Roadmap spec → ChartCalibration (Stage 2 of the render pipeline) ─────────
// Pure — no pdf-lib — so the browser-side builder can walk a chart through the
// same VM the show uses (navLive, design-roadmap-structure-editing.md §3). The
// PDF stage (roadmap-render.ts) consumes this; nothing here draws.

import { CALIBRATION_SCHEMA_VERSION, barsInOrder, walkRoadmap } from './chart-calibration';
import type { Bar, ChartCalibration, RoadmapMarker, System } from './types';
import type { BarRef, RoadmapSpec } from './roadmap-spec';
import { layoutRoadmap, type LaidBar, type RoadmapLayout } from './roadmap-layout';

// A (sectionIndex, barInSection) → laid bar lookup. The single source both the
// calibration projection and the PDF glyph pass use to resolve repeats/navigation
// to concrete bars, so the two can't disagree on where a marker lands.
export function barIndex(layout: RoadmapLayout): Map<string, LaidBar> {
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

// ── Navigation liveness (design-roadmap-structure-editing.md §3) ─────────────
// Does every redirect in the chart actually take effect? Walks the VM exactly as
// the show does (walkRoadmap) and anchors on the step where each redirect FIRES:
//   • D.C. / D.S. — fired[jumpId] flips; the next bar played must be the chart's
//     first bar (D.C.) or the Segno bar (D.S.);
//   • al Coda — flags.toCodaFired flips; the next bar played must be the Coda bar;
//   • al Fine — the walk's last bar must be the Fine bar.
// A redirect that never fires, or fires and lands elsewhere (a volta exit that
// pre-empts it, an ending that skips its target), is not live; nor is a walk that
// fails or hits the cap. A flag alone is not enough (Codex R5), and neither is a
// bare "jump bar then first bar" pair, which an ordinary repeat back-jump can
// produce. `dead` names the redirect that failed, for the refusal.
export type NavLiveness = { live: true } | { live: false; dead: 'jump' | 'toCoda' | 'fine' | 'walk' };

export function navLive(spec: RoadmapSpec): NavLiveness {
  let layout: RoadmapLayout;
  let cal: ChartCalibration;
  try {
    layout = layoutRoadmap(spec);
    cal = buildCalibration(spec, layout);
  } catch {
    return { live: false, dead: 'walk' };
  }
  const walk = walkRoadmap(cal);
  if (!walk.ok) return { live: false, dead: 'walk' };
  const jump = spec.navigation?.jump;
  if (!jump) return { live: true };

  const steps = walk.steps;
  const barAt = barIndex(layout);
  const idOf = (ref: BarRef | undefined) => (ref ? barAt.get(`${ref.section}:${ref.bar}`)?.id : undefined);
  const landsOn = (firedAt: number, target: string | undefined) =>
    firedAt !== -1 && target !== undefined && steps[firedAt + 1]?.step.barId === target;

  const jumpFired = steps.findIndex((s) => Object.values(s.state.fired).some(Boolean));
  const jumpTarget = jump.from === 'capo' ? barsInOrder(cal)[0]?.id : idOf(spec.navigation?.segno);
  if (!landsOn(jumpFired, jumpTarget)) return { live: false, dead: 'jump' };

  if (jump.until === 'coda') {
    const codaFired = steps.findIndex((s) => s.state.flags.toCodaFired);
    if (!landsOn(codaFired, idOf(spec.navigation?.coda))) return { live: false, dead: 'toCoda' };
  }
  if (jump.until === 'fine' && steps[steps.length - 1]?.step.barId !== idOf(spec.navigation?.fine)) {
    return { live: false, dead: 'fine' };
  }
  return { live: true };
}
