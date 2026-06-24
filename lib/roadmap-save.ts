import type { RoadmapSpec } from './roadmap-spec';
import type { ChartCalibration } from './types';

// ── Roadmap Builder — chunk 3: the spec↔calibration parity gate ──────────────
// isValidCalibration / canVerify prove the calibration is SHAPE-valid and
// resolver-consistent, but NOT that the renderer emitted what the spec actually
// described — a renderer bug could pass those gates while drawing the wrong song.
// Before the save route hashes + persists, it asserts builder-specific parity:
// the calibration's sections/bars/markers must match what the spec NAMED. This
// recomputes the expectations straight from the spec (independent of the
// renderer's internal layout math), so a renderer that drops or miscounts a bar
// or a marker is caught here → 5xx, persist nothing (design §Save step 3).

export type ParityResult = { ok: true } | { ok: false; errors: string[] };

// Assert the rendered calibration faithfully represents the spec. Returns every
// mismatch (not just the first) so a renderer regression is fully described.
export function assertSpecCalibrationParity(spec: RoadmapSpec, cal: ChartCalibration): ParityResult {
  const errors: string[] = [];
  const bars = cal.bars ?? [];
  const roadmap = cal.roadmap ?? [];

  // 1. One section anchor per spec section, in order, with matching labels.
  if (cal.sections.length !== spec.sections.length) {
    errors.push(`section count ${cal.sections.length} != spec ${spec.sections.length}`);
  } else {
    spec.sections.forEach((s, i) => {
      if (cal.sections[i].label !== s.label) {
        errors.push(`section ${i + 1} label "${cal.sections[i].label}" != spec "${s.label}"`);
      }
    });
  }

  // 2. Total bar count == Σ section bar counts.
  const totalBars = spec.sections.reduce((n, s) => n + s.bars, 0);
  if (bars.length !== totalBars) {
    errors.push(`bar count ${bars.length} != spec total ${totalBars}`);
  }

  // 3. Every bar is assigned to a section, and each section's emitted bar count
  //    matches its spec count.
  const bySection = new Map<string, number>();
  for (const b of bars) {
    if (b.sectionId == null) {
      errors.push(`bar ${b.absNumber} has no sectionId`);
      continue;
    }
    bySection.set(b.sectionId, (bySection.get(b.sectionId) ?? 0) + 1);
  }
  spec.sections.forEach((s, i) => {
    const id = cal.sections[i]?.id;
    if (id == null) return; // section-count mismatch already reported
    const got = bySection.get(id) ?? 0;
    if (got !== s.bars) {
      errors.push(`section ${i + 1} ("${s.label}") has ${got} bars, spec says ${s.bars}`);
    }
  });

  // 4. Every spec repeat/ending/navigation projects to exactly the expected
  //    roadmap markers — no drops, no extras.
  const expected = expectedMarkerCounts(spec);
  const actual = new Map<string, number>();
  for (const m of roadmap) actual.set(m.kind, (actual.get(m.kind) ?? 0) + 1);

  for (const [kind, n] of expected) {
    const got = actual.get(kind) ?? 0;
    if (got !== n) errors.push(`expected ${n} ${kind} marker(s), calibration has ${got}`);
  }
  for (const [kind, got] of actual) {
    if (!expected.has(kind)) errors.push(`calibration has ${got} unexpected ${kind} marker(s)`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// The marker multiset the spec implies: each section repeat → a repeatStart plus
// either a repeatEnd (plain) or one ending per VoltaEnding; each navigation field
// → its matching marker kind.
function expectedMarkerCounts(spec: RoadmapSpec): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (kind: string, by = 1) => m.set(kind, (m.get(kind) ?? 0) + by);

  for (const s of spec.sections) {
    const r = s.repeat;
    if (!r) continue;
    bump('repeatStart');
    if (r.kind === 'plain') bump('repeatEnd');
    else bump('ending', r.endings.length);
  }

  const nav = spec.navigation;
  if (nav) {
    if (nav.segno) bump('segno');
    if (nav.coda) bump('coda');
    if (nav.toCoda) bump('toCoda');
    if (nav.fine) bump('fine');
    if (nav.jump) bump('jump');
  }

  return m;
}
