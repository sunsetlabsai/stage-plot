import { describe, it, expect } from 'vitest';
import { buildCalibration } from '../lib/roadmap-render';
import { layoutRoadmap } from '../lib/roadmap-layout';
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
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/but the spec puts it in/i);
  });

  it('flags swapped section spans even when counts and labels still match', () => {
    // Two equal-sized sections so a renderer could swap which contiguous block
    // each owns: counts (2/2) and labels both pass, but membership is wrong.
    const swapSpec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      sections: [
        { id: 'a', label: 'A', bars: 2 },
        { id: 'b', label: 'B', bars: 2 },
      ],
    };
    const cal = clone(buildCal(swapSpec));
    // Swap the two blocks: bars 1-2 ↔ bars 3-4.
    for (const b of cal.bars!) {
      if (b.absNumber <= 2) b.sectionId = 'sec-1';
      else b.sectionId = 'sec-0';
    }
    const r = assertSpecCalibrationParity(swapSpec, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/but the spec puts it in/i);
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
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/expected marker coda@/i);
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
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/unexpected\/misbound marker\(s\) fine@/i);
  });

  it('flags a miscounted volta (one ending instead of two)', () => {
    const cal = clone(buildCal(SPEC));
    cal.roadmap = cal.roadmap!.filter((m, i) => !(m.kind === 'ending' && i === cal.roadmap!.findIndex((x) => x.kind === 'ending')));
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/expected marker ending@/i);
  });

  it('flags a marker on the WRONG bar (right count, misbound)', () => {
    const cal = clone(buildCal(SPEC));
    const re = cal.roadmap!.find((m) => m.kind === 'repeatEnd')!;
    // Re-point the repeatEnd at a bar that is NOT the verse's last bar.
    const otherBar = cal.bars!.find((b) => b.id !== (re as { barId: string }).barId)!;
    (re as { barId: string }).barId = otherBar.id;
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/misbound|repeatEnd/i);
  });

  it('flags a repeatEnd with the wrong times count', () => {
    const cal = clone(buildCal(SPEC));
    const re = cal.roadmap!.find((m) => m.kind === 'repeatEnd')! as { times?: number };
    re.times = 4; // spec says 2
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
  });

  it('flags an ending with the wrong passes (numbers)', () => {
    const cal = clone(buildCal(SPEC));
    const ending = cal.roadmap!.find((m) => m.kind === 'ending')! as { numbers: number[] };
    ending.numbers = [3]; // spec says [1] or [2]
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
  });

  it('flags an ending bound to the wrong bar span', () => {
    const cal = clone(buildCal(SPEC));
    const ending = cal.roadmap!.find((m) => m.kind === 'ending')! as { barIds: string[] };
    // Point the ending at a Chorus bar that is not in its spec span.
    const firstChorusBar = cal.bars!.find((b) => b.sectionId === 'sec-2')!;
    ending.barIds = [firstChorusBar.id];
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
  });

  it('flags a jump with the wrong until target', () => {
    const cal = clone(buildCal(SPEC));
    const jump = cal.roadmap!.find((m) => m.kind === 'jump')! as { until: string };
    jump.until = 'coda'; // spec says 'fine'
    const r = assertSpecCalibrationParity(SPEC, cal);
    expect(r.ok).toBe(false);
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
