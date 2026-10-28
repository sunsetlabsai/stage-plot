import { describe, it, expect } from 'vitest';
import {
  buildCandidates,
  candidateNote,
  currentSplit,
  dedupeCandidates,
  proposeFromCount,
  reviewSheetKey,
  matchMeasuredSystem,
  refusalMessage,
  splitToPageBars,
  surplusWarning,
  countReadiness,
  proposeCountForSystem,
  REFUSAL_REASONS,
  CANDIDATE_DEDUPE_TOL,
} from '../lib/chart-review-sheet';
import { confirmSystemSplit, isValidCalibration, splitFitsSystem } from '../lib/chart-calibration';
import { attributeMultirestsToBars } from '../lib/chart-measured';
import type { Bar, ChartCalibration, System } from '../lib/types';
import type { MeasuredCluster, MeasuredSystem } from '../lib/chart-measure';

// ── C3: what the review sheet DECIDES ────────────────────────────────────────

const W = 600;
/** The page facts `buildCandidates` needs: width to normalize by, modal width to score by. */
const PAGE = { pageWidth: W, modalWidth: 0.8 };

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
      { xs: [0.2, 0.4, 0.6, 1], sources: ['printed'] },
      { xs: [0.1, 0.2, 0.3, 0.4, 1], sources: ['current'] },
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
    const out = buildCandidates(stored, sys(), msys(), PAGE);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(['current', 'measured']);
  });

  it('offers two when the stored split and a fresh measurement disagree', () => {
    const stored = bars([0.33, 0.66, 1]);
    const out = buildCandidates(stored, sys(), msys(), PAGE);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.xs.length)).toEqual([3, 4]);
  });

  it('works with no measurement at all', () => {
    const out = buildCandidates(bars([0.5, 1]), sys(), null, PAGE);
    expect(out).toHaveLength(1);
  });

  it('★ offers the printed-number-implied split on the exact system the sheet exists for', () => {
    // THE `uncertain` CASE (Codex M1, #184 — this candidate was specified and never
    // built). A spurious vertical at x=220 made the engine see FIVE spans while the
    // chart's own printed measure numbers say four, which is precisely how
    // `measurePage` assigns `uncertain`. Stored === measured === the same known-wrong
    // picture, so without this the sheet's only offer is "Yes, 5 bars" — and stamping
    // `confirmed` on it is permanent under generate-once.
    const spurious: MeasuredCluster = { x: 220, thick: false, w: 0.3, endMiss: 3 };
    const m = msys({
      clusters: [cl(150), spurious, cl(300), cl(450), cl(600)],
      spans: 5,
      bars: [
        { xStart: 0, xEnd: 150 }, { xStart: 150, xEnd: 220 }, { xStart: 220, xEnd: 300 },
        { xStart: 300, xEnd: 450 }, { xStart: 450, xEnd: 600 },
      ],
      expectedSpans: 4,
      verdict: 'uncertain',
    });
    const stored = bars([0.25, 220 / 600, 0.5, 0.75, 1]);
    const out = buildCandidates(stored, sys(), m, PAGE);
    expect(out).toHaveLength(2);
    const printed = out.find((c) => c.sources.includes('printed'));
    // The weakest vertical is the one dropped — every remaining edge is a real barline.
    expect(printed?.xs).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('adds no printed option when the printed numbers agree with the geometry', () => {
    // NEGATIVE CONTROL for the test above: `validated` means expectedSpans === spans,
    // and a second identical picture is not a choice.
    const out = buildCandidates(bars([0.25, 220 / 600, 0.5, 0.75, 1]), sys(), msys(), PAGE);
    expect(out.some((c) => c.sources.includes('printed'))).toBe(false);
  });

  it('stays silent rather than inventing when the printed count has too little evidence', () => {
    // expectedSpans of 6 over 4 clusters: `resegment` refuses, and a refusal is not an
    // option the owner gets shown. The count fallback is the honest route from here.
    const out = buildCandidates(bars([0.5, 1]), sys(), msys({ expectedSpans: 6 }), PAGE);
    expect(out.some((c) => c.sources.includes('printed'))).toBe(false);
  });

  it('names the printed option in words the owner can check against the paper', () => {
    expect(candidateNote({ xs: [0.5, 1], sources: ['printed'] })).toMatch(/printed on your chart/);
    // Machine biography stays off-screen — there is nothing a non-reader can do with it.
    expect(candidateNote({ xs: [0.5, 1], sources: ['current', 'measured'] })).toBeNull();
  });
});

