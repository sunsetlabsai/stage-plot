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

// ── Conductor 5b, chunk 2: the static-BPM motion rung (pure / MD-local) ───────
//
// (design-conductor-chunk5b-c2-motion.md.) Chunk 2 grows this file with the rung
// ladder's value set and the pure math the driver loop reads. Still no wire/broadcast
// (item 4) — these are MD-local. The full ClockRung contract is defined here (the stable
// type item 4 extends), but with NO telemetry input chunk 2 can only PRODUCE the bottom
// two rungs; live/coasting are added by item 4 when a tempo-telemetry input exists.

export type ClockRung = 'live' | 'coasting' | 'static-bpm' | 'manual';

// Chunk-2 rung resolution (§2). This is NOT a stub of a future computeRung — it is that
// function's chunk-2 domain: the WHOLE ladder reachable without telemetry. `manual` is the
// honest floor (loop emits nothing — the shipped 5a manual tap is the only motion) whenever
// the clock is off, no tempo is stated, the loop stalled, OR the song ended (vm.done). At
// song end a clock-driven advance is still `applied` (not ignored) and churns seq/updatedAt
// while owed only grows (Codex R3 HIGH) — gating on `done` idles the loop cleanly and reads
// honestly. `static-bpm` (on + stated bpm + not stalled + not done) dead-reckons forward.
export function computeStaticRung(args: {
  clockOn: boolean;
  bpm: number | null;
  stalled: boolean;
  done: boolean; // vm.done — song ended; nothing left to advance onto (Codex R3 HIGH)
}): ClockRung {
  if (!args.clockOn || args.bpm == null || args.stalled || args.done) return 'manual';
  return 'static-bpm';
}

// 5b chunk 3: the confidence gate (design-conductor-chunk5b-c3-confidence.md / parent §5.2).
// ≈ one phrase — the bound past which a dead-reckoned clock has drifted too far from the MD's
// last truth to AUTO-COMMIT a structural change. Reused ONLY here (the chunk-2 owed≥2 stall is a
// separate mechanism). The MD's align tap re-zeros barsSinceAnchor, refreshing the warrant.
export const CLOCK_CONFIDENCE_BOUND_BARS = 8;

// Is a CLOCK-placed (untrusted) arrival on an armed fireAt confident enough to AUTO-COMMIT? The
// confidence gate consults this ONLY when the arrival is untrusted (positionTrusted === false,
// §5.2) — a manual arrival fires unconditionally (the 5a floor). MOTION is never gated by this;
// only the structural auto-commit ("degrade precision, never honesty"). Pure / timer-free.
export function clockConfidenceOk(r: ClockReckoning, rung: ClockRung): boolean {
  if (r.alignedAtMs === null) return false; //                never trued — no human-confirmed anchor
  if (r.barsSinceAnchor > CLOCK_CONFIDENCE_BOUND_BARS) return false; // past the trust horizon
  switch (rung) {
    case 'static-bpm':
      return true; //   the stated-BPM click IS the warrant (no audio confidence to read)
    case 'live':
      return false; //  needs a sustained-HIGH telemetry input — extends here in item 4
    case 'coasting':
      return false; //  last-known tempo: motion yes, auto-commit no
    case 'manual':
      return false; //  5a floor — nothing machine-placed to be confident about
  }
}

// Re-baseline the MOTION axis only, on a tempo change (§4 / parent §5.6-ii). The closed-form
// `floor((now − motionBaselineAtMs)/barMs)` assumes a CONSTANT tempo since the baseline, so a
// new tempo must reset that baseline. A band speed change is NOT the MD asserting position, so
// the TRUST axis (anchor / barsSinceAnchor / alignedAtMs / positionTrusted) is left untouched;
// `barsAtMotionBaseline = barsSinceAnchor` captures the bars driven so far so past bars keep
// their true duration and the post-rebaseline `expected − barsSinceAnchor` is exactly 0 (no
// jump, no stall). The hook applies this THROUGH driverRef (Codex R2 HIGH) — see §4.
export function rebaselineMotion(r: ClockReckoning, newBpm: number, now: number): ClockReckoning {
  return {
    ...r,
    motionBaselineAtMs: now,
    baselineTempoBpm: newBpm,
    barsAtMotionBaseline: r.barsSinceAnchor,
  };
}

// The bars the clock SHOULD have driven by `now` under a static tempo: the whole bars elapsed
// since the motion baseline, offset by the bars already driven at that baseline (§3.1). The
// caller supplies barMs from lib/tempo.ts (60000·barBeats/bpm) so the math is timer-free and
// unit-testable; the driver compares this to the actual barsSinceAnchor to find owed advances.
export function expectedClockBars(r: ClockReckoning, now: number, barMs: number): number {
  return r.barsAtMotionBaseline + Math.floor((now - r.motionBaselineAtMs) / barMs);
}
