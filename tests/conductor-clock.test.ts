import { describe, it, expect } from 'vitest';
import {
  initReckoning,
  reckonAfter,
  alignReckoning,
  type ClockReckoning,
} from '../lib/conductor-clock';
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
