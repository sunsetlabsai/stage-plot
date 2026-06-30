import { describe, it, expect } from 'vitest';
import {
  initReckoning,
  reckonAfter,
  alignReckoning,
  computeStaticRung,
  clockConfidenceOk,
  CLOCK_CONFIDENCE_BOUND_BARS,
  rebaselineMotion,
  expectedClockBars,
  type ClockReckoning,
} from '../lib/conductor-clock';
import { barMs } from '../lib/tempo';
import type { TraversalStep } from '../lib/roadmap-vm';

// ── Conductor 5b chunk 1: the MD-LOCAL position-trust bookkeeping (pure) ──────
// reckonAfter is the single Invariant (P) chokepoint: re-anchor IFF the reduce produced
// a NEW current ({barId,pass} identity). These assert the WRITE discipline in isolation
// (no jsdom); the hook-binding tests prove the seams call it correctly.

const step = (barId: string, pass: number): TraversalStep => ({ barId, pass });

describe('initReckoning', () => {
  it('is the unconfirmed-start state (anchor null, never trued, untrusted)', () => {
    const r = initReckoning(1000);
    expect(r.anchor).toBeNull();
    expect(r.alignedAtMs).toBeNull();
    expect(r.positionTrusted).toBe(false);
    expect(r.barsSinceAnchor).toBe(0);
    expect(r.baselineTempoBpm).toBeNull(); // no tempo source in chunk 1
    expect(r.motionBaselineAtMs).toBe(1000);
    expect(r.barsAtMotionBaseline).toBe(0);
  });
});

describe("reckonAfter('manual')", () => {
  it('on a real move re-anchors BOTH axes and sets positionTrusted', () => {
    const r = initReckoning(0);
    const next = reckonAfter(r, null, step('b1', 1), 'manual', 5000);
    expect(next.anchor).toEqual({ barId: 'b1', pass: 1 });
    expect(next.barsSinceAnchor).toBe(0);
    expect(next.alignedAtMs).toBe(5000);
    expect(next.motionBaselineAtMs).toBe(5000);
    expect(next.barsAtMotionBaseline).toBe(0);
    expect(next.positionTrusted).toBe(true);
  });

  it('carries baselineTempoBpm across a POSITION re-anchor (only a tempo change re-baselines)', () => {
    const r: ClockReckoning = { ...initReckoning(0), baselineTempoBpm: 120 };
    const next = reckonAfter(r, step('b1', 1), step('b2', 1), 'manual', 7000);
    expect(next.baselineTempoBpm).toBe(120);
  });
});

describe('reckonAfter — Invariant (P) no-op guard (the R6/R7/R8 class)', () => {
  it('returns the input UNTOUCHED when current did not move (same {barId,pass})', () => {
    const r = reckonAfter(initReckoning(0), null, step('b5', 2), 'manual', 1000);
    const same = reckonAfter(r, step('b5', 2), step('b5', 2), 'manual', 9999);
    expect(same).toBe(r); // referential identity — nothing recomputed
  });

  it('both-null (a dead advance / disarm) is a no-op', () => {
    const r = initReckoning(0);
    expect(reckonAfter(r, null, null, 'manual', 9999)).toBe(r);
  });

  it('treats a genuine repeat re-emit ({b,1}→{b,2}) as a MOVE that re-anchors', () => {
    const r = reckonAfter(initReckoning(0), null, step('b2', 1), 'manual', 1000);
    const next = reckonAfter(r, step('b2', 1), step('b2', 2), 'manual', 2000);
    expect(next).not.toBe(r);
    expect(next.anchor).toEqual({ barId: 'b2', pass: 2 });
    expect(next.alignedAtMs).toBe(2000);
  });

  it('treats a null-transition ({b,2}→{b,2}) as a no-op', () => {
    const r = reckonAfter(initReckoning(0), null, step('b2', 2), 'manual', 1000);
    expect(reckonAfter(r, step('b2', 2), step('b2', 2), 'manual', 2000)).toBe(r);
  });
});

