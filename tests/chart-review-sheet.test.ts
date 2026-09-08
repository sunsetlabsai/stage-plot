import { describe, it, expect } from 'vitest';
import {
  buildCandidates,
  currentSplit,
  dedupeCandidates,
  proposeFromCount,
  matchMeasuredSystem,
  refusalMessage,
  splitToPageBars,
  surplusWarning,
  CANDIDATE_DEDUPE_TOL,
} from '../lib/chart-review-sheet';
import { confirmSystemSplit, isValidCalibration } from '../lib/chart-calibration';
import { attributeMultirestsToBars } from '../lib/chart-measured';
import type { Bar, ChartCalibration, System } from '../lib/types';
import type { MeasuredCluster, MeasuredSystem } from '../lib/chart-measure';

// ── C3: what the review sheet DECIDES ────────────────────────────────────────

const W = 600;

function cl(x: number): MeasuredCluster {
  return { x, thick: false, w: 0.8, endMiss: 0 };
}
function msys(over: Partial<MeasuredSystem> = {}): MeasuredSystem {
  return {
    yTop: 100, yBot: 140, x0: 0, x1: 600,
    barlines: [], clusters: [cl(150), cl(300), cl(450), cl(600)],
    lineStartRepeat: false, spans: 4,
    bars: [
      { xStart: 0, xEnd: 150 }, { xStart: 150, xEnd: 300 },
      { xStart: 300, xEnd: 450 }, { xStart: 450, xEnd: 600 },
    ],
    printedNumber: 1, multirests: [], expectedSpans: 4, verdict: 'validated',
    ...over,
  };
}
function sys(): System {
  return { id: 'sysA', page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1, verdict: 'validated' };
}
function bars(xs: number[]): Bar[] {
  let left = 0;
  return xs.map((x, i) => {
    const b: Bar = { id: `b${i + 1}`, systemId: 'sysA', xStart: left, xEnd: x, absNumber: i + 1, sectionId: null };
    left = x;
    return b;
  });
}
function cal(over: Partial<ChartCalibration> = {}): ChartCalibration {
  return { schemaVersion: 3, status: 'draft', sections: [], systems: [sys()], bars: [], ...over };
}

describe('candidates', () => {
  it('reads the stored split off the bars in reading order', () => {
    const c = currentSplit(bars([0.25, 0.5, 0.75, 1]), 'sysA');
    expect(c.xs).toEqual([0.25, 0.5, 0.75, 1]);
    expect(c.sources).toEqual(['current']);
  });

  it('collapses two agreeing sources into ONE option, merging provenance', () => {
    const out = dedupeCandidates([
      { xs: [0.25, 0.5, 1], sources: ['current'] },
      { xs: [0.25, 0.5, 1], sources: ['measured'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(['current', 'measured']);
  });

  it('treats a sub-tolerance difference as the same picture, and a larger one as different', () => {
    const near = dedupeCandidates([
      { xs: [0.5, 1], sources: ['current'] },
      { xs: [0.5 + CANDIDATE_DEDUPE_TOL / 2, 1], sources: ['measured'] },
    ]);
    expect(near).toHaveLength(1);
    // NEGATIVE CONTROL — visibly different splits stay two options.
    const far = dedupeCandidates([
      { xs: [0.5, 1], sources: ['current'] },
      { xs: [0.5 + CANDIDATE_DEDUPE_TOL * 4, 1], sources: ['measured'] },
    ]);
    expect(far).toHaveLength(2);
  });

  it('a different bar COUNT is never the same picture', () => {
    const out = dedupeCandidates([
      { xs: [0.5, 1], sources: ['current'] },
      { xs: [0.33, 0.66, 1], sources: ['measured'] },
    ]);
    expect(out).toHaveLength(2);
  });

  it('never offers more than three', () => {
    const out = dedupeCandidates([
      { xs: [0.5, 1], sources: ['current'] },
      { xs: [0.3, 0.6, 1], sources: ['measured'] },
      { xs: [0.2, 0.4, 0.6, 1], sources: ['vlm'] },
      { xs: [0.1, 0.2, 0.3, 0.4, 1], sources: ['printed'] },
    ]);
    expect(out).toHaveLength(3);
  });

  it('drops an empty split rather than offering a zero-bar option', () => {
    expect(dedupeCandidates([{ xs: [], sources: ['measured'] }])).toHaveLength(0);
  });

  it('★ a measured chart normally yields exactly ONE candidate', () => {
    // Measurement replaced the VLM's geometry, so nothing competing was ever stored.
    // This is the owner-initiated shape, not a degenerate case.
    const stored = bars([0.25, 0.5, 0.75, 1]);
    const out = buildCandidates(stored, sys(), msys(), W);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(['current', 'measured']);
  });

  it('offers two when the stored split and a fresh measurement disagree', () => {
    const stored = bars([0.33, 0.66, 1]);
    const out = buildCandidates(stored, sys(), msys(), W);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.xs.length)).toEqual([3, 4]);
  });

  it('works with no measurement at all', () => {
    const out = buildCandidates(bars([0.5, 1]), sys(), null, W);
    expect(out).toHaveLength(1);
  });
});

describe('proposeFromCount', () => {
  it('proposes a normalized split and reports no surplus at the true count', () => {
    const r = proposeFromCount(msys(), W, 0.8, 4);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.xs).toEqual([0.25, 0.5, 0.75, 1]);
    expect(r.surplus).toBe(0);
  });

  it('★ reports the surplus on an UNDERCOUNT — the case geometry cannot catch', () => {
    const r = proposeFromCount(msys(), W, 0.8, 3);
    expect(r.kind).toBe('ok'); // accepted, exactly as the corpus measured
    if (r.kind !== 'ok') return;
    expect(r.surplus).toBe(1);
  });

  it('refuses an OVERCOUNT rather than inventing a barline', () => {
    const r = proposeFromCount(msys(), W, 0.8, 5);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.reason).toBe('insufficient-evidence');
    expect(r.available).toBe(4);
  });
});

