import { describe, it, expect } from 'vitest';
import type { Bar, ChartCalibration, System } from '../lib/types';
import { CALIBRATION_SCHEMA_VERSION } from '../lib/chart-calibration';
import {
  detectBarlines,
  snapBarsToLines,
  type BandProfile,
  type DetectedLine,
} from '../lib/chart-snap';

// ── helpers ──────────────────────────────────────────────────────────────────

// A band profile from per-column dark fractions.
function profile(dark: number[]): BandProfile {
  return { cols: dark.length, dark: Float32Array.from(dark) };
}

// A flat dark array with sharp full-coverage spikes at the given columns.
function spikes(cols: number, at: number[], value = 1): BandProfile {
  const dark = new Array<number>(cols).fill(0);
  for (const c of at) dark[c] = value;
  return profile(dark);
}

// A single system whose bars are the consecutive [edges[k], edges[k+1]] spans
// (lets a test make bars deliberately uneven so an edge/interior MAX_PULL bites).
function customSystem(edges: number[]): ChartCalibration {
  const sys: System = { id: 'sys1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: edges[0], xEnd: edges[edges.length - 1] };
  const bars: Bar[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    bars.push({
      id: `b${i + 1}`,
      systemId: 'sys1',
      xStart: edges[i],
      xEnd: edges[i + 1],
      absNumber: i + 1,
      sectionId: null,
    });
  }
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    status: 'draft',
    sections: [{ id: 'sec', page: 1, x: 0.05, y: 0.05, label: 'A' }],
    systems: [sys],
    bars,
  };
}

// An N-bar single system spanning [xStart, xEnd], evenly distributed.
function evenSystem(n: number, xStart = 0, xEnd = 1): ChartCalibration {
  const sys: System = { id: 'sys1', page: 1, yTop: 0.1, yBottom: 0.3, xStart, xEnd };
  const w = (xEnd - xStart) / n;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      id: `b${i + 1}`,
      systemId: 'sys1',
      xStart: xStart + i * w,
      xEnd: xStart + (i + 1) * w,
      absNumber: i + 1,
      sectionId: null,
    });
  }
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    status: 'draft',
    sections: [{ id: 'sec', page: 1, x: 0.05, y: 0.05, label: 'A' }],
    systems: [sys],
    bars,
  };
}

// The system's boundary tick positions (page-space), ascending.
function ticks(cal: ChartCalibration): number[] {
  const bars = (cal.bars ?? [])
    .filter((b) => b.systemId === 'sys1')
    .sort((a, b) => a.xStart - b.xStart);
  const out = [bars[0].xStart];
  for (let i = 1; i < bars.length; i++) out.push(bars[i].xStart);
  out.push(bars[bars.length - 1].xEnd);
  return out;
}

// Page-space line positions → DetectedLine[] within a [xStart,xEnd] band.
function linesAt(pageXs: number[], xStart = 0, xEnd = 1, strength = 1): DetectedLine[] {
  return pageXs.map((px) => ({ x: (px - xStart) / (xEnd - xStart), strength }));
}

// ── detectBarlines ───────────────────────────────────────────────────────────

describe('detectBarlines', () => {
  it('finds 3 sharp full-coverage spikes at their columns', () => {
    const lines = detectBarlines(spikes(100, [20, 50, 80]));
    expect(lines).toHaveLength(3);
    // column-center convention: x = (col + 0.5) / cols
    expect(lines.map((l) => Math.round(l.x * 100))).toEqual([21, 51, 81]);
    expect(lines.every((l) => l.strength > 0 && l.strength <= 1)).toBe(true);
  });

  it('rejects a broad low-coverage hump (note stem / text) below MIN_COVERAGE', () => {
    const dark = new Array<number>(100).fill(0);
    for (let c = 40; c <= 60; c++) dark[c] = 0.4; // wide, but never clears 0.6
    expect(detectBarlines(profile(dark))).toHaveLength(0);
  });

  it('collapses two spikes within NMS_PX into one centroid', () => {
    const lines = detectBarlines(spikes(100, [50, 52])); // gap 2 ≤ NMS_PX(4)
    expect(lines).toHaveLength(1);
    expect(Math.round(lines[0].x * 100)).toBe(52); // midpoint center ≈ (50.5+52.5)/2
  });

  it('keeps two spikes beyond NMS_PX as separate lines', () => {
    const lines = detectBarlines(spikes(100, [50, 60])); // gap 10 > NMS_PX
    expect(lines).toHaveLength(2);
  });

  it('rejects a cluster wider than MAX_LINE_FRAC (a shaded fill, not a line)', () => {
    const dark = new Array<number>(100).fill(0);
    for (let c = 30; c <= 45; c++) dark[c] = 1; // 16 cols = 16% > 5%
    expect(detectBarlines(profile(dark))).toHaveLength(0);
  });

  it('drops everything below MIN_STRENGTH (low-contrast / handwritten degrade)', () => {
    // spikes just over the coverage floor sitting in a uniformly dark band →
    // local contrast collapses → strength under the floor.
    const dark = new Array<number>(100).fill(0.5);
    for (const c of [25, 50, 75]) dark[c] = 0.62;
    expect(detectBarlines(profile(dark))).toHaveLength(0);
  });

  it('returns strengths in 0..1 monotone with coverage, sorted by x', () => {
    const dark = new Array<number>(100).fill(0);
    dark[70] = 1.0;
    dark[20] = 0.65;
    const lines = detectBarlines(profile(dark));
    expect(lines.map((l) => Math.round(l.x * 100))).toEqual([21, 71]); // sorted by x
    const weak = lines[0];
    const strong = lines[1];
    expect(strong.strength).toBeGreaterThan(weak.strength); // monotone with coverage
    expect(lines.every((l) => l.strength >= 0 && l.strength <= 1)).toBe(true);
  });

  it('returns empty for an empty / zero-column profile', () => {
    expect(detectBarlines(profile([]))).toEqual([]);
  });
});

