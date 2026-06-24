import type { RoadmapSpec, BarRef } from './roadmap-spec';
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

  // base[i] = absolute (1-based) number of section i's first bar; the running
  // total that defines each section's CONTIGUOUS spec bar-range.
  const base: number[] = [];
  let acc = 1;
  for (const s of spec.sections) {
    base.push(acc);
    acc += s.bars;
  }
  const totalBars = acc - 1;

  // 2. Total bar count == Σ section bar counts.
  if (bars.length !== totalBars) {
    errors.push(`bar count ${bars.length} != spec total ${totalBars}`);
  }

  // 3. SECTION MEMBERSHIP (not just per-section counts): each bar must belong to
  //    the section whose contiguous spec bar-range contains its absolute number.
  //    Counting bars per section is insufficient — a renderer could swap which
  //    section owns which contiguous block (sec-0 ← bars 3-4, sec-1 ← bars 1-2)
  //    with both counts AND labels still matching. Mapping each absNumber to its
  //    spec-implied section and comparing the bar's sectionId catches that.
  if (cal.sections.length === spec.sections.length) {
    const absToSectionIndex = (abs: number): number => {
      // base is strictly ascending; the owning section is the last whose first
      // bar is ≤ abs.
      let idx = -1;
      for (let i = 0; i < base.length; i += 1) {
        if (base[i] <= abs) idx = i;
        else break;
      }
      return idx;
    };
    const labelOf = new Map<string, string>();
    for (const sec of cal.sections) labelOf.set(sec.id, sec.label);

    for (const b of bars) {
      if (b.sectionId == null) {
        errors.push(`bar ${b.absNumber} has no sectionId`);
        continue;
      }
      if (b.absNumber < 1 || b.absNumber > totalBars) {
        errors.push(`bar ${b.absNumber} is outside the spec bar range 1..${totalBars}`);
        continue;
      }
      const expectIdx = absToSectionIndex(b.absNumber);
      const expectId = cal.sections[expectIdx].id;
      if (b.sectionId !== expectId) {
        const gotLabel = labelOf.get(b.sectionId) ?? b.sectionId;
        errors.push(
          `bar ${b.absNumber} is in section "${gotLabel}" but the spec puts it in "${spec.sections[expectIdx].label}"`,
        );
      }
    }
  } else {
    // Section-count mismatch (reported in #1) makes range mapping meaningless;
    // still surface any unassigned bars so the report is complete.
    for (const b of bars) {
      if (b.sectionId == null) errors.push(`bar ${b.absNumber} has no sectionId`);
    }
  }

  // 4. Every spec repeat/ending/navigation must project to a marker BOUND to the
  //    bar(s) the spec named, with the scalar attributes (repeat times, ending
  //    passes, jump from/until) the spec named — no drops, no extras, no
  //    misbindings. Counting kinds is not enough: a renderer can emit the right
  //    NUMBER of markers on the WRONG bars (or with wrong times/passes/from/
  //    until) and still satisfy a count check, so we compare full bindings.
  const want = toCounts(expectedMarkerSignatures(spec));
  const got = toCounts(actualMarkerSignatures(cal));
  for (const [sig, n] of want) {
    const g = got.get(sig) ?? 0;
    if (g < n) errors.push(`expected marker ${sig}${n > 1 ? ` (×${n})` : ''}, calibration has ${g}`);
  }
  for (const [sig, g] of got) {
    const n = want.get(sig) ?? 0;
    if (g > n) errors.push(`calibration has ${g - n} unexpected/misbound marker(s) ${sig}`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function toCounts(sigs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sigs) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
}

// The marker bindings the spec implies, as canonical signatures — kind + the
// ABSOLUTE bar number(s) the marker must sit on + its scalar attributes. Bar
// numbers are computed straight from the section bar-offset running total, fully
// independent of the renderer's own marker projection (buildMarkers): that
// independence is what lets this catch a renderer that miscounts or misplaces a
// marker.
function expectedMarkerSignatures(spec: RoadmapSpec): string[] {
  const sigs: string[] = [];

  // base[i] = absolute (1-based) number of section i's first bar.
  const base: number[] = [];
  let acc = 1;
  for (const s of spec.sections) {
    base.push(acc);
    acc += s.bars;
  }

  const refAbs = (ref: BarRef): string => {
    if (ref.section < 0 || ref.section >= spec.sections.length) return '?';
    const sec = spec.sections[ref.section];
    if (ref.bar < 1 || ref.bar > sec.bars) return '?';
    return String(base[ref.section] + ref.bar - 1);
  };

  spec.sections.forEach((s, i) => {
    const r = s.repeat;
    if (!r) return;
    sigs.push(`repeatStart@${base[i]}`);
    if (r.kind === 'plain') {
      sigs.push(`repeatEnd@${base[i] + s.bars - 1}×${r.times}`);
    } else {
      for (const e of r.endings) {
        const abs: number[] = [];
        for (let n = 0; n < e.bars.count; n += 1) abs.push(base[i] + e.bars.start - 1 + n);
        sigs.push(`ending@${abs.sort(numAsc).join(',')}#${[...e.passes].sort(numAsc).join('.')}`);
      }
    }
  });

  const nav = spec.navigation;
  if (nav) {
    if (nav.segno) sigs.push(`segno@${refAbs(nav.segno)}`);
    if (nav.coda) sigs.push(`coda@${refAbs(nav.coda)}`);
    if (nav.toCoda) sigs.push(`toCoda@${refAbs(nav.toCoda)}`);
    if (nav.fine) sigs.push(`fine@${refAbs(nav.fine)}`);
    if (nav.jump) sigs.push(`jump@${refAbs(nav.jump.at)} from:${nav.jump.from} until:${nav.jump.until}`);
  }

  return sigs;
}

// The same signatures recovered from the calibration: resolve each marker's
// barId(s) to absolute bar numbers via cal.bars, then render the identical
// canonical form so the two multisets can be diffed. A barId the calibration
// doesn't carry resolves to '?' so it can never spuriously match an expected one.
function actualMarkerSignatures(cal: ChartCalibration): string[] {
  const absOf = new Map<string, number>();
  for (const b of cal.bars ?? []) absOf.set(b.id, b.absNumber);
  const at = (id: string | undefined): string => (id != null && absOf.has(id) ? String(absOf.get(id)) : '?');

  const sigs: string[] = [];
  for (const m of cal.roadmap ?? []) {
    switch (m.kind) {
      case 'repeatStart':
        sigs.push(`repeatStart@${at(m.barId)}`);
        break;
      case 'repeatEnd':
        sigs.push(`repeatEnd@${at(m.barId)}×${m.times ?? 2}`);
        break;
      case 'ending': {
        const abs = m.barIds.map((id) => (absOf.has(id) ? String(absOf.get(id)) : '?'));
        const resolved = abs.every((x) => x !== '?') ? abs.map(Number).sort(numAsc).map(String) : abs;
        sigs.push(`ending@${resolved.join(',')}#${[...m.numbers].sort(numAsc).join('.')}`);
        break;
      }
      case 'segno':
        sigs.push(`segno@${at(m.barId)}`);
        break;
      case 'coda':
        sigs.push(`coda@${at(m.barId)}`);
        break;
      case 'toCoda':
        sigs.push(`toCoda@${at(m.barId)}`);
        break;
      case 'fine':
        sigs.push(`fine@${at(m.barId)}`);
        break;
      case 'jump':
        sigs.push(`jump@${at(m.barId)} from:${m.from} until:${m.until}`);
        break;
    }
  }
  return sigs;
}

function numAsc(a: number, b: number): number {
  return a - b;
}
