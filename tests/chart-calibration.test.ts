import { describe, it, expect } from 'vitest';
import {
  CALIBRATION_SCHEMA_VERSION,
  emptyCalibration,
  sectionsInOrder,
  sectionsForPage,
  addSection,
  removeSection,
  relabelSection,
  moveSection,
  canVerify,
  verify,
  isPerformable,
  isValidSectionAnchor,
  isValidCalibration,
  isValidRoadmapMarkerShape,
  upgradeCalibration,
  resolveRoadmap,
  systemsInOrder,
  systemsForPage,
  addSystem,
  removeSystem,
  resizeSystemBand,
  autoDistributeBars,
  barsInOrder,
  tapToBar,
  isValidSystem,
  isValidBar,
  hashPdfBytes,
  findSystem,
  barsForPage,
  firstBar,
  nextBar,
  prevBar,
  enclosingRepeatStartId,
  addRoadmapMarker,
  removeRoadmapMarker,
  summarizeTraversal,
} from '../lib/chart-calibration';
import type { ChartCalibration, System, Bar, RoadmapMarker } from '../lib/types';

function cal(over: Partial<ChartCalibration> = {}): ChartCalibration {
  return { ...emptyCalibration(), ...over };
}

// ── upgrade-on-read ─────────────────────────────────────────────────────────

describe('upgradeCalibration', () => {
  it('normalizes a v1 calibration up to the current shape', () => {
    const v1: ChartCalibration = { schemaVersion: 1, status: 'draft', sections: [] };
    const up = upgradeCalibration(v1);
    expect(up.schemaVersion).toBe(CALIBRATION_SCHEMA_VERSION);
    expect(up.systems).toEqual([]);
    expect(up.bars).toEqual([]);
    expect(up.sections).toEqual([]);
    expect(up.roadmap).toBeUndefined();
  });

  it('normalizes a v2 calibration up to the current shape', () => {
    const v2: ChartCalibration = {
      schemaVersion: 2, status: 'draft', sections: [], systems: [], bars: [],
    };
    const up = upgradeCalibration(v2);
    expect(up.schemaVersion).toBe(CALIBRATION_SCHEMA_VERSION);
    expect(up.roadmap).toBeUndefined();
  });

  it('is a no-op for current-version calibrations', () => {
    const cur = emptyCalibration();
    expect(upgradeCalibration(cur)).toBe(cur);
  });

  it('leaves a genuinely-future row untouched (so the GET gate can fail it closed)', () => {
    const future: ChartCalibration = { schemaVersion: 99, status: 'draft', sections: [] };
    expect(upgradeCalibration(future)).toBe(future);
    expect(upgradeCalibration(future).schemaVersion).toBe(99);
  });

  it('preserves existing sections and status', () => {
    const v1: ChartCalibration = {
      schemaVersion: 1,
      status: 'verified',
      sections: [{ id: 'a', page: 1, x: 0.5, y: 0.5, label: 'Intro' }],
    };
    const up = upgradeCalibration(v1);
    expect(up.sections).toEqual(v1.sections);
    expect(up.status).toBe('verified');
  });
});

// ── Factory ─────────────────────────────────────────────────────────────────

describe('emptyCalibration', () => {
  it('is a v2 draft with empty sections/systems/bars', () => {
    const c = emptyCalibration();
    expect(c).toEqual({
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
      status: 'draft',
      sections: [],
      systems: [],
      bars: [],
    });
  });
});

// ── Section helpers ─────────────────────────────────────────────────────────

