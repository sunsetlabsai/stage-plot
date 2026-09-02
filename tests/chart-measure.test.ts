import { describe, it, expect } from 'vitest';
import {
  measurePage,
  mergeHorizontalRules,
  toPositionedText,
  type MeasuredSegment,
  type PositionedText,
} from '../lib/chart-measure';

// Synthetic geometry, shaped like the real thing. Dumped from a corpus chart for
// reference: a system spanning x 67-570 with clusters at 119/190/265/342/418/493/569
// scores spans=6 — i.e. a cluster is the RIGHT edge of a measure, and the leading
// thick begin-repeat is a span START that gets subtracted. The fixtures below keep
// that convention so a change in it fails here as well as in the corpus harness.

const STAFF_X0 = 50;
const STAFF_X1 = 550;
const BARLINE_W = 0.7;

/** Five staff lines, 6pt apart, starting at `yTop`. */
function staffLines(yTop: number): MeasuredSegment[] {
  return [0, 6, 12, 18, 24].map((dy) => ({
    x0: STAFF_X0,
    y0: yTop + dy,
    x1: STAFF_X1,
    y1: yTop + dy,
    strokeW: 0.3,
  }));
}

/** Full-height verticals — the only shape that passes the barline endpoint test. */
function barlines(yTop: number, xs: number[], strokeW = BARLINE_W): MeasuredSegment[] {
  return xs.map((x) => ({ x0: x, y0: yTop, x1: x, y1: yTop + 24, strokeW }));
}

function text(str: string, x: number, y: number): PositionedText {
  return { str, x, y };
}

/** Two systems, five measures each, no printed numbers except where a test adds them. */
function twoSystems(): MeasuredSegment[] {
  return [
    ...staffLines(100),
    ...barlines(100, [150, 250, 350, 450, 550]),
    ...staffLines(200),
    ...barlines(200, [150, 250, 350, 450, 550]),
  ];
}

describe('mergeHorizontalRules', () => {
  it('merges collinear fragments split at barlines', () => {
    // Engravers that break each staff line at every barline emit it as fragments; the
    // merge is what makes that chart look identical to one drawn with a single rule.
    // The gaps are barline-width, which is what the merge tolerance is sized for.
    const segs: MeasuredSegment[] = [
      { x0: 50, y0: 100, x1: 149.3, y1: 100, strokeW: 0.3 },
      { x0: 150, y0: 100, x1: 249.3, y1: 100, strokeW: 0.3 },
      { x0: 250, y0: 100.2, x1: 350, y1: 100.2, strokeW: 0.3 },
    ];
    const rules = mergeHorizontalRules(segs);
    expect(rules).toHaveLength(1);
    expect(rules[0].len).toBeCloseTo(300, 5);
  });

  it('keeps genuinely separate runs apart', () => {
    const segs: MeasuredSegment[] = [
      { x0: 50, y0: 100, x1: 150, y1: 100, strokeW: 0.3 },
      { x0: 300, y0: 100, x1: 400, y1: 100, strokeW: 0.3 },
    ];
    expect(mergeHorizontalRules(segs)).toHaveLength(2);
  });

  it('drops sub-2pt ink noise', () => {
    const segs: MeasuredSegment[] = [{ x0: 50, y0: 100, x1: 51, y1: 100, strokeW: 0.3 }];
    expect(mergeHorizontalRules(segs)).toHaveLength(0);
  });
});