describe("reckonAfter('autofire') — machine-placed, no double-count", () => {
  it('flips ONLY positionTrusted=false; the whole trust + motion axes are unchanged', () => {
    // Prior MANUAL arrival placed b6 pass3 → anchor there, trusted.
    const manual = reckonAfter(initReckoning(0), null, step('b6', 3), 'manual', 1000);
    // Chained auto-fire commit moves current onto b7 — but anchor stays the last HUMAN anchor.
    const after = reckonAfter(manual, step('b6', 3), step('b7', 1), 'autofire', 2000);
    expect(after.positionTrusted).toBe(false);
    expect(after.anchor).toEqual({ barId: 'b6', pass: 3 }); // NOT b7
    expect(after.barsSinceAnchor).toBe(manual.barsSinceAnchor);
    expect(after.alignedAtMs).toBe(manual.alignedAtMs);
    expect(after.motionBaselineAtMs).toBe(manual.motionBaselineAtMs);
    expect(after.barsAtMotionBaseline).toBe(manual.barsAtMotionBaseline);
  });
});

describe("reckonAfter('clock') — the chunk-2 row (asserted now so chunk 2 adds a consumer, not a reshape)", () => {
  it('increments barsSinceAnchor, untrusts, leaves anchor + alignedAtMs untouched', () => {
    const manual = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000);
    const after = reckonAfter(manual, step('b1', 1), step('b2', 1), 'clock', 2000);
    expect(after.barsSinceAnchor).toBe(1);
    expect(after.positionTrusted).toBe(false);
    expect(after.anchor).toEqual({ barId: 'b1', pass: 1 });
    expect(after.alignedAtMs).toBe(1000); // not re-trued by a clock advance
  });
});

describe('alignReckoning — mid-song true-up', () => {
  it('re-zeros onto the passed step, trusted, without needing a move', () => {
    const drifted = reckonAfter(initReckoning(0), null, step('b9', 1), 'clock', 1000);
    const trued = alignReckoning(drifted, step('b9', 1), 8000);
    expect(trued.anchor).toEqual({ barId: 'b9', pass: 1 });
    expect(trued.barsSinceAnchor).toBe(0);
    expect(trued.alignedAtMs).toBe(8000);
    expect(trued.motionBaselineAtMs).toBe(8000);
    expect(trued.barsAtMotionBaseline).toBe(0);
    expect(trued.positionTrusted).toBe(true);
  });
});

// ── Conductor 5b chunk 2: the static-BPM motion rung math (pure) ─────────────

describe('computeStaticRung — the chunk-2 ladder domain (§2)', () => {
  it('static-bpm only when clock on + stated bpm + not stalled + not done', () => {
    expect(computeStaticRung({ clockOn: true, bpm: 120, stalled: false, done: false })).toBe(
      'static-bpm',
    );
  });

  it('falls to manual when the clock is off', () => {
    expect(computeStaticRung({ clockOn: false, bpm: 120, stalled: false, done: false })).toBe(
      'manual',
    );
  });

  it('falls to manual when no bpm is stated (legacy/inline song ⇒ null)', () => {
    expect(computeStaticRung({ clockOn: true, bpm: null, stalled: false, done: false })).toBe(
      'manual',
    );
  });

  it('falls to manual while stalled (loop suspended — honest readout)', () => {
    expect(computeStaticRung({ clockOn: true, bpm: 120, stalled: true, done: false })).toBe(
      'manual',
    );
  });

  it('falls to manual at song end (vm.done — Codex R3 HIGH, no phantom stall)', () => {
    expect(computeStaticRung({ clockOn: true, bpm: 120, stalled: false, done: true })).toBe(
      'manual',
    );
  });
});

describe('rebaselineMotion — motion axis only, trust axis untouched (§4)', () => {
  it('sets motionBaselineAtMs/baselineTempoBpm and captures barsAtMotionBaseline=barsSinceAnchor', () => {
    // Drive 3 clock bars off a 120-bpm baseline, then change tempo to 140.
    let r = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000);
    r = reckonAfter(r, step('b1', 1), step('b2', 1), 'clock', 2000);
    r = reckonAfter(r, step('b2', 1), step('b3', 1), 'clock', 3000);
    r = reckonAfter(r, step('b3', 1), step('b4', 1), 'clock', 4000);
    expect(r.barsSinceAnchor).toBe(3);
    const re = rebaselineMotion(r, 140, 5000);
    expect(re.motionBaselineAtMs).toBe(5000);
    expect(re.baselineTempoBpm).toBe(140);
    expect(re.barsAtMotionBaseline).toBe(3); // = barsSinceAnchor at the change
  });

  it('leaves the trust axis (barsSinceAnchor / alignedAtMs / anchor / positionTrusted) unchanged', () => {
    const r = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000);
    const re = rebaselineMotion(r, 140, 5000);
    expect(re.barsSinceAnchor).toBe(r.barsSinceAnchor);
    expect(re.alignedAtMs).toBe(r.alignedAtMs);
    expect(re.anchor).toEqual(r.anchor);
    expect(re.positionTrusted).toBe(r.positionTrusted);
  });

  it('drops owed to exactly 0 right after a tempo change (no jump / no stall)', () => {
    let r = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000);
    r = reckonAfter(r, step('b1', 1), step('b2', 1), 'clock', 1500);
    const re = rebaselineMotion(r, 140, 5000);
    // immediately after the change, no time has elapsed at the new baseline:
    expect(expectedClockBars(re, 5000, barMs(140)) - re.barsSinceAnchor).toBe(0);
  });
});