describe('addSection', () => {
  it('appends a section with a fresh id and stays draft', () => {
    const c = addSection(emptyCalibration(), 1, 0.5, 0.25, 'Intro');
    expect(c.sections).toHaveLength(1);
    expect(c.sections[0]).toMatchObject({ page: 1, x: 0.5, y: 0.25, label: 'Intro' });
    expect(c.sections[0].id).toMatch(/[0-9a-f-]{36}/);
    expect(c.status).toBe('draft');
  });

  it('defaults a blank label and clamps coords into [0,1]', () => {
    const c = addSection(emptyCalibration(), 2, 1.4, -0.3);
    expect(c.sections[0]).toMatchObject({ x: 1, y: 0, label: '' });
  });

  it('resets a verified calibration back to draft', () => {
    const v = verify(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'));
    expect(v.status).toBe('verified');
    expect(addSection(v, 1, 0.2, 0.2, 'B').status).toBe('draft');
  });
});

describe('removeSection / relabelSection / moveSection', () => {
  const base = addSection(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'), 1, 0.2, 0.2, 'B');
  const idA = base.sections[0].id;

  it('removeSection drops by id and resets to draft', () => {
    const v = verify(base);
    const r = removeSection(v, idA);
    expect(r.sections.map((s) => s.label)).toEqual(['B']);
    expect(r.status).toBe('draft');
  });

  it('removeSection is a no-op (same ref) for an unknown id', () => {
    expect(removeSection(base, 'nope')).toBe(base);
  });

  it('removeSection cascades: nulls out bar.sectionId references', () => {
    let c = addSection(emptyCalibration(), 1, 0.1, 0.1, 'Intro');
    const secId = c.sections[0].id;
    c = addSystem(c, 1, 0.0, 0.3, 0.0, 1.0);
    c = autoDistributeBars(c, c.systems![0].id, 2);
    // Manually assign sectionId to bar (simulating future assignment).
    c = { ...c, bars: c.bars!.map((b, i) => i === 0 ? { ...b, sectionId: secId } : b) };
    expect(c.bars![0].sectionId).toBe(secId);

    const r = removeSection(c, secId);
    expect(r.bars![0].sectionId).toBeNull();
    expect(r.bars![1].sectionId).toBeNull(); // was already null
  });

  it('relabelSection updates the label and resets to draft', () => {
    const r = relabelSection(verify(base), idA, 'Verse');
    expect(r.sections[0].label).toBe('Verse');
    expect(r.status).toBe('draft');
  });

  it('moveSection updates clamped coords and resets to draft', () => {
    const r = moveSection(verify(base), idA, 2, -1);
    expect(r.sections[0]).toMatchObject({ x: 1, y: 0 });
    expect(r.status).toBe('draft');
  });

  it('mutators are no-ops (same ref) for an unknown id', () => {
    expect(relabelSection(base, 'nope', 'x')).toBe(base);
    expect(moveSection(base, 'nope', 0.5, 0.5)).toBe(base);
  });

  it('relabelSection clears converter confidence (manual edit)', () => {
    const seeded = { ...base, sections: base.sections.map((s) => ({ ...s, confidence: 0.4 })) };
    const r = relabelSection(seeded, idA, 'Verse');
    expect(r.sections[0].confidence).toBeUndefined();
    expect(r.sections[1].confidence).toBe(0.4); // untouched section keeps its confidence
  });

  it('moveSection clears converter confidence (manual edit)', () => {
    const seeded = { ...base, sections: base.sections.map((s) => ({ ...s, confidence: 0.4 })) };
    const r = moveSection(seeded, idA, 0.5, 0.5);
    expect(r.sections[0].confidence).toBeUndefined();
    expect(r.sections[1].confidence).toBe(0.4);
  });
});

describe('sectionsInOrder / sectionsForPage', () => {
  it('orders by page, then y, then x', () => {
    let c = emptyCalibration();
    c = addSection(c, 2, 0.5, 0.1, 'P2-top');
    c = addSection(c, 1, 0.9, 0.8, 'P1-low-right');
    c = addSection(c, 1, 0.1, 0.8, 'P1-low-left');
    c = addSection(c, 1, 0.5, 0.2, 'P1-high');
    expect(sectionsInOrder(c).map((s) => s.label)).toEqual([
      'P1-high', 'P1-low-left', 'P1-low-right', 'P2-top',
    ]);
  });

  it('sectionsForPage filters to one page in top→bottom order', () => {
    let c = emptyCalibration();
    c = addSection(c, 1, 0.5, 0.8, 'low');
    c = addSection(c, 2, 0.5, 0.5, 'other-page');
    c = addSection(c, 1, 0.5, 0.2, 'high');
    expect(sectionsForPage(c, 1).map((s) => s.label)).toEqual(['high', 'low']);
    expect(sectionsForPage(c, 2).map((s) => s.label)).toEqual(['other-page']);
  });
});

describe('canVerify (fail-closed promotion invariant)', () => {
  it('is false for an empty calibration', () => {
    expect(canVerify(emptyCalibration())).toBe(false);
  });

  it('is false when any section has a blank/whitespace label', () => {
    let c = addSection(emptyCalibration(), 1, 0.1, 0.1, 'Intro');
    c = addSection(c, 1, 0.2, 0.2, '   ');
    expect(canVerify(c)).toBe(false);
  });

  it('is true when every section carries a non-blank label', () => {
    let c = addSection(emptyCalibration(), 1, 0.1, 0.1, 'Intro');
    c = addSection(c, 1, 0.2, 0.2, 'Chorus');
    expect(canVerify(c)).toBe(true);
  });
});

describe('verify / isPerformable', () => {
  it('verify promotes only when the invariant holds', () => {
    expect(verify(emptyCalibration()).status).toBe('draft');
    const ok = verify(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'));
    expect(ok.status).toBe('verified');
  });

  it('verify is a no-op (same ref) on an already-verified calibration', () => {
    const v = verify(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'));
    expect(verify(v)).toBe(v);
  });

  it('isPerformable gates on verified status', () => {
    const draft = addSection(emptyCalibration(), 1, 0.1, 0.1, 'A');
    expect(isPerformable(draft)).toBe(false);
    expect(isPerformable(verify(draft))).toBe(true);
  });

  it('isPerformable is false for a verified-but-empty calibration', () => {
    expect(isPerformable(cal({ status: 'verified', sections: [] }))).toBe(false);
  });

  it('isPerformable fails closed on a verified payload that breaks the invariant', () => {
    const tampered = cal({
      status: 'verified',
      sections: [{ id: 'a', page: 1, x: 0.1, y: 0.1, label: '  ' }],
    });
    expect(isPerformable(tampered)).toBe(false);
  });
});

// ── System helpers ──────────────────────────────────────────────────────────

describe('addSystem', () => {
  it('appends a system with a fresh id and resets to draft', () => {
    const c = addSystem(emptyCalibration(), 1, 0.1, 0.3, 0.05, 0.95);
    expect(c.systems).toHaveLength(1);
    expect(c.systems![0]).toMatchObject({
      page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.05, xEnd: 0.95,
    });
    expect(c.systems![0].id).toMatch(/[0-9a-f-]{36}/);
    expect(c.status).toBe('draft');
  });

  it('clamps coords into [0,1]', () => {
    const c = addSystem(emptyCalibration(), 1, -0.1, 1.5, -0.2, 2.0);
    expect(c.systems![0]).toMatchObject({
      yTop: 0, yBottom: 1, xStart: 0, xEnd: 1,
    });
  });
});

describe('removeSystem', () => {
  it('removes the system and cascades to its bars', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    const sysId = c.systems![0].id;
    c = autoDistributeBars(c, sysId, 4);
    expect(c.bars).toHaveLength(4);

    const r = removeSystem(c, sysId);
    expect(r.systems).toHaveLength(0);
    expect(r.bars).toHaveLength(0);
    expect(r.status).toBe('draft');
  });

  it('is a no-op for an unknown id', () => {
    const c = emptyCalibration();
    expect(removeSystem(c, 'nope')).toBe(c);
  });

  it('renumbers surviving bars after cascade delete', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    c = addSystem(c, 1, 0.3, 0.5, 0.0, 1.0);
    const sys1 = c.systems![0].id;
    const sys2 = c.systems![1].id;
    c = autoDistributeBars(c, sys1, 2);
    c = autoDistributeBars(c, sys2, 3);
    expect(c.bars).toHaveLength(5);

    const r = removeSystem(c, sys1);
    expect(r.bars).toHaveLength(3);
    expect(r.bars!.map((b) => b.absNumber)).toEqual([1, 2, 3]);
  });
});

describe('systemsInOrder / systemsForPage', () => {
  it('orders by page, then yTop, then xStart', () => {
    let c = addSystem(emptyCalibration(), 2, 0.1, 0.3, 0.0, 1.0);
    c = addSystem(c, 1, 0.5, 0.7, 0.0, 1.0);
    c = addSystem(c, 1, 0.1, 0.3, 0.5, 1.0);
    c = addSystem(c, 1, 0.1, 0.3, 0.0, 0.5);
    const order = systemsInOrder(c).map((s) => `p${s.page}-y${s.yTop}-x${s.xStart}`);
    expect(order).toEqual(['p1-y0.1-x0', 'p1-y0.1-x0.5', 'p1-y0.5-x0', 'p2-y0.1-x0']);
  });

  it('systemsForPage filters to one page', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    c = addSystem(c, 2, 0.0, 0.2, 0.0, 1.0);
    c = addSystem(c, 1, 0.3, 0.5, 0.0, 1.0);
    expect(systemsForPage(c, 1)).toHaveLength(2);
    expect(systemsForPage(c, 2)).toHaveLength(1);
    expect(systemsForPage(c, 3)).toHaveLength(0);
  });
});

describe('resizeSystemBand', () => {
  it('updates the band y-extent, ordering and clamping the edges', () => {
    const c0 = addSystem(emptyCalibration(), 1, 0.2, 0.3, 0.0, 1.0);
    const id = c0.systems![0].id;
    // Pass edges out of order + out of range — they get sorted and clamped.
    const c = resizeSystemBand(c0, id, 0.6, 0.1);
    expect(c.systems![0].yTop).toBe(0.1);
    expect(c.systems![0].yBottom).toBe(0.6);
    expect(c.status).toBe('draft');
  });

  it('renumbers bars when a resize changes systems reading order', () => {
    let c = addSystem(emptyCalibration(), 1, 0.1, 0.2, 0.0, 1.0); // top
    c = addSystem(c, 1, 0.5, 0.6, 0.0, 1.0); // bottom
    const top = c.systems![0].id;
    const bottom = c.systems![1].id;
    c = autoDistributeBars(c, top, 2); // bars 1-2
    c = autoDistributeBars(c, bottom, 2); // bars 3-4

    // Drag the (currently bottom) system above the top one → it now reads first.
    c = resizeSystemBand(c, bottom, 0.0, 0.05);
    const ordered = barsInOrder(c);
    expect(ordered[0].systemId).toBe(bottom);
    expect(ordered[0].absNumber).toBe(1);
    expect(ordered[2].systemId).toBe(top);
    expect(ordered[2].absNumber).toBe(3);
  });

  it('ignores a degenerate (zero-height) band and an unknown id', () => {
    const c0 = addSystem(emptyCalibration(), 1, 0.2, 0.3, 0.0, 1.0);
    const id = c0.systems![0].id;
    expect(resizeSystemBand(c0, id, 0.4, 0.4)).toBe(c0);
    expect(resizeSystemBand(c0, 'nope', 0.1, 0.5)).toBe(c0);
  });

  it('clears converter confidence on the resized system (manual edit)', () => {
    let c = addSystem(emptyCalibration(), 1, 0.2, 0.3, 0.0, 1.0);
    c = addSystem(c, 1, 0.5, 0.6, 0.0, 1.0);
    c = { ...c, systems: c.systems!.map((s) => ({ ...s, confidence: 0.4 })) };
    const id = c.systems![0].id;
    const r = resizeSystemBand(c, id, 0.1, 0.25);
    const resized = r.systems!.find((s) => s.id === id)!;
    const other = r.systems!.find((s) => s.id !== id)!;
    expect(resized.confidence).toBeUndefined();
    expect(other.confidence).toBe(0.4);
  });
});

// ── Bar helpers ─────────────────────────────────────────────────────────────

describe('autoDistributeBars', () => {
  it('distributes count even bars across the system width', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.1, 0.9);
    const sysId = c.systems![0].id;
    c = autoDistributeBars(c, sysId, 4);

    expect(c.bars).toHaveLength(4);
    expect(c.status).toBe('draft');

    const bars = c.bars!;
    // Each bar spans 0.2 of the 0.8 system width.
    expect(bars[0].xStart).toBeCloseTo(0.1);
    expect(bars[0].xEnd).toBeCloseTo(0.3);
    expect(bars[1].xStart).toBeCloseTo(0.3);
    expect(bars[1].xEnd).toBeCloseTo(0.5);
    expect(bars[3].xEnd).toBeCloseTo(0.9);
    // sectionId is null (assignment deferred).
    expect(bars.every((b) => b.sectionId === null)).toBe(true);
  });

  it('replaces existing bars for that system', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    const sysId = c.systems![0].id;
    c = autoDistributeBars(c, sysId, 4);
    c = autoDistributeBars(c, sysId, 2);
    expect(c.bars).toHaveLength(2);
  });

  it('count=0 removes all bars for the system', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    const sysId = c.systems![0].id;
    c = autoDistributeBars(c, sysId, 4);
    c = autoDistributeBars(c, sysId, 0);
    expect(c.bars).toHaveLength(0);
  });

  it('is a no-op for an unknown systemId', () => {
    const c = emptyCalibration();
    expect(autoDistributeBars(c, 'nope', 4)).toBe(c);
  });

  it('renumbers globally across multiple systems in reading order', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    c = addSystem(c, 1, 0.3, 0.5, 0.0, 1.0);
    const sys1 = c.systems![0].id;
    const sys2 = c.systems![1].id;
    c = autoDistributeBars(c, sys1, 2);
    c = autoDistributeBars(c, sys2, 3);

    const ordered = barsInOrder(c);
    expect(ordered).toHaveLength(5);
    expect(ordered.map((b) => b.absNumber)).toEqual([1, 2, 3, 4, 5]);
    // First 2 belong to sys1, next 3 to sys2.
    expect(ordered[0].systemId).toBe(sys1);
    expect(ordered[1].systemId).toBe(sys1);
    expect(ordered[2].systemId).toBe(sys2);
  });

  it('count=1 produces one bar spanning the full system width', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.2, 0.8);
    const sysId = c.systems![0].id;
    c = autoDistributeBars(c, sysId, 1);
    expect(c.bars).toHaveLength(1);
    expect(c.bars![0].xStart).toBeCloseTo(0.2);
    expect(c.bars![0].xEnd).toBeCloseTo(0.8);
  });
});