describe('what the owner is told', () => {
  it('warns on a surplus, naming both numbers, and says nothing when there is none', () => {
    expect(surplusWarning(0, 4)).toBeNull();
    const msg = surplusWarning(1, 4);
    expect(msg).toContain('5 barlines');
    expect(msg).toContain('not 4');
  });

  it('never blames the count, and offers the hand-off instead', () => {
    const msg = refusalMessage('insufficient-evidence', 2);
    expect(msg).toContain('2 barlines');
    expect(msg).toMatch(/by hand/i);
  });

  it('gets singular and plural right — the count is in the sentence', () => {
    const one = refusalMessage('insufficient-evidence', 1);
    expect(one).toContain('1 barline');
    expect(one).not.toContain('barlines');
    expect(refusalMessage('insufficient-evidence', 3)).toContain('3 barlines');
  });

  it('uses no notation vocabulary anywhere in owner-facing copy', () => {
    // The frozen principle: the uploader is not a notation reader. "barline" is the one
    // allowed word — there is no plainer name for the thing they are looking at.
    const all = [
      surplusWarning(2, 3) ?? '',
      refusalMessage('insufficient-evidence', 2),
      refusalMessage('out-of-staff', 0),
      refusalMessage('degenerate-span', 0),
      refusalMessage('invalid-count', 0),
    ].join(' ');
    for (const banned of ['measure', 'span', 'multirest', 'cluster', 'system', 'stave', 'staff']) {
      expect(all.toLowerCase(), `"${banned}" leaked into owner copy`).not.toContain(banned);
    }
  });
});