// ── snapBarsToLines — matching, gating, result contract ──────────────────────

describe('snapBarsToLines — equal counts (ordinal)', () => {
  it('snaps boundary 0 to the first line even far right of the band edge (clef margin)', () => {
    const cal = evenSystem(4); // boundaries at 0, .25, .5, .75, 1
    // first line sits well right of the edge (clef/key-sig), rest near-even
    const lines = linesAt([0.12, 0.3, 0.52, 0.74, 0.97]);
    const r = snapBarsToLines(cal, 'sys1', lines);
    expect(r.detectedLines).toBe(5);
    expect(r.expectedBoundaries).toBe(5);
    expect(r.accepted).toBe(5);
    expect(r.fullySnapped).toBe(5);
    expect(r.partial).toBe(0);
    expect(r.surplusLines).toBe(0);
    expect(ticks(r.calibration)).toEqual([0.12, 0.3, 0.52, 0.74, 0.97]);
  });

  it('anchors boundary N to the last line, however far from system.xEnd', () => {
    const cal = evenSystem(3); // boundaries 0, 1/3, 2/3, 1
    const lines = linesAt([0.1, 0.4, 0.62, 0.85]); // trailing edge pulls left to .85
    const r = snapBarsToLines(cal, 'sys1', lines);
    expect(r.accepted).toBe(4);
    expect(ticks(r.calibration)[3]).toBeCloseTo(0.85, 10);
  });

  it('maps band→page correctly for an indented system (xStart ≠ 0)', () => {
    const cal = evenSystem(2, 0.2, 0.8); // boundaries .2, .5, .8
    const lines = linesAt([0.28, 0.55, 0.78], 0.2, 0.8);
    const r = snapBarsToLines(cal, 'sys1', lines);
    expect(r.accepted).toBe(3);
    expect(ticks(r.calibration)).toEqual([0.28, 0.55, 0.78]);
  });
});