describe('barsInOrder', () => {
  it('returns bars in global reading order (systems by page/y/x, bars by xStart)', () => {
    // Page 2 system before page 1 system in insert order — should still sort.
    let c = addSystem(emptyCalibration(), 2, 0.0, 0.2, 0.0, 1.0);
    c = addSystem(c, 1, 0.0, 0.2, 0.0, 1.0);
    const sysP2 = c.systems![0].id;
    const sysP1 = c.systems![1].id;
    c = autoDistributeBars(c, sysP2, 2);
    c = autoDistributeBars(c, sysP1, 3);

    const ordered = barsInOrder(c);
    expect(ordered).toHaveLength(5);
    // P1 bars first (absNumber 1-3), then P2 bars (absNumber 4-5).
    expect(ordered[0].systemId).toBe(sysP1);
    expect(ordered[2].systemId).toBe(sysP1);
    expect(ordered[3].systemId).toBe(sysP2);
  });

  it('returns empty for a calibration with no bars', () => {
    expect(barsInOrder(emptyCalibration())).toEqual([]);
  });
});

describe('tapToBar', () => {
  it('finds the bar closest to a tap within a system', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.3, 0.0, 1.0);
    const sysId = c.systems![0].id;
    c = autoDistributeBars(c, sysId, 4); // bars at 0-.25, .25-.5, .5-.75, .75-1

    // Tap in the middle of bar 3 (x=0.625, midpoint of .5-.75).
    const bar = tapToBar(c, 1, 0.625, 0.15);
    expect(bar).not.toBeNull();
    expect(bar!.absNumber).toBe(3);
  });

  it('returns null when no systems exist on the page', () => {
    const c = addSystem(emptyCalibration(), 1, 0.0, 0.3, 0.0, 1.0);
    expect(tapToBar(c, 2, 0.5, 0.5)).toBeNull();
  });

  it('returns null when the system has no bars', () => {
    const c = addSystem(emptyCalibration(), 1, 0.0, 0.3, 0.0, 1.0);
    expect(tapToBar(c, 1, 0.5, 0.15)).toBeNull();
  });

  it('picks the nearest system by y when tap is outside all bands', () => {
    let c = addSystem(emptyCalibration(), 1, 0.1, 0.2, 0.0, 1.0); // top system
    c = addSystem(c, 1, 0.7, 0.8, 0.0, 1.0); // bottom system
    const topSys = c.systems![0].id;
    const botSys = c.systems![1].id;
    c = autoDistributeBars(c, topSys, 2);
    c = autoDistributeBars(c, botSys, 2);

    // Tap at y=0.6 — closer to bottom system (0.7) than top system (0.2).
    const bar = tapToBar(c, 1, 0.25, 0.6);
    expect(bar).not.toBeNull();
    expect(bar!.systemId).toBe(botSys);
  });

  it('picks the nearest bar by midpoint distance', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.3, 0.0, 1.0);
    const sysId = c.systems![0].id;
    c = autoDistributeBars(c, sysId, 4);
    // Tap at x=0.24 — bar 1 midpoint=0.125, bar 2 midpoint=0.375 → closer to bar 1.
    const bar = tapToBar(c, 1, 0.24, 0.15);
    expect(bar).not.toBeNull();
    expect(bar!.absNumber).toBe(1);
  });
});

describe('findSystem', () => {
  it('returns the system by id, or null when absent', () => {
    const c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    const sysId = c.systems![0].id;
    expect(findSystem(c, sysId)).toBe(c.systems![0]);
    expect(findSystem(c, 'nope')).toBeNull();
    expect(findSystem(emptyCalibration(), 'nope')).toBeNull();
  });
});

describe('barsForPage', () => {
  it('returns only the bars whose system is on the page, in reading order', () => {
    let c = addSystem(emptyCalibration(), 1, 0.0, 0.2, 0.0, 1.0);
    c = addSystem(c, 2, 0.0, 0.2, 0.0, 1.0);
    const sysP1 = c.systems![0].id;
    const sysP2 = c.systems![1].id;
    c = autoDistributeBars(c, sysP1, 3);
    c = autoDistributeBars(c, sysP2, 2);

    const p1 = barsForPage(c, 1);
    expect(p1).toHaveLength(3);
    expect(p1.every((b) => b.systemId === sysP1)).toBe(true);
    expect(p1.map((b) => b.absNumber)).toEqual([1, 2, 3]);

    const p2 = barsForPage(c, 2);
    expect(p2).toHaveLength(2);
    expect(p2.every((b) => b.systemId === sysP2)).toBe(true);
  });

  it('returns empty for a page with no systems', () => {
    expect(barsForPage(emptyCalibration(), 1)).toEqual([]);
  });
});

describe('firstBar / nextBar / prevBar (redline transport)', () => {
  // Two systems on page 1 (top, bottom) + one on page 2 → exercises the sweep:
  // L→R within a system, snap to next system, cross pages.
  function threeSystemChart() {
    let c = addSystem(emptyCalibration(), 1, 0.1, 0.2, 0.0, 1.0); // top of p1
    c = addSystem(c, 1, 0.5, 0.6, 0.0, 1.0); // bottom of p1
    c = addSystem(c, 2, 0.1, 0.2, 0.0, 1.0); // p2
    const top = c.systems![0].id;
    const bottom = c.systems![1].id;
    const p2 = c.systems![2].id;
    c = autoDistributeBars(c, top, 2);
    c = autoDistributeBars(c, bottom, 2);
    c = autoDistributeBars(c, p2, 2);
    return { c, top, bottom, p2 };
  }

  it('firstBar is bar 1 in reading order', () => {
    const { c, top } = threeSystemChart();
    const b = firstBar(c);
    expect(b).not.toBeNull();
    expect(b!.absNumber).toBe(1);
    expect(b!.systemId).toBe(top);
  });

  it('firstBar is null with no bars', () => {
    expect(firstBar(emptyCalibration())).toBeNull();
  });

  it('nextBar advances L→R, snaps to next system, then crosses to the next page', () => {
    const { c, top, bottom, p2 } = threeSystemChart();
    const ordered = barsInOrder(c);
    // bar1 → bar2 stays in top system (L→R)
    const b2 = nextBar(c, ordered[0].id);
    expect(b2!.absNumber).toBe(2);
    expect(b2!.systemId).toBe(top);
    // bar2 → bar3 snaps to the bottom system (same page)
    const b3 = nextBar(c, ordered[1].id);
    expect(b3!.systemId).toBe(bottom);
    // bar4 → bar5 crosses to the page-2 system
    const b5 = nextBar(c, ordered[3].id);
    expect(b5!.systemId).toBe(p2);
  });

  it('nextBar returns null at the last bar', () => {
    const { c } = threeSystemChart();
    const ordered = barsInOrder(c);
    expect(nextBar(c, ordered[ordered.length - 1].id)).toBeNull();
  });

  it('prevBar steps backward and returns null at the first bar', () => {
    const { c } = threeSystemChart();
    const ordered = barsInOrder(c);
    expect(prevBar(c, ordered[2].id)!.absNumber).toBe(2);
    expect(prevBar(c, ordered[0].id)).toBeNull();
  });

  it('nextBar / prevBar return null for an unknown bar id', () => {
    const { c } = threeSystemChart();
    expect(nextBar(c, 'nope')).toBeNull();
    expect(prevBar(c, 'nope')).toBeNull();
  });
});