describe('measurePage — staff and barline detection', () => {
  it('finds both systems and counts their measures', () => {
    const m = measurePage(twoSystems(), [], 1);
    expect(m.classification).toBe('notation');
    expect(m.staffCount).toBe(2);
    expect(m.systems.map((s) => s.spans)).toEqual([5, 5]);
    expect(m.systems[0].barlines).toEqual([150, 250, 350, 450, 550]);
  });

  it('ignores verticals that do not reach both outer staff lines', () => {
    // A note stem crossing most of the staff is the case this protects against.
    const stem: MeasuredSegment = { x0: 200, y0: 106, x1: 200, y1: 124, strokeW: 0.7 };
    const m = measurePage([...twoSystems(), stem], [], 1);
    expect(m.systems[0].spans).toBe(5);
  });

  it('rejects a staff-spanning stem by its stroke width', () => {
    // Full height AND on the staff, but thinner than the modal barline width. Measured
    // on real charts the gap is as small as 0.62 vs 0.78 — hence the tight tolerance.
    const thinStem = barlines(100, [200], 0.4);
    const m = measurePage([...twoSystems(), ...thinStem], [], 1);
    expect(m.systems[0].spans).toBe(5);
  });

  it('clusters a repeat thick+thin pair as one divider', () => {
    const pair = barlines(100, [349.9], 2.0); // 0.1pt from the existing 350 barline
    const m = measurePage([...twoSystems(), ...pair], [], 1);
    expect(m.systems[0].spans).toBe(5);
  });
});

describe('measurePage — printed measure numbers', () => {
  it('validates when measured spans equal the printed delta', () => {
    // System A is unnumbered — measure 1, because this is page 1. System B prints 6,
    // so A must hold 5 measures, and it does.
    const m = measurePage(twoSystems(), [text('6', STAFF_X0, 198)], 1);
    expect(m.systems[0].printedNumber).toBeNull();
    expect(m.systems[0].expectedSpans).toBe(5);
    expect(m.systems[0].verdict).toBe('validated');
  });

  it('flags a mismatch as uncertain rather than guessing', () => {
    const m = measurePage(twoSystems(), [text('7', STAFF_X0, 198)], 1);
    expect(m.systems[0].expectedSpans).toBe(6);
    expect(m.systems[0].verdict).toBe('uncertain');
  });

  it('abstains on a continuation page instead of assuming measure 1', () => {
    // Assuming 1 here invents a delta out of the previous page's measure count.
    const m = measurePage(twoSystems(), [text('6', STAFF_X0, 198)], 2);
    expect(m.systems[0].verdict).toBe('unscored');
    expect(m.systems[0].expectedSpans).toBeNull();
  });

  it('leaves the page-tail system unscored', () => {
    const m = measurePage(twoSystems(), [text('6', STAFF_X0, 198)], 1);
    expect(m.systems[1].verdict).toBe('unscored');
  });

  it('excludes a stacked time signature from the measure numbers', () => {
    // Two digits at the same x, 12pt apart, inside the margin band. Without the
    // exclusion the top one reads as this system's printed measure number.
    const m = measurePage(twoSystems(), [text('4', 52, 206), text('4', 52, 218)], 1);
    expect(m.systems[1].printedNumber).toBeNull();
  });
});

describe('measurePage — multirests', () => {
  // A multirest H-bar is a FILLED rectangle straddling the middle staff line, so it
  // arrives as four segments. Its end caps are half-height and therefore never pass the
  // barline endpoint test — which is why no cap suppression is needed, and why adding
  // any would eat the real barline that ends the multirest.
  const multirestBar: MeasuredSegment[] = [
    { x0: 260, y0: 109, x1: 340, y1: 109, strokeW: null },
    { x0: 340, y0: 109, x1: 340, y1: 115, strokeW: null },
    { x0: 340, y0: 115, x1: 260, y1: 115, strokeW: null },
    { x0: 260, y0: 115, x1: 260, y1: 109, strokeW: null },
  ];

  it('counts a multirest as its full measure count', () => {
    // 5 visible spans, one of them a 4-bar multirest, so the printed delta is 5 + 3.
    const m = measurePage(
      [...twoSystems(), ...multirestBar],
      [text('4', 280, 95), text('9', STAFF_X0, 198)],
      1,
    );
    expect(m.systems[0].multirests).toEqual([4]);
    expect(m.systems[0].expectedSpans).toBe(5);
    expect(m.systems[0].verdict).toBe('validated');
  });

  it('ignores a digit with no H-bar beneath it', () => {
    // A chord-extension superscript is a digit floating over the staff with no bar.
    const m = measurePage(twoSystems(), [text('9', 280, 95), text('6', STAFF_X0, 198)], 1);
    expect(m.systems[0].multirests).toEqual([]);
    expect(m.systems[0].verdict).toBe('validated');
  });

  it('ignores an H-bar with no digit above it', () => {
    // A beam is a bar with no count printed over it.
    const m = measurePage([...twoSystems(), ...multirestBar], [text('6', STAFF_X0, 198)], 1);
    expect(m.systems[0].multirests).toEqual([]);
    expect(m.systems[0].verdict).toBe('validated');
  });
});

