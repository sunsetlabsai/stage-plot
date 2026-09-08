import { describe, it, expect } from 'vitest';
import { reviewFlags, REVIEW_CONFIDENCE_THRESHOLD } from '../lib/chart-review';
import { resolveRoadmap } from '../lib/chart-calibration';
import type { ChartCalibration, SectionAnchor, System, Bar, RoadmapMarker, ChartVerdict } from '../lib/types';

function sec(id: string, page: number, x: number, y: number, conf?: number): SectionAnchor {
  return { id, page, x, y, label: 'X', ...(conf !== undefined ? { confidence: conf } : {}) };
}
function sys(id: string, page: number, yTop: number, conf?: number): System {
  return { id, page, yTop, yBottom: yTop + 0.1, xStart: 0, xEnd: 1, ...(conf !== undefined ? { confidence: conf } : {}) };
}
function bar(id: string, systemId: string, xStart: number, absNumber: number, conf?: number): Bar {
  return { id, systemId, xStart, xEnd: xStart + 0.1, absNumber, sectionId: null, ...(conf !== undefined ? { confidence: conf } : {}) };
}
function build(over: Partial<ChartCalibration> = {}): ChartCalibration {
  return { schemaVersion: 3, status: 'draft', sections: [], systems: [], bars: [], ...over };
}

const T = REVIEW_CONFIDENCE_THRESHOLD; // 0.8

describe('reviewFlags — confidence threshold', () => {
  it('flags a section strictly below the threshold, not at/above it, never when absent', () => {
    const cal = build({
      sections: [
        sec('s-low', 1, 0.1, 0.1, T - 0.01), // 0.79 → flagged
        sec('s-edge', 1, 0.2, 0.2, T), //        0.80 → accepted
        sec('s-high', 1, 0.3, 0.3, 0.99), //     high → accepted
        sec('s-manual', 1, 0.4, 0.4), //         absent → never flagged
      ],
    });
    const f = reviewFlags(cal);
    expect(f.sectionIds).toEqual(new Set(['s-low']));
  });

  it('flags a low-confidence system band directly', () => {
    const cal = build({ systems: [sys('sysA', 1, 0.1, 0.5), sys('sysB', 1, 0.5, 0.95)] });
    const f = reviewFlags(cal);
    expect(f.systemIds).toEqual(new Set(['sysA']));
  });

  it('flags a low-confidence marker directly', () => {
    const cal = build({
      systems: [sys('sysA', 1, 0.1, 0.95)],
      bars: [bar('b1', 'sysA', 0.0, 1, 0.95)],
      roadmap: [{ id: 'm1', kind: 'segno', barId: 'b1', edge: 'start', confidence: 0.4 }],
    });
    const f = reviewFlags(cal);
    expect(f.markerIds).toEqual(new Set(['m1']));
  });
});

describe('reviewFlags — bar roll-up to band', () => {
  it('flags the parent band when a child bar is low-confidence, even if the band is confident', () => {
    const cal = build({
      systems: [sys('sysA', 1, 0.1, 0.99)], // confident band
      bars: [bar('b1', 'sysA', 0.0, 1, 0.99), bar('b2', 'sysA', 0.5, 2, 0.5)], // one shaky bar
    });
    const f = reviewFlags(cal);
    expect(f.systemIds).toEqual(new Set(['sysA']));
  });
});