// ── Validators ──────────────────────────────────────────────────────────────

describe('isValidSectionAnchor', () => {
  const ok = { id: 'a', page: 1, x: 0.5, y: 0.5, label: 'Intro' };

  it('accepts a well-formed anchor (blank label allowed at this layer)', () => {
    expect(isValidSectionAnchor(ok)).toBe(true);
    expect(isValidSectionAnchor({ ...ok, label: '' })).toBe(true);
  });

  it('rejects non-objects and missing/blank id', () => {
    expect(isValidSectionAnchor(null)).toBe(false);
    expect(isValidSectionAnchor({ ...ok, id: '' })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, id: 5 })).toBe(false);
  });

  it('rejects non-integer or sub-1 pages', () => {
    expect(isValidSectionAnchor({ ...ok, page: 0 })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, page: 1.5 })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, page: -2 })).toBe(false);
  });

  it('rejects out-of-range or non-finite coords', () => {
    expect(isValidSectionAnchor({ ...ok, x: 1.01 })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, y: -0.01 })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, x: NaN })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, y: Infinity })).toBe(false);
  });

  it('accepts absent or in-range confidence, rejects out-of-range/non-finite', () => {
    expect(isValidSectionAnchor({ ...ok, confidence: 0 })).toBe(true);
    expect(isValidSectionAnchor({ ...ok, confidence: 1 })).toBe(true);
    expect(isValidSectionAnchor({ ...ok, confidence: 0.5 })).toBe(true);
    expect(isValidSectionAnchor({ ...ok, confidence: -0.01 })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, confidence: 1.01 })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, confidence: NaN })).toBe(false);
    expect(isValidSectionAnchor({ ...ok, confidence: '1' })).toBe(false);
  });
});

describe('isValidSystem', () => {
  const ok: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };

  it('accepts a well-formed system', () => {
    expect(isValidSystem(ok)).toBe(true);
  });

  it('rejects non-objects and empty id', () => {
    expect(isValidSystem(null)).toBe(false);
    expect(isValidSystem({ ...ok, id: '' })).toBe(false);
  });

  it('rejects yTop >= yBottom', () => {
    expect(isValidSystem({ ...ok, yTop: 0.5, yBottom: 0.5 })).toBe(false);
    expect(isValidSystem({ ...ok, yTop: 0.6, yBottom: 0.3 })).toBe(false);
  });

  it('rejects xStart >= xEnd', () => {
    expect(isValidSystem({ ...ok, xStart: 0.5, xEnd: 0.5 })).toBe(false);
    expect(isValidSystem({ ...ok, xStart: 0.9, xEnd: 0.1 })).toBe(false);
  });

  it('rejects out-of-range coords', () => {
    expect(isValidSystem({ ...ok, yTop: -0.01 })).toBe(false);
    expect(isValidSystem({ ...ok, xEnd: 1.01 })).toBe(false);
  });

  it('rejects non-integer page', () => {
    expect(isValidSystem({ ...ok, page: 1.5 })).toBe(false);
    expect(isValidSystem({ ...ok, page: 0 })).toBe(false);
  });

  it('accepts absent or in-range confidence, rejects out-of-range/non-finite', () => {
    expect(isValidSystem({ ...ok, confidence: 0 })).toBe(true);
    expect(isValidSystem({ ...ok, confidence: 1 })).toBe(true);
    expect(isValidSystem({ ...ok, confidence: -0.01 })).toBe(false);
    expect(isValidSystem({ ...ok, confidence: 1.01 })).toBe(false);
    expect(isValidSystem({ ...ok, confidence: NaN })).toBe(false);
  });
});

describe('isValidBar', () => {
  const ok: Bar = { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.25, absNumber: 1, sectionId: null };

  it('accepts a well-formed bar (null sectionId)', () => {
    expect(isValidBar(ok)).toBe(true);
  });

  it('accepts a bar with a non-empty sectionId', () => {
    expect(isValidBar({ ...ok, sectionId: 'sec1' })).toBe(true);
  });

  it('rejects empty sectionId string', () => {
    expect(isValidBar({ ...ok, sectionId: '' })).toBe(false);
  });

  it('rejects xStart >= xEnd', () => {
    expect(isValidBar({ ...ok, xStart: 0.5, xEnd: 0.5 })).toBe(false);
  });

  it('rejects absNumber < 1 or non-integer', () => {
    expect(isValidBar({ ...ok, absNumber: 0 })).toBe(false);
    expect(isValidBar({ ...ok, absNumber: 1.5 })).toBe(false);
  });

  it('rejects empty id or systemId', () => {
    expect(isValidBar({ ...ok, id: '' })).toBe(false);
    expect(isValidBar({ ...ok, systemId: '' })).toBe(false);
  });

  it('accepts absent or in-range confidence, rejects out-of-range/non-finite', () => {
    expect(isValidBar({ ...ok, confidence: 0 })).toBe(true);
    expect(isValidBar({ ...ok, confidence: 1 })).toBe(true);
    expect(isValidBar({ ...ok, confidence: -0.01 })).toBe(false);
    expect(isValidBar({ ...ok, confidence: 1.01 })).toBe(false);
    expect(isValidBar({ ...ok, confidence: NaN })).toBe(false);
  });
});

