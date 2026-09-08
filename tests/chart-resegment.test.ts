import { describe, it, expect } from 'vitest';
import { resegment, clusterScore, type ResegmentInput } from '../lib/chart-resegment';
import type { MeasuredCluster } from '../lib/chart-measure';

// ── C4 re-segmentation ───────────────────────────────────────────────────────
//
// Both review rounds on this design found the same class of bug: a segmentation that is
// fully "observed" and still wrong. So the tests here are organized around the two
// concrete traps rather than around the happy path, and each has a NEGATIVE CONTROL —
// the neighbouring input that must NOT produce the same answer.

const MODAL = 0.8;

/** A clean modal barline at x, with perfect endpoints unless told otherwise. */
function cl(x: number, over: Partial<MeasuredCluster> = {}): MeasuredCluster {
  return { x, thick: false, w: MODAL, endMiss: 0, ...over };
}

function input(over: Partial<ResegmentInput> = {}): ResegmentInput {
  return { clusters: [], lineStartRepeat: false, x0: 0, x1: 100, modalWidth: MODAL, ...over };
}

describe('resegment — the endpoint contract', () => {
  it('reproduces the forced split when the cluster count already matches', () => {
    const r = resegment(input({ clusters: [cl(25), cl(50), cl(75)] }), 3);
    expect(r.ok).toBe(true);
    expect(r.available).toBe(3); // available === n ⇒ the answer was FORCED
    expect(r.bars).toEqual([
      { xStart: 0, xEnd: 25 },
      { xStart: 25, xEnd: 50 },
      { xStart: 50, xEnd: 75 },
    ]);
  });

  it('★ TRAP 2: a wrong N+1 cannot be reached by promoting the trailing barline', () => {
    // The hole Codex R2 found. With 3 clusters the honest answer is 3 spans. Asking for 4
    // must FAIL — not succeed by making the staff edge x1 a fourth right edge.
    const r = resegment(input({ clusters: [cl(25), cl(50), cl(75)] }), 4);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-evidence');
    expect(r.available).toBe(3);
    // NEGATIVE CONTROL: the same geometry with a real fourth barline DOES give 4.
    const ok = resegment(input({ clusters: [cl(25), cl(50), cl(75), cl(100)] }), 4);
    expect(ok.ok).toBe(true);
    expect(ok.bars?.[3]).toEqual({ xStart: 75, xEnd: 100 });
  });

  it('never emits a span whose right edge is the staff edge rather than a cluster', () => {
    const r = resegment(input({ clusters: [cl(25), cl(50)], x1: 100 }), 2);
    expect(r.ok).toBe(true);
    expect(r.bars?.every((b) => b.xEnd !== 100)).toBe(true);
    expect(r.bars?.at(-1)?.xEnd).toBe(50); // the tail past the last barline is NOT a span
  });

  it('the staff start IS a legal leading edge — the only non-cluster edge there is', () => {
    const r = resegment(input({ clusters: [cl(40)], x0: 10 }), 1);
    expect(r.ok).toBe(true);
    expect(r.bars).toEqual([{ xStart: 10, xEnd: 40 }]);
  });
});

describe('resegment — the begin-repeat trap', () => {
  it('★ TRAP 1: the line-start begin-repeat cluster is not available as a divider', () => {
    // Codex R1's counterexample. Clusters at 10 (the begin-repeat), 50, 90. With the
    // repeat consuming the leading edge, only 50 and 90 are right edges, so N=2 must span
    // 10→50→90 and must NOT produce 0→10, 10→50.
    const r = resegment(
      input({ clusters: [cl(10, { thick: true }), cl(50), cl(90)], x0: 0, lineStartRepeat: true }),
      2,
    );
    expect(r.ok).toBe(true);
    expect(r.bars).toEqual([
      { xStart: 10, xEnd: 50 },
      { xStart: 50, xEnd: 90 },
    ]);
  });

  it('the same clusters WITHOUT the repeat flag segment differently — the control', () => {
    // Identical positions; only the stage-2 decision differs. This is the fact no set of
    // raw verticals carries, and the reason `lineStartRepeat` is an input.
    const r = resegment(
      input({ clusters: [cl(10, { thick: true }), cl(50), cl(90)], x0: 0, lineStartRepeat: true }),
      2,
    );
    const flat = resegment(input({ clusters: [cl(10, { thick: true }), cl(50), cl(90)] }), 3);
    expect(flat.bars).toEqual([
      { xStart: 0, xEnd: 10 },
      { xStart: 10, xEnd: 50 },
      { xStart: 50, xEnd: 90 },
    ]);
    expect(r.bars).not.toEqual(flat.bars);
  });

  it('a begin-repeat system needs one MORE cluster than a flat one for the same N', () => {
    const withRepeat = input({ clusters: [cl(10, { thick: true }), cl(50)], lineStartRepeat: true });
    expect(resegment(withRepeat, 2).ok).toBe(false);
    expect(resegment(withRepeat, 1).ok).toBe(true);
  });
});

