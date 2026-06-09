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
  upgradeToV2,
  systemsInOrder,
  systemsForPage,
  addSystem,
  removeSystem,
  autoDistributeBars,
  barsInOrder,
  tapToBar,
  isValidSystem,
  isValidBar,
  hashPdfBytes,
} from '../lib/chart-calibration';
import type { ChartCalibration, System, Bar } from '../lib/types';

function cal(over: Partial<ChartCalibration> = {}): ChartCalibration {
  return { ...emptyCalibration(), ...over };
}

// ── v1 → v2 upgrade ────────────────────────────────────────────────────────

describe('upgradeToV2', () => {
  it('adds systems/bars to a v1 calibration', () => {
    const v1: ChartCalibration = { schemaVersion: 1, status: 'draft', sections: [] };
    const v2 = upgradeToV2(v1);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.systems).toEqual([]);
    expect(v2.bars).toEqual([]);
    expect(v2.sections).toEqual([]);
  });

  it('is a no-op for v2 calibrations', () => {
    const v2 = emptyCalibration();
    expect(upgradeToV2(v2)).toBe(v2);
  });

  it('preserves existing sections', () => {
    const v1: ChartCalibration = {
      schemaVersion: 1,
      status: 'verified',
      sections: [{ id: 'a', page: 1, x: 0.5, y: 0.5, label: 'Intro' }],
    };
    const v2 = upgradeToV2(v1);
    expect(v2.sections).toEqual(v1.sections);
    expect(v2.status).toBe('verified');
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