describe('isValidCalibration', () => {
  const section = { id: 'a', page: 1, x: 0.5, y: 0.5, label: 'Intro' };

  it('accepts a well-formed v1 calibration (no systems/bars)', () => {
    expect(isValidCalibration({
      schemaVersion: 1, status: 'draft', sections: [section],
    })).toBe(true);
  });

  it('accepts a well-formed v2 calibration with systems and bars', () => {
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    const bar: Bar = { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.5, absNumber: 1, sectionId: null };
    expect(isValidCalibration({
      schemaVersion: 2, status: 'draft', sections: [section], systems: [sys], bars: [bar],
    })).toBe(true);
  });

  it('rejects unknown status and non-numeric schema version', () => {
    expect(isValidCalibration({ ...cal(), status: 'published' })).toBe(false);
    expect(isValidCalibration({ ...cal(), schemaVersion: '1' })).toBe(false);
  });

  it('rejects a non-array sections field or an invalid section', () => {
    expect(isValidCalibration({ ...cal(), sections: {} })).toBe(false);
    expect(isValidCalibration({ ...cal(), sections: [{ ...section, page: 0 }] })).toBe(false);
  });

  it('rejects duplicate section ids', () => {
    expect(isValidCalibration({ ...cal(), sections: [section, section] })).toBe(false);
  });

  it('rejects duplicate system ids', () => {
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    expect(isValidCalibration({ ...cal(), systems: [sys, sys] })).toBe(false);
  });

  it('rejects duplicate bar ids', () => {
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    const bar: Bar = { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.5, absNumber: 1, sectionId: null };
    expect(isValidCalibration({ ...cal(), systems: [sys], bars: [bar, bar] })).toBe(false);
  });

  it('rejects bars referencing a non-existent system', () => {
    const bar: Bar = { id: 'b1', systemId: 'ghost', xStart: 0.0, xEnd: 0.5, absNumber: 1, sectionId: null };
    expect(isValidCalibration({ ...cal(), systems: [], bars: [bar] })).toBe(false);
  });

  it('rejects bars whose geometry exceeds parent system x-bounds', () => {
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.2, xEnd: 0.8 };
    // Bar starts before system.
    expect(isValidCalibration({
      ...cal(), systems: [sys],
      bars: [{ id: 'b1', systemId: 's1', xStart: 0.1, xEnd: 0.5, absNumber: 1, sectionId: null }],
    })).toBe(false);
    // Bar ends after system.
    expect(isValidCalibration({
      ...cal(), systems: [sys],
      bars: [{ id: 'b2', systemId: 's1', xStart: 0.3, xEnd: 0.9, absNumber: 1, sectionId: null }],
    })).toBe(false);
    // Bar within bounds — OK.
    expect(isValidCalibration({
      ...cal(), systems: [sys],
      bars: [{ id: 'b3', systemId: 's1', xStart: 0.2, xEnd: 0.8, absNumber: 1, sectionId: null }],
    })).toBe(true);
  });

  it('rejects bars with sectionId referencing a non-existent section', () => {
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    const bar: Bar = { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.5, absNumber: 1, sectionId: 'ghost' };
    expect(isValidCalibration({ ...cal(), systems: [sys], bars: [bar] })).toBe(false);
  });

  it('accepts bars with sectionId referencing an existing section', () => {
    const sec = { id: 'sec1', page: 1, x: 0.1, y: 0.1, label: 'Intro' };
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    const bar: Bar = { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.5, absNumber: 1, sectionId: 'sec1' };
    expect(isValidCalibration({
      ...cal(), sections: [sec], systems: [sys], bars: [bar],
    })).toBe(true);
  });

  it('rejects an invalid system in the array', () => {
    expect(isValidCalibration({ ...cal(), systems: [{ id: 's1', page: 0 }] })).toBe(false);
  });

  it('rejects an invalid bar in the array', () => {
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    expect(isValidCalibration({
      ...cal(), systems: [sys], bars: [{ id: 'b1', systemId: 's1', xStart: 0.5, xEnd: 0.5, absNumber: 1, sectionId: null }],
    })).toBe(false);
  });

  it('accepts systems:undefined and bars:undefined (v1 compat)', () => {
    expect(isValidCalibration({
      schemaVersion: 1, status: 'draft', sections: [],
    })).toBe(true);
  });

  it('rejects bars whose absNumber is not the dense 1..n reading order', () => {
    const sys: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    // Two bars in reading order (b1 then b2) but absNumber has a gap (1, 3).
    expect(isValidCalibration({
      ...cal(), systems: [sys],
      bars: [
        { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.4, absNumber: 1, sectionId: null },
        { id: 'b2', systemId: 's1', xStart: 0.5, xEnd: 0.9, absNumber: 3, sectionId: null },
      ],
    })).toBe(false);
    // absNumber disagrees with xStart reading order (b1 left=2, b2 right=1).
    expect(isValidCalibration({
      ...cal(), systems: [sys],
      bars: [
        { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.4, absNumber: 2, sectionId: null },
        { id: 'b2', systemId: 's1', xStart: 0.5, xEnd: 0.9, absNumber: 1, sectionId: null },
      ],
    })).toBe(false);
  });

  it('accepts bars whose absNumber matches reading order across systems', () => {
    const s1: System = { id: 's1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0.0, xEnd: 1.0 };
    const s2: System = { id: 's2', page: 1, yTop: 0.4, yBottom: 0.6, xStart: 0.0, xEnd: 1.0 };
    expect(isValidCalibration({
      ...cal(), systems: [s1, s2],
      bars: [
        { id: 'b1', systemId: 's1', xStart: 0.0, xEnd: 0.4, absNumber: 1, sectionId: null },
        { id: 'b2', systemId: 's1', xStart: 0.5, xEnd: 0.9, absNumber: 2, sectionId: null },
        { id: 'b3', systemId: 's2', xStart: 0.0, xEnd: 0.4, absNumber: 3, sectionId: null },
      ],
    })).toBe(true);
  });
});

// ── hashPdfBytes ────────────────────────────────────────────────────────────

describe('hashPdfBytes', () => {
  it('is the sha256 hex of the bytes (stable, known vector)', async () => {
    const empty = await hashPdfBytes(new Uint8Array(0));
    expect(empty).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches between a Uint8Array view and its ArrayBuffer', async () => {
    const bytes = new TextEncoder().encode('chart-pdf-bytes');
    const fromView = await hashPdfBytes(bytes);
    const fromBuffer = await hashPdfBytes(bytes.buffer.slice(0));
    expect(fromView).toBe(fromBuffer);
    expect(fromView).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different content', async () => {
    const a = await hashPdfBytes(new TextEncoder().encode('a'));
    const b = await hashPdfBytes(new TextEncoder().encode('b'));
    expect(a).not.toBe(b);
  });
});

// ── Roadmap resolver (nav graph) ────────────────────────────────────────────

// A single-system chart of `n` bars: ids b1..bn, dense reading order.
function barsChart(n: number, roadmap?: RoadmapMarker[]): ChartCalibration {
  const sys: System = { id: 'sys1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0, xEnd: 1 };
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      id: `b${i + 1}`, systemId: 'sys1',
      xStart: i / n, xEnd: (i + 1) / n,
      absNumber: i + 1, sectionId: null,
    });
  }
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    status: 'draft',
    sections: [{ id: 'sec', page: 1, x: 0.05, y: 0.05, label: 'A' }],
    systems: [sys], bars, roadmap,
  };
}

// Flatten a successful resolve to a bar-id play order (throws on error so a
// mis-specified test fails loudly with the reason).
function order(c: ChartCalibration): string[] {
  const r = resolveRoadmap(c);
  if (!r.ok) throw new Error(`expected resolve ok, got error: ${r.error.reason}`);
  return r.traversal.map((t) => t.barId);
}

function expectError(c: ChartCalibration): { markerIds: string[]; reason: string } {
  const r = resolveRoadmap(c);
  if (r.ok) throw new Error('expected a RoadmapError but resolve succeeded');
  return r.error;
}

describe('resolveRoadmap — degenerate / linear', () => {
  it('empty roadmap ⇒ linear barsInOrder, each pass 1 (back-compat)', () => {
    const c = barsChart(4, []);
    const r = resolveRoadmap(c);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.traversal).toEqual([
        { barId: 'b1', pass: 1 }, { barId: 'b2', pass: 1 },
        { barId: 'b3', pass: 1 }, { barId: 'b4', pass: 1 },
      ]);
    }
  });

  it('absent roadmap ⇒ linear', () => {
    expect(order(barsChart(3))).toEqual(['b1', 'b2', 'b3']);
  });
});

describe('resolveRoadmap — repeats', () => {
  it('simple repeat (times:2) plays the span exactly twice', () => {
    const c = barsChart(8, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
    ]);
    expect(order(c)).toEqual([
      'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8',
      'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8',
    ]);
  });

  it('records pass numbers (1 then 2) across the repeat', () => {
    const c = barsChart(2, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b2', edge: 'end', repeatStartId: 'rs', times: 2 },
    ]);
    const r = resolveRoadmap(c);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.traversal).toEqual([
        { barId: 'b1', pass: 1 }, { barId: 'b2', pass: 1 },
        { barId: 'b1', pass: 2 }, { barId: 'b2', pass: 2 },
      ]);
    }
  });

  it('times defaults to 2 when omitted', () => {
    const c = barsChart(4, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b4', edge: 'end', repeatStartId: 'rs' },
    ]);
    expect(order(c)).toEqual(['b1', 'b2', 'b3', 'b4', 'b1', 'b2', 'b3', 'b4']);
  });

  it('times:3 plays the span exactly three times (exact counter)', () => {
    const c = barsChart(2, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b2', edge: 'end', repeatStartId: 'rs', times: 3 },
    ]);
    expect(order(c)).toEqual(['b1', 'b2', 'b1', 'b2', 'b1', 'b2']);
  });

  it('a lone repeatStart is a cosmetic no-op (linear)', () => {
    const c = barsChart(3, [
      { id: 'rs', kind: 'repeatStart', barId: 'b2', edge: 'start' },
    ]);
    expect(order(c)).toEqual(['b1', 'b2', 'b3']);
  });

  it('nested repeats: inner replays in full on every outer pass', () => {
    const c = barsChart(16, [
      { id: 'out', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'outE', kind: 'repeatEnd', barId: 'b16', edge: 'end', repeatStartId: 'out', times: 2 },
      { id: 'inn', kind: 'repeatStart', barId: 'b5', edge: 'start' },
      { id: 'innE', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'inn', times: 2 },
    ]);
    const ids = (n: number[]) => n.map((x) => `b${x}`);
    expect(order(c)).toEqual([
      ...ids([1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      ...ids([1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    ]);
  });
});

describe('resolveRoadmap — voltas (1st/2nd/3rd endings)', () => {
  it('plays common section then each ending in turn', () => {
    const c = barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b5', 'b6'], numbers: [1] },
      { id: 'e2', kind: 'ending', repeatStartId: 'rs', barIds: ['b7', 'b8'], numbers: [2] },
      { id: 'e3', kind: 'ending', repeatStartId: 'rs', barIds: ['b9', 'b10'], numbers: [3] },
    ]);
    const ids = (n: number[]) => n.map((x) => `b${x}`);
    expect(order(c)).toEqual([
      ...ids([1, 2, 3, 4, 5, 6]),
      ...ids([1, 2, 3, 4, 7, 8]),
      ...ids([1, 2, 3, 4, 9, 10]),
    ]);
  });

  it('supports an ending that covers multiple passes (numbers:[1,3])', () => {
    const c = barsChart(8, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b5', 'b6'], numbers: [1, 3] },
      { id: 'e2', kind: 'ending', repeatStartId: 'rs', barIds: ['b7', 'b8'], numbers: [2] },
    ]);
    const ids = (n: number[]) => n.map((x) => `b${x}`);
    expect(order(c)).toEqual([
      ...ids([1, 2, 3, 4, 5, 6]),
      ...ids([1, 2, 3, 4, 7, 8]),
      ...ids([1, 2, 3, 4, 5, 6]),
    ]);
  });
});