describe('confirmSystemSplit', () => {
  it('writes the split, stamps `confirmed`, and validates at the DB boundary', () => {
    const c = cal({ bars: bars([0.5, 1]) });
    const out = confirmSystemSplit(c, 'sysA', [0.25, 0.5, 0.75, 1]);
    expect(out.systems?.[0].verdict).toBe('confirmed');
    expect(out.bars?.map((b) => b.xEnd)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(out.bars?.[0].xStart).toBe(0);
    expect(out.status).toBe('draft');
    expect(isValidCalibration(out)).toBe(true);
  });

  it('renumbers densely from the system start', () => {
    const out = confirmSystemSplit(cal({ bars: bars([0.5, 1]) }), 'sysA', [0.3, 0.6, 1]);
    expect(out.bars?.map((b) => b.absNumber)).toEqual([1, 2, 3]);
  });

  it('★ carries `measures` — the only path back to multirest counts', () => {
    const out = confirmSystemSplit(cal({ bars: bars([0.5, 1]) }), 'sysA', [0.5, 1], [4, 1]);
    expect(out.bars?.[0].measures).toBe(4);
    expect(out.bars?.[1].measures).toBeUndefined(); // 1 is the default, never written
    expect(isValidCalibration(out)).toBe(true);
  });

  it('rejects coordinates that are unordered, or past the system end', () => {
    const c = cal({ bars: bars([0.5, 1]) });
    expect(confirmSystemSplit(c, 'sysA', [0.6, 0.3])).toBe(c); // unordered
    expect(confirmSystemSplit(c, 'sysA', [0.5, 1.2])).toBe(c); // past xEnd
    expect(confirmSystemSplit(c, 'sysA', [0])).toBe(c); // not > xStart
    expect(confirmSystemSplit(c, 'sysA', [])).toBe(c); // empty
    expect(confirmSystemSplit(c, 'nope', [0.5])).toBe(c); // unknown system
  });

  it('leaves other systems and their bars untouched', () => {
    const two = cal({
      systems: [sys(), { id: 'sysB', page: 1, yTop: 0.5, yBottom: 0.6, xStart: 0, xEnd: 1, verdict: 'validated' }],
      bars: [...bars([0.5, 1]), { id: 'z1', systemId: 'sysB', xStart: 0, xEnd: 1, absNumber: 3, sectionId: null }],
    });
    const out = confirmSystemSplit(two, 'sysA', [0.5, 1]);
    expect(out.systems?.find((s) => s.id === 'sysB')?.verdict).toBe('validated');
    expect(out.bars?.find((b) => b.systemId === 'sysB')).toBeTruthy();
  });

  it('drops roadmap markers bound to the bars it replaced', () => {
    const c = cal({
      bars: bars([0.5, 1]),
      roadmap: [{ id: 'm1', kind: 'segno', barId: 'b1', edge: 'start' }],
    });
    const out = confirmSystemSplit(c, 'sysA', [0.5, 1]);
    expect(out.roadmap).toEqual([]);
  });
});

describe('measures re-derivation against a NEW split', () => {
  it('re-attributes a multirest onto the bar that now contains it', () => {
    const mrs = [{ count: 4, xStart: 160, xEnd: 290 }];
    const newBars = [
      { xStart: 0, xEnd: 150 }, { xStart: 150, xEnd: 300 }, { xStart: 300, xEnd: 600 },
    ];
    expect(attributeMultirestsToBars(mrs, newBars)).toEqual([1, 4, 1]);
  });

  it('refuses when the new split straddles the multirest', () => {
    // Containment, never best-overlap: a straddling H-bar has no placement, so the
    // counts are genuinely unknown rather than guessable.
    const mrs = [{ count: 4, xStart: 160, xEnd: 290 }];
    const straddle = [{ xStart: 0, xEnd: 200 }, { xStart: 200, xEnd: 600 }];
    expect(attributeMultirestsToBars(mrs, straddle)).toBeNull();
  });

  it('a split with no multirests attributes trivially', () => {
    expect(attributeMultirestsToBars([], [{ xStart: 0, xEnd: 1 }])).toEqual([1]);
  });
});

describe('matching a stored system to a fresh measurement', () => {
  const M = (yTop: number, yBot: number) => msys({ yTop, yBot });

  it('matches by vertical overlap, not by index', () => {
    // The stored system sits where measurement[1] is. Index matching would return the
    // FIRST measured system and hand the owner another line's barlines.
    const stored: System = { ...sys(), yTop: 0.5, yBottom: 0.6 };
    const measured = [M(100, 140), M(400, 480), M(600, 640)];
    const hit = matchMeasuredSystem(stored, measured, 800);
    expect(hit).toBe(measured[1]);
  });

  it('picks the LARGEST overlap when two candidates both touch', () => {
    const stored: System = { ...sys(), yTop: 0.5, yBottom: 0.6 };
    const slight = M(470, 490); // overlaps 0.5875..0.6 → 0.0125
    const most = M(400, 480); //   overlaps 0.5..0.6     → 0.1
    const hit = matchMeasuredSystem(stored, [slight, most], 800);
    expect(hit).toBe(most);
  });

  it('returns null when nothing overlaps — never a nearest-neighbour guess', () => {
    // The honest answer. A hand-added band with no measured counterpart must route the
    // count fallback to a refusal, not to some other line's geometry.
    const stored: System = { ...sys(), yTop: 0.8, yBottom: 0.9 };
    expect(matchMeasuredSystem(stored, [M(100, 140)], 800)).toBeNull();
  });

  it('returns null for a degenerate page height rather than dividing by zero', () => {
    expect(matchMeasuredSystem(sys(), [M(100, 140)], 0)).toBeNull();
    expect(matchMeasuredSystem(sys(), [], 800)).toBeNull();
  });
});

describe('splitToPageBars', () => {
  it('converts a normalized split into contiguous page-space bars', () => {
    const s: System = { ...sys(), xStart: 0.1, xEnd: 0.9 };
    expect(splitToPageBars(s, [0.5, 0.9], 600)).toEqual([
      { xStart: 60, xEnd: 300 },
      { xStart: 300, xEnd: 540 },
    ]);
  });

  it('round-trips through attribution — a multirest lands on the bar that holds it', () => {
    // The whole point of the conversion: multirests are measured in PAGE space, the
    // confirmed split arrives normalized, and the two have to meet.
    const s: System = { ...sys(), xStart: 0, xEnd: 1 };
    const pageBars = splitToPageBars(s, [0.25, 0.5, 1], 600);
    const mrs = [{ count: 4, xStart: 160, xEnd: 290 }];
    expect(attributeMultirestsToBars(mrs, pageBars)).toEqual([1, 4, 1]);
  });
});