describe('measurePage — line-start begin-repeat', () => {
  it('treats a thick leading barline near the staff start as a span start', () => {
    // Clef/key/time occupy the gap, so the thick bar opens the first measure rather
    // than closing one. Six clusters, five measures.
    const segs = [
      ...staffLines(100),
      ...barlines(100, [90], 2.4),
      ...barlines(100, [190, 290, 390, 490, 550]),
      ...staffLines(200),
      ...barlines(200, [150, 250, 350, 450, 550]),
    ];
    const m = measurePage(segs, [], 1);
    expect(m.systems[0].barlines).toHaveLength(6);
    expect(m.systems[0].spans).toBe(5);
  });

  it('keeps a thick divider that has a real measure before it', () => {
    // ★ This fixture is built so the shipped rule and the REJECTED "leftmost 20% of the
    // staff" rule disagree — otherwise it pins nothing. The staff runs 50..550, so the
    // rejected rule's window is x < 150 and the thick bar at x=140 sits inside it: that
    // rule would call this a line-start repeat and subtract. But the bars here are 60pt
    // wide and the gap from the staff start is 90pt — a whole measure fits ahead of the
    // thick bar, so it is a DIVIDER and must still count. Eight clusters, eight
    // measures. (A real chart taught us this: its genuine first bar fit inside the 20%.)
    const segs = [
      ...staffLines(100),
      ...barlines(100, [140], 2.4),
      ...barlines(100, [200, 260, 320, 380, 440, 500, 550]),
      ...staffLines(200),
      ...barlines(200, [150, 250, 350, 450, 550]),
    ];
    const m = measurePage(segs, [], 1);
    expect(m.systems[0].barlines).toHaveLength(8);
    expect(m.systems[0].spans).toBe(8);
  });
});

describe('measurePage — page classification', () => {
  it('classifies a vector page with text but no staves as not-notation', () => {
    // The automatic backstop never-gate: a mislabeled lyrics sheet or chord chart. No
    // VLM call, no overlay — the engine declines before anything is spent.
    const m = measurePage(
      [{ x0: 50, y0: 40, x1: 550, y1: 40, strokeW: 0.5 }],
      [text('Verse 1', 60, 80)],
      1,
    );
    expect(m.classification).toBe('not-notation');
    expect(m.staffCount).toBe(0);
    expect(m.systems).toEqual([]);
  });

  it('classifies a page with neither vectors nor text as raster', () => {
    expect(measurePage([], [], 1).classification).toBe('raster');
  });

  it('does not treat whitespace-only text as real text', () => {
    expect(measurePage([], [text('   ', 10, 10)], 1).classification).toBe('raster');
  });

  it('classifies a page with staves as notation', () => {
    expect(measurePage(twoSystems(), [], 1).classification).toBe('notation');
  });
});

describe('toPositionedText', () => {
  it('flips pdf text space to the page space the geometry uses', () => {
    // PDF text y grows upward from the page bottom; every segment coordinate in the
    // engine grows downward from the page top. The flip happens once, here.
    const items = [{ str: '12', transform: [1, 0, 0, 1, 42, 700] }];
    expect(toPositionedText(items, 792)).toEqual([{ str: '12', x: 42, y: 92 }]);
  });
});