describe('resolveRoadmap — D.C./D.S./Coda/Fine', () => {
  it('plain D.C. (from capo) replays the whole piece once, no repeats needed', () => {
    const c = barsChart(16, [
      { id: 'dc', kind: 'jump', barId: 'b16', edge: 'end', from: 'capo', until: 'end' },
    ]);
    const ids = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `b${a + i}`);
    expect(order(c)).toEqual([...ids(1, 16), ...ids(1, 16)]);
  });

  it('D.S. al Coda al Fine: jumps to segno, arms coda, takes To Coda, ignores Fine', () => {
    const c = barsChart(20, [
      { id: 'segno', kind: 'segno', barId: 'b5', edge: 'start' },
      { id: 'tc', kind: 'toCoda', barId: 'b12', edge: 'end' },
      { id: 'coda', kind: 'coda', barId: 'b20', edge: 'start' },
      { id: 'fine', kind: 'fine', barId: 'b16', edge: 'end' },
      { id: 'ds', kind: 'jump', barId: 'b16', edge: 'end', from: 'segno', until: 'coda' },
    ]);
    const ids = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `b${a + i}`);
    expect(order(c)).toEqual([...ids(1, 16), ...ids(5, 12), 'b20']);
  });

  it('D.C. al Fine stops at Fine on the return pass', () => {
    const c = barsChart(16, [
      { id: 'fine', kind: 'fine', barId: 'b8', edge: 'end' },
      { id: 'dc', kind: 'jump', barId: 'b16', edge: 'end', from: 'capo', until: 'fine' },
    ]);
    const ids = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `b${a + i}`);
    // 1..16, then capo 1..8 and stop at Fine (bar 8 end).
    expect(order(c)).toEqual([...ids(1, 16), ...ids(1, 8)]);
  });

  it('To Coda is inert before the al Coda jump arms it', () => {
    // First pass through bar 12 must NOT divert — only the post-jump pass does.
    const c = barsChart(20, [
      { id: 'segno', kind: 'segno', barId: 'b5', edge: 'start' },
      { id: 'tc', kind: 'toCoda', barId: 'b12', edge: 'end' },
      { id: 'coda', kind: 'coda', barId: 'b20', edge: 'start' },
      { id: 'ds', kind: 'jump', barId: 'b16', edge: 'end', from: 'segno', until: 'coda' },
    ]);
    const ids = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `b${a + i}`);
    expect(order(c)).toEqual([...ids(1, 16), ...ids(5, 12), 'b20']);
  });
});

describe('resolveRoadmap — contradiction rejection (§5)', () => {
  it('#1 D.S. with no Segno', () => {
    expect(expectError(barsChart(8, [
      { id: 'ds', kind: 'jump', barId: 'b8', edge: 'end', from: 'segno', until: 'end' },
    ])).reason).toMatch(/Segno/);
  });

  it('#1 al Coda with no Coda', () => {
    expect(expectError(barsChart(8, [
      { id: 'ds', kind: 'jump', barId: 'b8', edge: 'end', from: 'capo', until: 'coda' },
    ])).reason).toMatch(/Coda/);
  });

  it('#1 al Coda with no To Coda departure', () => {
    expect(expectError(barsChart(8, [
      { id: 'coda', kind: 'coda', barId: 'b6', edge: 'start' },
      { id: 'ds', kind: 'jump', barId: 'b8', edge: 'end', from: 'capo', until: 'coda' },
    ])).reason).toMatch(/To Coda/);
  });

  it('#1 al Fine with no Fine', () => {
    expect(expectError(barsChart(8, [
      { id: 'ds', kind: 'jump', barId: 'b8', edge: 'end', from: 'capo', until: 'fine' },
    ])).reason).toMatch(/Fine/);
  });

  it('#1 To Coda with no Coda', () => {
    expect(expectError(barsChart(8, [
      { id: 'tc', kind: 'toCoda', barId: 'b6', edge: 'end' },
    ])).reason).toMatch(/Coda/);
  });

  it('rejects two jump markers on the same bar (silent-overwrite guard)', () => {
    const e = expectError(barsChart(8, [
      { id: 'j1', kind: 'jump', barId: 'b8', edge: 'end', from: 'capo', until: 'end' },
      { id: 'j2', kind: 'jump', barId: 'b8', edge: 'end', from: 'capo', until: 'end' },
    ]));
    expect(e.reason).toMatch(/duplicate jump/);
    expect(e.markerIds.sort()).toEqual(['j1', 'j2']);
  });

  it('rejects two repeatEnd markers on the same bar', () => {
    expect(expectError(barsChart(8, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're1', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
      { id: 're2', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
    ])).reason).toMatch(/duplicate repeatEnd/);
  });

  it('rejects two toCoda markers on the same bar', () => {
    expect(expectError(barsChart(8, [
      { id: 'coda', kind: 'coda', barId: 'b6', edge: 'start' },
      { id: 'tc1', kind: 'toCoda', barId: 'b4', edge: 'end' },
      { id: 'tc2', kind: 'toCoda', barId: 'b4', edge: 'end' },
    ])).reason).toMatch(/duplicate toCoda/);
  });

  it('#2 multiple Segno', () => {
    const e = expectError(barsChart(8, [
      { id: 's1', kind: 'segno', barId: 'b2', edge: 'start' },
      { id: 's2', kind: 'segno', barId: 'b4', edge: 'start' },
    ]));
    expect(e.reason).toMatch(/multiple Segno/);
    expect(e.markerIds).toEqual(['s1', 's2']);
  });

  it('#3 volta passes do not partition (gap)', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b5', 'b6'], numbers: [1] },
      { id: 'e3', kind: 'ending', repeatStartId: 'rs', barIds: ['b7', 'b8'], numbers: [3] },
    ])).reason).toMatch(/partition/);
  });

  it('#3 volta passes overlap', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b5', 'b6'], numbers: [1] },
      { id: 'e2', kind: 'ending', repeatStartId: 'rs', barIds: ['b7', 'b8'], numbers: [1, 2] },
    ])).reason).toMatch(/overlap/);
  });

  it('#4 mixed expression (plain repeatEnd AND volta on one repeat)', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b9', 'b10'], numbers: [1] },
    ])).reason).toMatch(/both/);
  });

  it('#4 multiple repeatEnd bound to one repeatStart', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're1', kind: 'repeatEnd', barId: 'b6', edge: 'end', repeatStartId: 'rs', times: 2 },
      { id: 're2', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
    ])).reason).toMatch(/multiple repeatEnd/);
  });

  it('#5 repeatEnd precedes its repeatStart (inverted span)', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b8', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b4', edge: 'end', repeatStartId: 'rs', times: 2 },
    ])).reason).toMatch(/precedes/);
  });

  it('#5 volta bar precedes its repeatStart', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b6', edge: 'start' },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b2', 'b3'], numbers: [1] },
      { id: 'e2', kind: 'ending', repeatStartId: 'rs', barIds: ['b7', 'b8'], numbers: [2] },
    ])).reason).toMatch(/precedes/);
  });

  it('#6 ending bars not contiguous', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b5', 'b7'], numbers: [1] },
      { id: 'e2', kind: 'ending', repeatStartId: 'rs', barIds: ['b8', 'b9'], numbers: [2] },
    ])).reason).toMatch(/contiguous/);
  });

  it('#6 endings overlap / share a bar', () => {
    expect(expectError(barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b5', 'b6'], numbers: [1] },
      { id: 'e2', kind: 'ending', repeatStartId: 'rs', barIds: ['b6', 'b7'], numbers: [2] },
    ])).reason).toMatch(/overlap|share/);
  });

  it('#7 marker references a missing bar (defensive)', () => {
    expect(expectError(barsChart(4, [
      { id: 'rs', kind: 'repeatStart', barId: 'bZ', edge: 'start' },
    ])).reason).toMatch(/missing bar/);
  });

  it('#7 repeatEnd not bound to a real repeatStart (defensive)', () => {
    expect(expectError(barsChart(8, [
      { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'ghost', times: 2 },
    ])).reason).toMatch(/repeatStart/);
  });

  it('#8 a deeply nested LEGAL roadmap stays under the cap and resolves', () => {
    // 3 levels of x2 repeats = ×8 expansion; the multiplicative cap must not
    // false-positive a legal traversal (additive cap would).
    const c = barsChart(12, [
      { id: 'r1', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'r1e', kind: 'repeatEnd', barId: 'b12', edge: 'end', repeatStartId: 'r1', times: 2 },
      { id: 'r2', kind: 'repeatStart', barId: 'b3', edge: 'start' },
      { id: 'r2e', kind: 'repeatEnd', barId: 'b10', edge: 'end', repeatStartId: 'r2', times: 2 },
      { id: 'r3', kind: 'repeatStart', barId: 'b5', edge: 'start' },
      { id: 'r3e', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'r3', times: 2 },
    ]);
    const r = resolveRoadmap(c);
    expect(r.ok).toBe(true);
  });
});