describe('reviewSheetKey — what an open sheet is about', () => {
  const base = { gen: 4, hash: 'abc', systemId: 's1' };

  it('★ separates two charts that both call their first line `s1`', () => {
    // THE H1 SHAPE. Measured system ids are assigned by position, so `systemId` alone is
    // not identity — every measured chart has an `s1`. This is the whole reason the key
    // exists, on both the commit guard and the React key.
    expect(reviewSheetKey(base)).not.toBe(reviewSheetKey({ ...base, gen: 5 }));
  });

  it('separates two byte-versions of the SAME chart', () => {
    // Not redundant with `gen`: the overlay build's stale-cache recovery swaps the
    // document and the hash without bumping the chart-load generation.
    expect(reviewSheetKey(base)).not.toBe(reviewSheetKey({ ...base, hash: 'def' }));
  });

  it('separates two lines of the same chart', () => {
    // THE R2 SHAPE. Walking the flag queue re-points the sheet at the next system without
    // unmounting it; a key that did not move here would hand the new line the old line's
    // half-finished answer.
    expect(reviewSheetKey(base)).not.toBe(reviewSheetKey({ ...base, systemId: 's2' }));
  });

  it('is stable for the same line of the same bytes, so an open sheet is not reset', () => {
    expect(reviewSheetKey(base)).toBe(reviewSheetKey({ ...base }));
  });

  it('an absent hash cannot collide with a present one, or with another field', () => {
    // A pre-calibration sheet has no hash yet. `null` must not stringify into something a
    // real hash could equal, and no field's value may bleed across the separator.
    expect(reviewSheetKey({ ...base, hash: null })).not.toBe(reviewSheetKey(base));
    expect(reviewSheetKey({ gen: 1, hash: null, systemId: 's1' })).not.toBe(
      reviewSheetKey({ gen: 1, hash: '', systemId: ':s1' }),
    );
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
      ...REFUSAL_REASONS.map((r) => refusalMessage(r, 2)),
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
    const out = confirmSystemSplit(c, 'sysA', [0.4, 1]);
    expect(out.roadmap).toEqual([]);
  });

  // ★ "Yes, 4 bars" is the commonest answer and it changes no geometry (Codex R3, #184).
  // Minting fresh ids for it pruned every roadmap marker on the line and wiped its
  // section assignments, silently, on the next Save.
  it('★ a bar whose edges did not move keeps its id, its section and its markers', () => {
    const c = cal({
      bars: bars([0.5, 1]).map((b) => ({ ...b, sectionId: 'secV', measures: 2 })),
      roadmap: [{ id: 'm1', kind: 'segno', barId: 'b1', edge: 'start' }],
    });
    const out = confirmSystemSplit(c, 'sysA', [0.5, 1]);
    expect(out.bars?.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(out.bars?.map((b) => b.sectionId)).toEqual(['secV', 'secV']);
    expect(out.bars?.map((b) => b.measures)).toEqual([2, 2]); // no fresh attribution ⇒ kept
    expect(out.roadmap).toEqual(c.roadmap);
    expect(out.systems?.[0].verdict).toBe('confirmed');
  });

  it('keeps only the bars that did not move; a moved bar is a new bar', () => {
    const c = cal({
      bars: bars([0.25, 0.5, 1]),
      roadmap: [
        { id: 'm1', kind: 'segno', barId: 'b1', edge: 'start' },
        { id: 'm3', kind: 'coda', barId: 'b3', edge: 'start' },
      ],
    });
    const out = confirmSystemSplit(c, 'sysA', [0.25, 0.6, 1]);
    expect(out.bars?.[0].id).toBe('b1');
    expect(out.bars?.slice(1).map((b) => b.id)).not.toContain('b2');
    expect(out.bars?.slice(1).map((b) => b.id)).not.toContain('b3');
    expect(out.roadmap?.map((m) => m.id)).toEqual(['m1']);
  });

  it('a fresh attribution overrides a kept bar\'s old count', () => {
    const c = cal({ bars: bars([0.5, 1]).map((b) => ({ ...b, measures: 3 })) });
    const out = confirmSystemSplit(c, 'sysA', [0.5, 1], [1, 4]);
    expect(out.bars?.map((b) => b.measures)).toEqual([undefined, 4]);
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

describe('whether the count can be answered yet', () => {
  // `measured: null` used to mean three different things — still reading, read failed, and
  // no line found on the page — and the count answered all three with "0 barlines".
  const sys = msys();
  const page = { pageWidth: W, pageHeight: 800, modalWidth: 0.8 } as never;

  it('is reading until the read has come back, whatever else is set', () => {
    expect(countReadiness({ read: 'reading', measured: null, page: null })).toBe('reading');
    expect(countReadiness({ read: 'reading', measured: sys, page })).toBe('reading');
  });

  it('is ready only with both the line and its page', () => {
    expect(countReadiness({ read: 'done', measured: sys, page })).toBe('ready');
  });

  it('is unreadable when the read came back without this line', () => {
    expect(countReadiness({ read: 'done', measured: null, page: null })).toBe('unreadable');
    expect(countReadiness({ read: 'done', measured: null, page })).toBe('unreadable');
  });

  it('an unreadable page never claims to have seen zero barlines', () => {
    const msg = refusalMessage('unreadable', 0);
    expect(msg).not.toMatch(/\b0 barlines?\b/);
    expect(msg).toMatch(/couldn't read/);
    expect(msg).toMatch(/by hand/i);
  });

  it('every refusal reason has copy — the list is complete by construction', () => {
    expect(REFUSAL_REASONS).toEqual(
      expect.arrayContaining(['insufficient-evidence', 'out-of-staff', 'degenerate-span', 'invalid-count', 'unreadable']),
    );
    for (const r of REFUSAL_REASONS) expect(refusalMessage(r, 2).length).toBeGreaterThan(10);
  });
});

describe('the sheet never offers what the commit will refuse', () => {
  // A stored band narrower than what the page read sees — every VLM-path chart, and any
  // hand-drawn band — used to get the measured candidate anyway. `confirmSystemSplit`
  // rejects an edge past the band (reject, never repair), the sheet closed regardless, and
  // the owner's answer was dropped with no word. Offer and commit now share ONE predicate.
  const measured = msys({
    x0: 30, x1: 570, clusters: [cl(165), cl(300), cl(435), cl(570)],
    bars: [
      { xStart: 30, xEnd: 165 }, { xStart: 165, xEnd: 300 },
      { xStart: 300, xEnd: 435 }, { xStart: 435, xEnd: 570 },
    ],
  });
  // Measured right edge 570/600 = 0.95; this band stops at 0.94.
  const narrow: System = { id: 'sysA', page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0.06, xEnd: 0.94, verdict: 'validated' };
  const stored = (() => {
    let left = 0.06;
    return [0.3, 0.55, 0.75, 0.94].map((x, i): Bar => {
      const b: Bar = { id: `b${i + 1}`, systemId: 'sysA', xStart: left, xEnd: x, absNumber: i + 1, sectionId: null };
      left = x;
      return b;
    });
  })();
  const cal = (): ChartCalibration =>
    ({ schemaVersion: 2, status: 'draft', sections: [], systems: [narrow], bars: stored, roadmap: [] }) as unknown as ChartCalibration;

  it('★ every candidate offered is one the commit accepts', () => {
    const cands = buildCandidates(stored, narrow, measured, PAGE);
    expect(cands.length).toBeGreaterThan(0);
    const before = cal();
    for (const c of cands) {
      expect(confirmSystemSplit(before, 'sysA', c.xs), `${c.sources} would write nothing`).not.toBe(before);
      expect(splitFitsSystem(narrow, c.xs)).toBe(true);
    }
    expect(cands.some((c) => c.sources.includes('measured'))).toBe(false);
  });

  it('a count the band cannot hold refuses as not lining up, rather than previewing a dead answer', () => {
    const out = proposeCountForSystem(narrow, measured, W, 0.8, 4);
    expect(out).toEqual({ kind: 'refused', reason: 'out-of-staff', available: 4 });
  });

  it('a count that fits is untouched', () => {
    const wide: System = { ...narrow, xEnd: 0.96 };
    const out = proposeCountForSystem(wide, measured, W, 0.8, 4);
    expect(out.kind).toBe('ok');
    const before = { ...cal(), systems: [wide] } as ChartCalibration;
    if (out.kind === 'ok') expect(confirmSystemSplit(before, 'sysA', out.xs)).not.toBe(before);
  });

  it('the predicate IS the commit rule — they cannot disagree', () => {
    const before = cal();
    for (const xs of [[0.3, 0.94], [0.3, 0.95], [0.06, 0.5], [0.5, 0.4], []]) {
      const wrote = confirmSystemSplit(before, 'sysA', xs) !== before;
      expect(splitFitsSystem(narrow, xs), JSON.stringify(xs)).toBe(wrote);
    }
  });
});