describe('reviewFlags — marker resolve-error union', () => {
  it('surfaces markers implicated in a resolveRoadmap error even at high confidence', () => {
    // Two Segno markers: structurally valid (FK ok) but the resolver rejects a
    // second global singleton, so both are surfaced — via resolve-error, NOT
    // confidence (both are 0.99).
    const cal = build({
      systems: [sys('sysA', 1, 0.1, 0.99)],
      bars: [bar('b1', 'sysA', 0.0, 1, 0.99), bar('b2', 'sysA', 0.5, 2, 0.99)],
      roadmap: [
        { id: 'sg1', kind: 'segno', barId: 'b1', edge: 'start', confidence: 0.99 },
        { id: 'sg2', kind: 'segno', barId: 'b2', edge: 'start', confidence: 0.99 },
      ] satisfies RoadmapMarker[],
    });
    const resolved = resolveRoadmap(cal);
    expect(resolved.ok).toBe(false);
    const f = reviewFlags(cal);
    // markerIds is exactly the resolver's error set (no low-confidence markers here).
    expect(f.markerIds).toEqual(new Set(resolved.ok ? [] : resolved.error.markerIds));
    expect(f.markerIds.size).toBeGreaterThan(0);
  });

  it('counts a marker that is both low-confidence and in a resolve error only once', () => {
    const cal = build({
      systems: [sys('sysA', 1, 0.1, 0.99)],
      bars: [bar('b1', 'sysA', 0.0, 1, 0.99), bar('b2', 'sysA', 0.5, 2, 0.99)],
      roadmap: [
        { id: 'sg1', kind: 'segno', barId: 'b1', edge: 'start', confidence: 0.3 }, // low AND error
        { id: 'sg2', kind: 'segno', barId: 'b2', edge: 'start', confidence: 0.99 },
      ] satisfies RoadmapMarker[],
    });
    const f = reviewFlags(cal);
    // sg1 appears once despite matching both criteria.
    const sg1Count = [...f.markerIds].filter((id) => id === 'sg1').length;
    expect(sg1Count).toBe(1);
  });
});

describe('reviewFlags — ordering, count, disjointness', () => {
  it('walks flagged elements page → top → left across types', () => {
    const cal = build({
      sections: [sec('sec-p1', 1, 0.2, 0.05, 0.4), sec('sec-p2', 2, 0.2, 0.3, 0.4)],
      systems: [sys('sysA', 1, 0.1, 0.4), sys('sysB', 1, 0.5, 0.4), sys('sysC', 2, 0.2, 0.4)],
    });
    const f = reviewFlags(cal);
    expect(f.ordered.map((r) => r.id)).toEqual(['sec-p1', 'sysA', 'sysB', 'sysC', 'sec-p2']);
    // each ref carries the tool that renders it
    expect(f.ordered.map((r) => r.tool)).toEqual(['sections', 'bars', 'bars', 'bars', 'sections']);
  });

  it('count equals ordered length and the three id sets are disjoint', () => {
    const cal = build({
      sections: [sec('s1', 1, 0.1, 0.1, 0.4)],
      systems: [sys('sysA', 1, 0.2, 0.4)],
      bars: [bar('b1', 'sysA', 0.0, 1, 0.99)],
      roadmap: [{ id: 'm1', kind: 'segno', barId: 'b1', edge: 'start', confidence: 0.4 }],
    });
    const f = reviewFlags(cal);
    expect(f.count).toBe(f.ordered.length);
    expect(f.count).toBe(3); // one section, one system, one marker
    const ids = [...f.sectionIds, ...f.systemIds, ...f.markerIds];
    expect(new Set(ids).size).toBe(ids.length); // disjoint
  });

  it('returns an empty queue for a fully manual (no-confidence) calibration', () => {
    const cal = build({
      sections: [sec('s1', 1, 0.1, 0.1), sec('s2', 1, 0.2, 0.2)],
      systems: [sys('sysA', 1, 0.3)],
      bars: [bar('b1', 'sysA', 0.0, 1)],
    });
    const f = reviewFlags(cal);
    expect(f.count).toBe(0);
    expect(f.ordered).toEqual([]);
    expect(f.sectionIds.size + f.systemIds.size + f.markerIds.size).toBe(0);
  });

  it('handles an empty calibration', () => {
    const f = reviewFlags(build());
    expect(f.count).toBe(0);
    expect(f.ordered).toEqual([]);
  });
});

// ── C1: verdict is the exclusive flag signal for a system ────────────────────