describe('isValidRoadmapMarkerShape (structural)', () => {
  it('accepts each well-formed marker kind', () => {
    const good: RoadmapMarker[] = [
      { id: 'a', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'b', kind: 'repeatEnd', barId: 'b2', edge: 'end', repeatStartId: 'a', times: 2 },
      { id: 'c', kind: 'ending', repeatStartId: 'a', barIds: ['b3'], numbers: [1] },
      { id: 'd', kind: 'segno', barId: 'b1', edge: 'start' },
      { id: 'e', kind: 'coda', barId: 'b1', edge: 'start' },
      { id: 'f', kind: 'toCoda', barId: 'b1', edge: 'end' },
      { id: 'g', kind: 'fine', barId: 'b1', edge: 'end' },
      { id: 'h', kind: 'jump', barId: 'b1', edge: 'end', from: 'segno', until: 'coda' },
    ];
    expect(good.every(isValidRoadmapMarkerShape)).toBe(true);
  });

  it('accepts an optional finite confidence', () => {
    expect(isValidRoadmapMarkerShape(
      { id: 'a', kind: 'repeatStart', barId: 'b1', edge: 'start', confidence: 0.4 },
    )).toBe(true);
  });

  it('rejects unknown kinds, wrong edge, bad enums, NaN confidence', () => {
    expect(isValidRoadmapMarkerShape({ id: 'a', kind: 'nope', barId: 'b1' })).toBe(false);
    expect(isValidRoadmapMarkerShape({ id: 'a', kind: 'repeatStart', barId: 'b1', edge: 'end' })).toBe(false);
    expect(isValidRoadmapMarkerShape({ id: 'a', kind: 'jump', barId: 'b1', edge: 'end', from: 'x', until: 'end' })).toBe(false);
    expect(isValidRoadmapMarkerShape({ id: 'a', kind: 'repeatStart', barId: 'b1', edge: 'start', confidence: NaN })).toBe(false);
    expect(isValidRoadmapMarkerShape({ id: '', kind: 'segno', barId: 'b1', edge: 'start' })).toBe(false);
  });

  it('rejects an ending with empty barIds or numbers', () => {
    expect(isValidRoadmapMarkerShape({ id: 'a', kind: 'ending', repeatStartId: 'r', barIds: [], numbers: [1] })).toBe(false);
    expect(isValidRoadmapMarkerShape({ id: 'a', kind: 'ending', repeatStartId: 'r', barIds: ['b1'], numbers: [] })).toBe(false);
  });
});

describe('isValidCalibration — roadmap (structural)', () => {
  const base = () => barsChart(8);

  it('accepts a well-formed roadmap', () => {
    const c = barsChart(8, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
    ]);
    expect(isValidCalibration(c)).toBe(true);
  });

  it('rejects a roadmap with no bars', () => {
    const c = base();
    expect(isValidCalibration({
      ...c, bars: [], roadmap: [{ id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' }],
    })).toBe(false);
  });

  it('rejects a marker referencing a non-existent bar', () => {
    expect(isValidCalibration({
      ...base(), roadmap: [{ id: 'rs', kind: 'repeatStart', barId: 'ghost', edge: 'start' }],
    })).toBe(false);
  });

  it('rejects a repeatEnd bound to a non-repeatStart marker', () => {
    expect(isValidCalibration({
      ...base(),
      roadmap: [
        { id: 'seg', kind: 'segno', barId: 'b1', edge: 'start' },
        { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'seg', times: 2 },
      ],
    })).toBe(false);
  });

  it('rejects duplicate marker ids', () => {
    expect(isValidCalibration({
      ...base(),
      roadmap: [
        { id: 'dup', kind: 'repeatStart', barId: 'b1', edge: 'start' },
        { id: 'dup', kind: 'segno', barId: 'b2', edge: 'start' },
      ],
    })).toBe(false);
  });

  it('STRUCTURALLY accepts a draft that does NOT resolve (BLOCKER-1: no authoring lockout)', () => {
    // A D.S. dropped before its Segno is a temporary contradiction: structurally
    // valid (persists/reloads), but resolveRoadmap fails (cannot verify).
    const c = barsChart(8, [
      { id: 'ds', kind: 'jump', barId: 'b8', edge: 'end', from: 'segno', until: 'end' },
    ]);
    expect(isValidCalibration(c)).toBe(true);
    expect(resolveRoadmap(c).ok).toBe(false);
  });
});

describe('canVerify — roadmap promotion gate', () => {
  it('blocks verify when a present roadmap does not resolve', () => {
    const c = barsChart(8, [
      { id: 'ds', kind: 'jump', barId: 'b8', edge: 'end', from: 'segno', until: 'end' },
    ]);
    expect(canVerify(c)).toBe(false);
  });

  it('allows verify when the roadmap resolves', () => {
    const c = barsChart(8, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
    ]);
    expect(canVerify(c)).toBe(true);
  });

  it('is unaffected for a no-roadmap chart with labeled sections', () => {
    expect(canVerify(barsChart(4))).toBe(true);
  });
});

