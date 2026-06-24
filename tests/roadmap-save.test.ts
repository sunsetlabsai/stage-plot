import { describe, it, expect } from 'vitest';
import { layoutRoadmap, buildCalibration } from '../lib/roadmap-render';
import { assertSpecCalibrationParity } from '../lib/roadmap-save';
import type { RoadmapSpec } from '../lib/roadmap-spec';
import type { ChartCalibration } from '../lib/types';

// A spec that exercises every parity dimension: multiple sections, a plain
// repeat, a volta repeat, and full navigation — so the renderer-bug guard is
// tested against a real, born-verified calibration rather than a hand-built one.
const SPEC: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'G',
  sections: [
    { id: 'intro', label: 'Intro', bars: 2 },
    { id: 'verse', label: 'Verse', bars: 4, repeat: { kind: 'plain', times: 2 } },
    {
      id: 'chorus',
      label: 'Chorus',
      bars: 8,
      repeat: {
        kind: 'volta',
        endings: [
          { bars: { start: 7, count: 1 }, passes: [1] },
          { bars: { start: 8, count: 1 }, passes: [2] },
        ],
      },
    },
  ],
  navigation: {
    segno: { section: 1, bar: 1 },
    coda: { section: 2, bar: 1 },
    toCoda: { section: 1, bar: 4 },
    fine: { section: 2, bar: 8 },
    jump: { at: { section: 2, bar: 8 }, from: 'segno', until: 'fine' },
  },
};

function buildCal(spec: RoadmapSpec): ChartCalibration {
  return buildCalibration(spec, layoutRoadmap(spec));
}

// Deep clone so a tampered copy can't mutate the shared fixture.
function clone(cal: ChartCalibration): ChartCalibration {
  return JSON.parse(JSON.stringify(cal)) as ChartCalibration;
}

describe('assertSpecCalibrationParity — renderer-bug guard (spec ↔ calibration)', () => {
  it('passes for a born-verified calibration of the same spec', () => {
    const r = assertSpecCalibrationParity(SPEC, buildCal(SPEC));
    expect(r.ok).toBe(true);
  });

  it('flags a dropped bar (renderer miscounts a section)', () => {
    const cal = clone(buildCal(SPEC));
    cal.bars!.pop(); // drop the last bar
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/bar count/i);
  });

  it('flags a mismatched section label', () => {
    const cal = clone(buildCal(SPEC));
    cal.sections[1].label = 'Bridge';
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/label/i);
  });

  it('flags a wrong section count', () => {
    const cal = clone(buildCal(SPEC));
    cal.sections.pop();
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/section count/i);
  });

  it('flags a bar reassigned to the wrong section', () => {
    const cal = clone(buildCal(SPEC));
    // Move one Intro bar into the Verse section — totals stay the same but the
    // per-section counts diverge from the spec.
    const introBar = cal.bars!.find((b) => b.sectionId === 'sec-0');
    expect(introBar).toBeDefined();
    introBar!.sectionId = 'sec-1';
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/bars, spec says/i);
  });

  it('flags a bar with no sectionId', () => {
    const cal = clone(buildCal(SPEC));
    // Simulate a renderer emitting an unassigned bar.
    cal.bars![0].sectionId = null;
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/no sectionId/i);
  });

  it('flags a dropped marker (renderer loses a Coda)', () => {
    const cal = clone(buildCal(SPEC));
    cal.roadmap = cal.roadmap!.filter((m) => m.kind !== 'coda');
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/expected 1 coda marker/i);
  });

  it('flags an unexpected marker (renderer invents a Fine)', () => {
    const specNoFine: RoadmapSpec = {
      ...SPEC,
      navigation: { ...SPEC.navigation, fine: undefined },
    };
    // Calibration still carries the Fine from the full spec → an extra marker.
    const cal = buildCal(SPEC);
    const r = assertSpecCalibrationParity(specNoFine, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/unexpected fine marker/i);
  });

  it('flags a miscounted volta (one ending instead of two)', () => {
    const cal = clone(buildCal(SPEC));
    cal.roadmap = cal.roadmap!.filter((m, i) => !(m.kind === 'ending' && i === cal.roadmap!.findIndex((x) => x.kind === 'ending')));
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/expected 2 ending marker/i);
  });

  it('reports every mismatch at once (full renderer-regression description)', () => {
    const cal = clone(buildCal(SPEC));
    cal.bars!.pop();
    cal.sections[0].label = 'Wrong';
    cal.roadmap = cal.roadmap!.filter((m) => m.kind !== 'segno');
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});