function vsys(id: string, page: number, yTop: number, verdict?: ChartVerdict, conf?: number): System {
  return {
    id,
    page,
    yTop,
    yBottom: yTop + 0.1,
    xStart: 0,
    xEnd: 1,
    ...(conf !== undefined ? { confidence: conf } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
  };
}

describe('reviewFlags — verdict exclusivity (C1)', () => {
  it('flags `uncertain` and stays silent for every other verdict', () => {
    // The whole vocabulary, so a new verdict cannot be added without landing here.
    const silent: ChartVerdict[] = [
      'validated',
      'unscored',
      'corroborated',
      'estimated',
      'confirmed',
      'edited',
    ];
    for (const v of silent) {
      const f = reviewFlags(build({ systems: [vsys('sysA', 1, 0.2, v)] }));
      expect(f.systemIds.has('sysA'), `${v} must be silent`).toBe(false);
    }
    const f = reviewFlags(build({ systems: [vsys('sysB', 1, 0.2, 'uncertain')] }));
    expect(f.systemIds.has('sysB')).toBe(true);
    expect(f.count).toBe(1);
  });

  it('a measured system with NO confidence still flags — the defect C1 fixes', () => {
    // installMeasured deliberately writes no `confidence`, so before C1 this
    // calibration flagged nothing at all and the toolbar read "✓ Reviewed".
    const cal = build({ systems: [vsys('sysA', 1, 0.2, 'uncertain')] });
    expect(cal.systems?.[0].confidence).toBeUndefined();
    expect(reviewFlags(cal).count).toBe(1);
  });

  it('a present verdict SHADOWS a low child-bar confidence', () => {
    // The exclusivity rule: `validated` geometry is vector-measured, so a VLM-seeded
    // child confidence is stale metadata, not evidence about this system.
    const cal = build({
      systems: [vsys('sysA', 1, 0.2, 'validated')],
      bars: [bar('b1', 'sysA', 0.0, 1, 0.1)],
    });
    expect(reviewFlags(cal).systemIds.size).toBe(0);
  });

  it('a present verdict SHADOWS a low confidence on the band itself', () => {
    const cal = build({ systems: [vsys('sysA', 1, 0.2, 'validated', 0.1)] });
    expect(reviewFlags(cal).systemIds.size).toBe(0);
  });

  it('`uncertain` flags even when confidence is high — the verdict wins both ways', () => {
    const cal = build({ systems: [vsys('sysA', 1, 0.2, 'uncertain', 0.99)] });
    expect(reviewFlags(cal).systemIds.has('sysA')).toBe(true);
  });

  it('an ABSENT verdict leaves the numeric roll-up byte-for-byte unchanged', () => {
    const lowBand = build({ systems: [vsys('sysA', 1, 0.2, undefined, T - 0.01)] });
    expect(reviewFlags(lowBand).systemIds.has('sysA')).toBe(true);

    const lowChild = build({
      systems: [vsys('sysB', 1, 0.2)],
      bars: [bar('b1', 'sysB', 0.0, 1, T - 0.01)],
    });
    expect(reviewFlags(lowChild).systemIds.has('sysB')).toBe(true);

    const clean = build({
      systems: [vsys('sysC', 1, 0.2)],
      bars: [bar('b1', 'sysC', 0.0, 1, 0.99)],
    });
    expect(reviewFlags(clean).systemIds.size).toBe(0);
  });

  it('verdict-bearing and verdict-less systems coexist in one calibration', () => {
    // A chart can legitimately carry both: measured systems with verdicts, and
    // hand-added ones with neither. Each takes its own path.
    const cal = build({
      systems: [
        vsys('measured-ok', 1, 0.1, 'validated'),
        vsys('measured-bad', 1, 0.3, 'uncertain'),
        vsys('legacy-low', 1, 0.5, undefined, T - 0.01),
        vsys('legacy-ok', 1, 0.7, undefined, 0.99),
      ],
    });
    const f = reviewFlags(cal);
    expect([...f.systemIds].sort()).toEqual(['legacy-low', 'measured-bad']);
  });

  it('sections and markers are untouched by verdicts', () => {
    const cal = build({
      sections: [sec('s1', 1, 0.1, 0.1, T - 0.01)],
      systems: [vsys('sysA', 1, 0.2, 'validated')],
      bars: [bar('b1', 'sysA', 0.0, 1)],
      roadmap: [{ id: 'm1', kind: 'segno', barId: 'b1', edge: 'start', confidence: 0.4 }],
    });
    const f = reviewFlags(cal);
    expect(f.sectionIds.has('s1')).toBe(true);
    expect(f.markerIds.has('m1')).toBe(true);
    expect(f.systemIds.size).toBe(0);
  });
});