describe('resegment — ranking surplus candidates', () => {
  it('drops the weakest cluster when there is one too many', () => {
    // A stray with badly-missed endpoints is the false positive; the clean ones survive.
    const r = resegment(
      input({ clusters: [cl(25), cl(40, { endMiss: 1.1 }), cl(75)] }),
      2,
    );
    expect(r.ok).toBe(true);
    expect(r.bars?.map((b) => b.xEnd)).toEqual([25, 75]);
  });

  it('drops an off-modal-width cluster over a modal one', () => {
    const r = resegment(
      input({ clusters: [cl(25), cl(40, { w: MODAL + 0.11 }), cl(75)] }),
      2,
    );
    expect(r.bars?.map((b) => b.xEnd)).toEqual([25, 75]);
  });

  it('does NOT penalize a thick stroke for being off-modal — it is a repeat bar', () => {
    // A final/repeat barline is legitimately off-modal by a different rule. Ranking it
    // below a note stem would drop real barlines first.
    const r = resegment(
      input({ clusters: [cl(25, { thick: true, w: 2.5 }), cl(40, { endMiss: 1.1 }), cl(75)] }),
      2,
    );
    expect(r.bars?.map((b) => b.xEnd)).toEqual([25, 75]);
  });

  it('keeps reading order after ranking', () => {
    const r = resegment(
      input({ clusters: [cl(20, { endMiss: 0.9 }), cl(45), cl(60), cl(80, { endMiss: 0.9 })] }),
      2,
    );
    expect(r.bars?.map((b) => b.xEnd)).toEqual([45, 60]);
  });

  it('is deterministic when every candidate scores identically', () => {
    const cs = [cl(20), cl(40), cl(60), cl(80)];
    const a = resegment(input({ clusters: cs }), 2);
    const b = resegment(input({ clusters: [...cs] }), 2);
    expect(a.bars).toEqual(b.bars);
    expect(a.bars?.map((x) => x.xEnd)).toEqual([20, 40]); // ties break on reading order
  });

  it('clusterScore ranks better evidence higher, and is exempt for thick strokes', () => {
    expect(clusterScore(cl(0), MODAL)).toBeGreaterThan(clusterScore(cl(0, { endMiss: 1 }), MODAL));
    expect(clusterScore(cl(0), MODAL)).toBeGreaterThan(clusterScore(cl(0, { w: MODAL + 0.2 }), MODAL));
    expect(clusterScore(cl(0, { thick: true, w: 3 }), MODAL)).toBe(clusterScore(cl(0), MODAL));
  });
});

describe('resegment — refusals', () => {
  it('refuses rather than inventing when evidence is short', () => {
    const r = resegment(input({ clusters: [cl(50)] }), 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-evidence');
    expect(r.bars).toBeUndefined();
  });

  it('refuses a count that is not a positive integer', () => {
    for (const n of [0, -1, 1.5, NaN]) {
      expect(resegment(input({ clusters: [cl(25), cl(50)] }), n).reason).toBe('invalid-count');
    }
  });

  it('drops a cluster at or before the leading edge rather than spanning backwards', () => {
    const r = resegment(input({ clusters: [cl(0), cl(50)], x0: 0 }), 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-evidence');
    expect(r.available).toBe(1);
  });

  it('refuses a degenerate span if clusters ever arrive out of order', () => {
    // Defensive: the contract says left-to-right, and the bounds filter makes this
    // unreachable for well-formed input. Kept because a caller error here would otherwise
    // emit a negative-width bar into a permanent, human-confirmed calibration.
    const r = resegment(input({ clusters: [cl(60), cl(30)], x0: 0, x1: 100 }), 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('degenerate-span');
  });

  it('★ a cluster OUTSIDE the staff can never become a right edge', () => {
    // verticalsOnStaff admits on y-endpoints alone and never checks x, so a stroke well
    // right of the staff (a bracket, page furniture, a neighbouring rule) is an ordinary
    // cluster. Before the bounds filter this returned ok with a bar ending at 150.
    const r = resegment(input({ clusters: [cl(25), cl(50), cl(150)], x0: 0, x1: 100 }), 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-evidence');
    expect(r.available).toBe(2);
    // NEGATIVE CONTROL: the same three clusters inside a staff that really is that wide.
    const ok = resegment(input({ clusters: [cl(25), cl(50), cl(150)], x0: 0, x1: 200 }), 3);
    expect(ok.ok).toBe(true);
    expect(ok.bars?.at(-1)?.xEnd).toBe(150);
  });

  it('every returned bar stays within [leading, x1]', () => {
    const r = resegment(input({ clusters: [cl(25), cl(50), cl(99)], x0: 10, x1: 100 }), 3);
    expect(r.ok).toBe(true);
    expect(r.bars?.every((b) => b.xStart >= 10 && b.xEnd <= 100)).toBe(true);
  });

  it('a barline exactly ON the staff end is legal — the boundary is inclusive', () => {
    const r = resegment(input({ clusters: [cl(50), cl(100)], x0: 0, x1: 100 }), 2);
    expect(r.ok).toBe(true);
    expect(r.bars?.at(-1)?.xEnd).toBe(100);
  });

  it('handles an empty system without throwing', () => {
    expect(resegment(input({ clusters: [] }), 1).reason).toBe('insufficient-evidence');
    expect(resegment(input({ clusters: [], lineStartRepeat: true }), 1).ok).toBe(false);
  });
});