describe('removeSystem — roadmap cascade pruning', () => {
  // Two systems on one page: sys1 = b1..b4, sys2 = b5..b8.
  function twoSystemChart(roadmap: RoadmapMarker[]): ChartCalibration {
    const sys1: System = { id: 'sys1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0, xEnd: 1 };
    const sys2: System = { id: 'sys2', page: 1, yTop: 0.4, yBottom: 0.6, xStart: 0, xEnd: 1 };
    const bars: Bar[] = [];
    for (let i = 0; i < 4; i++) {
      bars.push({ id: `b${i + 1}`, systemId: 'sys1', xStart: i / 4, xEnd: (i + 1) / 4, absNumber: i + 1, sectionId: null });
    }
    for (let i = 0; i < 4; i++) {
      bars.push({ id: `b${i + 5}`, systemId: 'sys2', xStart: i / 4, xEnd: (i + 1) / 4, absNumber: i + 5, sectionId: null });
    }
    return {
      schemaVersion: CALIBRATION_SCHEMA_VERSION, status: 'verified',
      sections: [{ id: 'sec', page: 1, x: 0.05, y: 0.05, label: 'A' }],
      systems: [sys1, sys2], bars, roadmap,
    };
  }

  it('prunes markers whose bars vanish and resets to draft', () => {
    const c = twoSystemChart([
      { id: 'seg', kind: 'segno', barId: 'b2', edge: 'start' },
      { id: 'coda', kind: 'coda', barId: 'b6', edge: 'start' },
    ]);
    const next = removeSystem(c, 'sys2');
    expect(next.status).toBe('draft');
    expect(next.roadmap?.map((m) => m.id)).toEqual(['seg']);
  });

  it('drops an ending/repeatEnd orphaned when its repeatStart is pruned', () => {
    const c = twoSystemChart([
      // repeatStart in sys2 (b5); its repeatEnd in sys1 (b4) would orphan.
      { id: 'rs', kind: 'repeatStart', barId: 'b5', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b4', edge: 'end', repeatStartId: 'rs', times: 2 },
    ]);
    const next = removeSystem(c, 'sys2');
    // rs removed (bar gone) ⇒ re must be dropped too (dangling binding).
    expect(next.roadmap).toEqual([]);
  });

  it('leaves the roadmap undefined when there was none', () => {
    const c = twoSystemChart([]);
    const noRoadmap = { ...c, roadmap: undefined };
    expect(removeSystem(noRoadmap, 'sys2').roadmap).toBeUndefined();
  });
});

describe('autoDistributeBars — roadmap cascade pruning', () => {
  it('prunes markers referencing bars replaced by a new distribution', () => {
    const sys: System = { id: 'sys1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0, xEnd: 1 };
    const bars: Bar[] = [
      { id: 'b1', systemId: 'sys1', xStart: 0, xEnd: 0.5, absNumber: 1, sectionId: null },
      { id: 'b2', systemId: 'sys1', xStart: 0.5, xEnd: 1, absNumber: 2, sectionId: null },
    ];
    const c: ChartCalibration = {
      schemaVersion: CALIBRATION_SCHEMA_VERSION, status: 'verified',
      sections: [{ id: 'sec', page: 1, x: 0.05, y: 0.05, label: 'A' }],
      systems: [sys], bars,
      roadmap: [{ id: 'seg', kind: 'segno', barId: 'b2', edge: 'start' }],
    };
    // The − N + stepper replaces sys1's bars with fresh ids → b2 vanishes.
    const next = autoDistributeBars(c, 'sys1', 4);
    expect(next.status).toBe('draft');
    expect(next.roadmap).toEqual([]);
    // No dangling FK ⇒ still structurally valid (the bug this fix prevents).
    expect(isValidCalibration(next)).toBe(true);
  });

  it('keeps markers referencing bars in untouched systems', () => {
    const sys1: System = { id: 'sys1', page: 1, yTop: 0.1, yBottom: 0.3, xStart: 0, xEnd: 1 };
    const sys2: System = { id: 'sys2', page: 1, yTop: 0.4, yBottom: 0.6, xStart: 0, xEnd: 1 };
    const bars: Bar[] = [
      { id: 'a1', systemId: 'sys1', xStart: 0, xEnd: 1, absNumber: 1, sectionId: null },
      { id: 'c1', systemId: 'sys2', xStart: 0, xEnd: 1, absNumber: 2, sectionId: null },
    ];
    const c: ChartCalibration = {
      schemaVersion: CALIBRATION_SCHEMA_VERSION, status: 'draft',
      sections: [{ id: 'sec', page: 1, x: 0.05, y: 0.05, label: 'A' }],
      systems: [sys1, sys2], bars,
      roadmap: [{ id: 'seg', kind: 'segno', barId: 'c1', edge: 'start' }],
    };
    const next = autoDistributeBars(c, 'sys1', 3);
    expect(next.roadmap?.map((m) => m.id)).toEqual(['seg']);
  });
});

describe('enclosingRepeatStartId (Roadmap-tool :|/volta binding)', () => {
  it('returns null when no repeatStart precedes the bar', () => {
    const c = barsChart(4, []);
    expect(enclosingRepeatStartId(c, 'b3')).toBeNull();
  });

  it('binds to the single enclosing repeatStart', () => {
    const c = barsChart(4, [{ id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' }]);
    expect(enclosingRepeatStartId(c, 'b4')).toBe('rs');
  });

  it('binds to a repeatStart on the same bar (at-or-before)', () => {
    const c = barsChart(4, [{ id: 'rs', kind: 'repeatStart', barId: 'b2', edge: 'start' }]);
    expect(enclosingRepeatStartId(c, 'b2')).toBe('rs');
  });

  it('picks the latest (innermost) repeatStart at-or-before the bar', () => {
    const c = barsChart(8, [
      { id: 'outer', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 'inner', kind: 'repeatStart', barId: 'b5', edge: 'start' },
    ]);
    expect(enclosingRepeatStartId(c, 'b6')).toBe('inner');
    expect(enclosingRepeatStartId(c, 'b3')).toBe('outer');
  });

  it('ignores a repeatStart that comes after the bar', () => {
    const c = barsChart(4, [{ id: 'rs', kind: 'repeatStart', barId: 'b3', edge: 'start' }]);
    expect(enclosingRepeatStartId(c, 'b2')).toBeNull();
  });

  it('returns null for an unknown bar id', () => {
    const c = barsChart(4, [{ id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' }]);
    expect(enclosingRepeatStartId(c, 'nope')).toBeNull();
  });
});

describe('addRoadmapMarker / removeRoadmapMarker', () => {
  it('appends a marker, creating the roadmap array and resetting to draft', () => {
    const c = { ...barsChart(4), status: 'verified' as const };
    const next = addRoadmapMarker(c, { id: 'seg', kind: 'segno', barId: 'b2', edge: 'start' });
    expect(next.status).toBe('draft');
    expect(next.roadmap).toEqual([{ id: 'seg', kind: 'segno', barId: 'b2', edge: 'start' }]);
  });

  it('removes a marker by id and resets to draft', () => {
    const c = barsChart(4, [
      { id: 'seg', kind: 'segno', barId: 'b2', edge: 'start' },
      { id: 'fine', kind: 'fine', barId: 'b4', edge: 'end' },
    ]);
    const next = removeRoadmapMarker({ ...c, status: 'verified' }, 'seg');
    expect(next.status).toBe('draft');
    expect(next.roadmap?.map((m) => m.id)).toEqual(['fine']);
  });

  it('removing a repeatStart cascades its bound repeatEnd and voltas', () => {
    const c = barsChart(10, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
      { id: 'e1', kind: 'ending', repeatStartId: 'rs', barIds: ['b5', 'b6'], numbers: [1] },
      { id: 'seg', kind: 'segno', barId: 'b9', edge: 'start' },
    ]);
    const next = removeRoadmapMarker(c, 'rs');
    // The orphaned :| and volta go with the |:; the unrelated segno survives.
    expect(next.roadmap?.map((m) => m.id)).toEqual(['seg']);
  });

  it('collapses an emptied roadmap to undefined (stays v2 on persist)', () => {
    const c = barsChart(4, [{ id: 'seg', kind: 'segno', barId: 'b2', edge: 'start' }]);
    const next = removeRoadmapMarker(c, 'seg');
    expect(next.roadmap).toBeUndefined();
  });

  it('removing an unknown id is a no-op (same reference)', () => {
    const c = barsChart(4, [{ id: 'seg', kind: 'segno', barId: 'b2', edge: 'start' }]);
    expect(removeRoadmapMarker(c, 'nope')).toBe(c);
  });
});

describe('summarizeTraversal (Roadmap-tool play-order readout)', () => {
  const c = barsChart(8);
  it('compresses a single consecutive run into one range', () => {
    const r = resolveRoadmap(c);
    expect(r.ok && summarizeTraversal(c, r.traversal)).toBe('1\u20138');
  });

  it('shows a repeated span as two ranges', () => {
    const rep = barsChart(8, [
      { id: 'rs', kind: 'repeatStart', barId: 'b1', edge: 'start' },
      { id: 're', kind: 'repeatEnd', barId: 'b8', edge: 'end', repeatStartId: 'rs', times: 2 },
    ]);
    const r = resolveRoadmap(rep);
    expect(r.ok && summarizeTraversal(rep, r.traversal)).toBe('1\u20138, 1\u20138');
  });

  it('breaks a run at a non-consecutive jump', () => {
    expect(summarizeTraversal(c, [
      { barId: 'b1', pass: 1 }, { barId: 'b2', pass: 1 },
      { barId: 'b5', pass: 1 }, { barId: 'b6', pass: 1 },
    ])).toBe('1\u20132, 5\u20136');
  });

  it('renders a single bar as a bare number (no range)', () => {
    expect(summarizeTraversal(c, [{ barId: 'b3', pass: 1 }])).toBe('3');
  });

  it('skips steps whose bar id is unknown, and returns empty for none', () => {
    expect(summarizeTraversal(c, [{ barId: 'ghost', pass: 1 }])).toBe('');
    expect(summarizeTraversal(c, [])).toBe('');
  });
});
