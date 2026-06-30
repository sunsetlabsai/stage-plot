import type { TraversalStep } from './roadmap-vm';

// ── Conductor 5b, chunk 1: the clock layer's home — position authority ────────
//
// (design-conductor-chunk5b-c1-align.md; parent design-conductor-chunk5b-clock.md.)
// "Clock owns speed, MD owns place." This is the MD-LOCAL `ClockReckoning` and the
// single Invariant (P) chokepoint that decides, on EVERY dispatch, whether position
// trust re-anchors — re-anchor IFF the reduce produced a new `current`. The reckoning
// is NEVER broadcast (parent §9 — "not a new wire type"); no change to conductor-state
// or conductor-session. Chunk 2 grows this file with the ConductorClock wire shape, the
// §4.1 degrade ladder, and the motion driver; chunk 3 is the first READER of
// positionTrusted (the confidence gate). Chunk 1 only WRITES the bookkeeping + the one
// human gesture (align / true-up) that asserts "we are here, on the downbeat, now."

export type ClockProvenance = 'manual' | 'autofire' | 'clock'; // 'clock' reserved for chunk 2

export interface ClockReckoning {
  // The last TRUST (human) anchor — the step a MANUAL re-anchor last re-zeroed onto
  // (parent §5.1). It moves ONLY on a manual re-anchor (advance / align / Go-now /
  // future seek); a MACHINE placement (autofire / clock) NEVER writes it — `current`
  // (in ConductorState) already carries the machine-placed position, so anchor stays
  // unambiguously "last human anchor", in lockstep with alignedAtMs + barsSinceAnchor.
  // null ⇔ "no human/trust anchor ever asserted" — the §5.2 unconfirmed-start state, in
  // lockstep with alignedAtMs === null. (A machine placement can move `current` while
  // anchor stays null; it is `current`, not anchor, that tracks position.)
  anchor: { barId: string; pass: number } | null;
  // ── trust axis (resets ONLY on a real MD position gesture) ──
  barsSinceAnchor: number; // +1 per CLOCK-driven advance (chunk 2); 0 at re-anchor
  alignedAtMs: number | null; // MD-clock instant of the last MD gesture; null ⇒ never trued
  // ── motion axis (re-baselines on tempo change too — chunk 2 reads/re-baselines) ──
  motionBaselineAtMs: number; // re-zeroed by a position re-anchor; inert until chunk 2
  baselineTempoBpm: number | null; // null in chunk 1 (no tempo plumbed yet); chunk 2 fills
  barsAtMotionBaseline: number;
  // ── arrival provenance ──
  positionTrusted: boolean; // true ⇒ current was MANUAL-placed; false ⇒ MACHINE-placed
}

// The pre-first-anchor init form: anchor null, never trued, nothing placed yet.
export function initReckoning(now: number): ClockReckoning {
  return {
    anchor: null,
    barsSinceAnchor: 0,
    alignedAtMs: null, // never trued
    motionBaselineAtMs: now,
    baselineTempoBpm: null, // no tempo source in chunk 1
    barsAtMotionBaseline: 0,
    positionTrusted: false, // nothing placed yet
  };
}

// Step identity is {barId, pass}, NOT barId alone: `cursor` is revisited (repeats /
// voltas / D.S.), so the same barId re-emits with an incremented pass — a genuine move
// that SHOULD re-anchor. Only the reducer's `?? state.current` null-transition rows
// leave {barId, pass} identical and correctly no-op.
function sameStep(a: TraversalStep | null, b: TraversalStep | null): boolean {
  if (a === null || b === null) return a === b;
  return a.barId === b.barId && a.pass === b.pass;
}

// Invariant (P), as ONE chokepoint every dispatch flows through (parent §5.2; the R6/R7/R8
// per-caller-stale-trust class, closed by construction). Mutate IFF the reduce produced a
// NEW current; otherwise return the reckoning untouched — this single guard is what makes
// "a redirect doesn't re-anchor", "a no-armed/stale commit doesn't re-anchor", and "a dead
// advance at song end doesn't re-anchor" all fall out for free. Provenance is consulted ONLY
// when current actually moved, so mis-tagging a non-moving seam is harmless.
export function reckonAfter(
  r: ClockReckoning,
  beforeCurrent: TraversalStep | null,
  afterCurrent: TraversalStep | null,
  provenance: ClockProvenance,
  now: number,
): ClockReckoning {
  if (sameStep(beforeCurrent, afterCurrent)) return r;
  // current changed — afterCurrent is non-null (a write only ever sets a real step).
  const cur = afterCurrent!;
  switch (provenance) {
    case 'manual': // manual advance / Go-now commit / (future) seek: full re-anchor, both axes
      return {
        anchor: { barId: cur.barId, pass: cur.pass },
        barsSinceAnchor: 0,
        alignedAtMs: now,
        motionBaselineAtMs: now,
        baselineTempoBpm: r.baselineTempoBpm, // a POSITION re-anchor carries tempo (only a
        barsAtMotionBaseline: 0, //              TEMPO change re-baselines it — chunk 2)
        positionTrusted: true,
      };
    case 'autofire': // chained auto-fire commit: MACHINE-placed. Flips provenance ONLY — the
      return {
        ...r, //         whole TRUST axis (anchor / barsSinceAnchor / alignedAtMs) AND the
        positionTrusted: false, // motion axis stay at the arrival's values (no double-count
      }; //              stall, parent §5.2); anchor stays the last HUMAN anchor.
    case 'clock': // reserved for chunk 2's driver — not emitted in chunk 1. Counts ONE
      return {
        ...r, //         clock-driven bar SINCE the human anchor; anchor + alignedAtMs untouched.
        barsSinceAnchor: r.barsSinceAnchor + 1,
        positionTrusted: false,
      };
  }
}

// The align / true-up tap, mid-song mechanic: re-zero the reckoning ONTO the existing
// `current` (it NEVER moves current — β forward-only, and a non-moving re-zero is trivially
// neither forward nor backward). The seed-the-start mechanic (current === null) lives in the
// hook, where it dispatches the first manual advance (the only way to place current on the
// shipped wire), which re-anchors via reckonAfter('manual').
export function alignReckoning(r: ClockReckoning, current: TraversalStep, now: number): ClockReckoning {
  return {
    anchor: { barId: current.barId, pass: current.pass },
    barsSinceAnchor: 0,
    alignedAtMs: now,
    motionBaselineAtMs: now,
    baselineTempoBpm: r.baselineTempoBpm,
    barsAtMotionBaseline: 0,
    positionTrusted: true,
  };
}