// ── Conductor 5b chunk 3: the confidence gate (pure) ─────────────────────────
// clockConfidenceOk is consulted ONLY for an UNTRUSTED (clock-placed) arrival; a trusted
// arrival fires unconditionally (the gate ORs positionTrusted before calling this — §5.2).

describe('clockConfidenceOk — the chunk-3 confidence gate (§5.2)', () => {
  // A trued, clock-placed reckoning at a given distance from the last human anchor.
  const trued = (barsSinceAnchor: number): ClockReckoning => ({
    ...reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000), // alignedAtMs = 1000
    barsSinceAnchor,
    positionTrusted: false, // the clock placed the current bar
  });

  it('refuses when never trued (alignedAtMs === null) — no human-confirmed anchor', () => {
    const untrued: ClockReckoning = { ...initReckoning(0), barsSinceAnchor: 1 }; // alignedAtMs null
    expect(clockConfidenceOk(untrued, 'static-bpm')).toBe(false);
  });

  it('static-bpm within the bound is confident (the click is the warrant)', () => {
    expect(clockConfidenceOk(trued(0), 'static-bpm')).toBe(true);
    expect(clockConfidenceOk(trued(CLOCK_CONFIDENCE_BOUND_BARS), 'static-bpm')).toBe(true); // 8 ⇒ ok
  });

  it('refuses once barsSinceAnchor exceeds the bound (drifted too far from the last truth)', () => {
    expect(clockConfidenceOk(trued(CLOCK_CONFIDENCE_BOUND_BARS + 1), 'static-bpm')).toBe(false); // 9 ⇒ no
  });

  it('coasting / manual / live never auto-fire in this chunk (no telemetry warrant yet)', () => {
    expect(clockConfidenceOk(trued(0), 'coasting')).toBe(false);
    expect(clockConfidenceOk(trued(0), 'manual')).toBe(false);
    expect(clockConfidenceOk(trued(0), 'live')).toBe(false); // HIGH-confidence input arrives in item 4
  });
});

describe('expectedClockBars — the timer-free closed form (§3.1)', () => {
  it('is 0 before one bar has elapsed since the baseline', () => {
    const r = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000); // baseline 1000
    const bm = barMs(120); // 2000 ms/bar at 120 bpm 4/4
    expect(expectedClockBars(r, 1000 + bm - 1, bm)).toBe(0);
  });

  it('is exact at the bar boundary', () => {
    const r = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000);
    const bm = barMs(120);
    expect(expectedClockBars(r, 1000 + bm, bm)).toBe(1);
    expect(expectedClockBars(r, 1000 + 3 * bm, bm)).toBe(3);
  });

  it('adds the barsAtMotionBaseline offset (bars driven before the current baseline)', () => {
    const r = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 1000);
    const re = rebaselineMotion(r, 120, 5000); // barsAtMotionBaseline = 0 here (no clock bars yet)
    const shifted: ClockReckoning = { ...re, barsAtMotionBaseline: 4 };
    const bm = barMs(120);
    expect(expectedClockBars(shifted, 5000 + 2 * bm, bm)).toBe(6); // 4 + 2
  });

  it('honours a non-4/4 barMs (3/4 bar is shorter at the same bpm)', () => {
    const r = reckonAfter(initReckoning(0), null, step('b1', 1), 'manual', 0);
    const bm34 = barMs(120, 3); // 1500 ms/bar
    expect(expectedClockBars(r, 1500, bm34)).toBe(1);
    expect(expectedClockBars(r, 4500, bm34)).toBe(3);
  });
});