describe('snapBarsToLines — unequal counts (mutual-nearest)', () => {
  it('no line-consumption: B=[0,.25,.5,.75,1], L=[.25,.5,.75] snaps the interiors', () => {
    // The Codex R2 #1 regression: an earlier boundary must not burn a later
    // boundary's line. B0/B4 stay put; B1↔.25, B2↔.5, B3↔.75 snap.
    const cal = evenSystem(4);
    const r = snapBarsToLines(cal, 'sys1', linesAt([0.25, 0.5, 0.75]));
    expect(r.detectedLines).toBe(3);
    expect(r.accepted).toBe(3);
    expect(r.surplusLines).toBe(0);
    expect(ticks(r.calibration)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('more lines than boundaries → extras ignored, no bar added', () => {
    const cal = evenSystem(2); // 3 boundaries
    const before = (cal.bars ?? []).length;
    const r = snapBarsToLines(cal, 'sys1', linesAt([0.02, 0.5, 0.6, 0.98]));
    expect((r.calibration.bars ?? []).length).toBe(before); // count unchanged
    expect(r.surplusLines).toBeGreaterThan(0);
    expect(r.accepted).toBeLessThanOrEqual(3);
  });

  it('two boundaries cannot both grab one line (mutual-nearest)', () => {
    const cal = evenSystem(3); // boundaries 0, 1/3, 2/3, 1
    // a single line near the two middle boundaries: only the nearer one wins
    const r = snapBarsToLines(cal, 'sys1', linesAt([0.34]));
    expect(r.accepted).toBe(1);
    const t = ticks(r.calibration);
    expect(t[1]).toBeCloseTo(0.34, 10); // boundary 1 (1/3 ≈ .333) is nearest
    expect(t[2]).toBeCloseTo(2 / 3, 10); // boundary 2 untouched
  });

  it('refuses an interior cross-bar yank beyond MAX_PULL; applies one within it', () => {
    // bars [0,.1] [.1,.9] [.9,1]: boundary 1 at .1 has cap 0.5×min(.1,.8) = .05.
    const cal = customSystem([0, 0.1, 0.9, 1]);
    // a line at .2 is nearest boundary 1 (.1) but .1 away → exceeds .05 → refused
    const far = snapBarsToLines(cal, 'sys1', linesAt([0.2]));
    expect(far.accepted).toBe(0);
    expect(far.calibration).toBe(cal); // identity, nothing moved
    // a line at .13 is .03 from boundary 1 → within .05 → applied
    const near = snapBarsToLines(cal, 'sys1', linesAt([0.13]));
    expect(near.accepted).toBe(1);
    expect(ticks(near.calibration)[1]).toBeCloseTo(0.13, 10);
  });

  it('edge MAX_PULL is capped by the single neighbor bar width (Codex R2 #2)', () => {
    // bars [0,.1] [.1,1]: boundary 0 at 0 has cap 0.5×width(bar 0) = .05. A line
    // at .03 is nearest boundary 0 and within the cap → snaps the leading edge
    // (proves the edge formula uses bar-0 width and is applied, not a crash/no-op).
    const cal = customSystem([0, 0.1, 1]);
    const r = snapBarsToLines(cal, 'sys1', linesAt([0.03]));
    expect(r.accepted).toBe(1);
    expect(ticks(r.calibration)[0]).toBeCloseTo(0.03, 10);
  });
});

describe('snapBarsToLines — strength prefilter (B2)', () => {
  it('drops a sub-strength spurious line before the count check (no ungated ordinal)', () => {
    const cal = evenSystem(4); // expects 5 boundaries
    // 4 strong real interior+edge lines + 1 weak false positive. WITHOUT the
    // prefilter this is |L| == 5 → ungated ordinal. WITH it, the weak one drops,
    // count becomes 4 → gated mutual-nearest snaps only the real ones.
    const lines: DetectedLine[] = [
      ...linesAt([0.25, 0.5, 0.75], 0, 1, 0.9),
      { x: 0.4, strength: 0.1 }, // weak spurious, below MIN_STRENGTH(0.35)
      ...linesAt([0.95], 0, 1, 0.9),
    ];
    const r = snapBarsToLines(cal, 'sys1', lines);
    expect(r.detectedLines).toBe(4); // weak one filtered
    expect(ticks(r.calibration)).toContain(0.25);
    expect(ticks(r.calibration)).not.toContain(0.4); // the spurious line never landed
  });
});

describe('snapBarsToLines — post-apply honesty (D) & determinism (B1)', () => {
  it('reports a clamped boundary as partial, not a snapped success', () => {
    // two equal-count lines closer than MIN_BAR_W force moveBarBoundary to clamp
    // the second, so it lands short of its detected line → partial.
    const cal = evenSystem(2); // boundaries 0, .5, 1; MIN_BAR_W = .01
    const lines = linesAt([0.5, 0.505, 1]); // boundary 1 target .505, then .5→clamps
    const r = snapBarsToLines(cal, 'sys1', lines);
    expect(r.accepted).toBe(3);
    expect(r.partial).toBeGreaterThanOrEqual(1);
    expect(r.fullySnapped).toBeLessThan(3);
  });

  it('is order-independent: shuffled input lines yield the same geometry', () => {
    const cal = evenSystem(4);
    const a = snapBarsToLines(cal, 'sys1', linesAt([0.25, 0.5, 0.75]));
    const b = snapBarsToLines(cal, 'sys1', linesAt([0.75, 0.25, 0.5]));
    expect(ticks(b.calibration)).toEqual(ticks(a.calibration));
    expect(b.accepted).toBe(a.accepted);
  });
});

describe('snapBarsToLines — degrade & no-ops', () => {
  it('snapped bars clear confidence and the calibration goes draft', () => {
    const cal = evenSystem(2);
    (cal.bars ?? []).forEach((b) => (b.confidence = 0.5));
    cal.status = 'verified';
    const r = snapBarsToLines(cal, 'sys1', linesAt([0.05, 0.5, 0.95]));
    expect(r.calibration.status).toBe('draft');
    const moved = (r.calibration.bars ?? []).filter((b) => b.systemId === 'sys1');
    expect(moved.every((b) => b.confidence === undefined)).toBe(true);
  });

  it('unknown systemId → input unchanged, accepted 0', () => {
    const cal = evenSystem(3);
    const r = snapBarsToLines(cal, 'nope', linesAt([0.3]));
    expect(r.calibration).toBe(cal);
    expect(r.accepted).toBe(0);
    expect(r.expectedBoundaries).toBe(0);
  });

  it('empty lines → input identity (toBe), accepted 0', () => {
    const cal = evenSystem(4);
    const r = snapBarsToLines(cal, 'sys1', []);
    expect(r.calibration).toBe(cal);
    expect(r.accepted).toBe(0);
    expect(r.detectedLines).toBe(0);
  });

  it('all lines below MIN_STRENGTH → no-op identity', () => {
    const cal = evenSystem(4);
    const weak = linesAt([0.25, 0.5, 0.75], 0, 1, 0.1);
    const r = snapBarsToLines(cal, 'sys1', weak);
    expect(r.calibration).toBe(cal);
    expect(r.detectedLines).toBe(0);
    expect(r.accepted).toBe(0);
  });
});
