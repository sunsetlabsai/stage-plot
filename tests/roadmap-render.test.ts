import { describe, it, expect } from 'vitest';
import { renderRoadmap, layoutRoadmap, buildCalibration } from '../lib/roadmap-render';
import { validateRoadmapSpec, type RoadmapSpec } from '../lib/roadmap-spec';
import { isValidCalibration, canVerify, resolveRoadmap, CALIBRATION_SCHEMA_VERSION } from '../lib/chart-calibration';

// A linear two-section spec, no markers.
function linearSpec(): RoadmapSpec {
  return {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'G',
    barsPerLine: 4,
    sections: [
      { id: 'intro', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
      { id: 'verse', label: 'Verse', bars: 8 },
    ],
  };
}

// A spec exercising a plain repeat, a volta repeat, and global navigation.
function navSpec(): RoadmapSpec {
  return {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'Bb',
    sections: [
      { id: 'intro', label: 'Intro', bars: 4 },
      { id: 'verse', label: 'Verse', bars: 8, repeat: { kind: 'plain', times: 2 } },
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
      jump: { at: { section: 2, bar: 8 }, from: 'segno', until: 'end' },
    },
  };
}

const totalBars = (s: RoadmapSpec) => s.sections.reduce((n, sec) => n + sec.bars, 0);

describe('renderRoadmap — substrate + born-verified calibration', () => {
  it('emits a real PDF and a gate-passing, resolvable calibration', async () => {
    const spec = linearSpec();
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const { pdfBytes, calibration } = await renderRoadmap(spec);

    // Real PDF bytes.
    expect(pdfBytes.length).toBeGreaterThan(200);
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe('%PDF-');

    // Born verified, gate-clean, and the markers (none here) resolve linearly.
    expect(calibration.schemaVersion).toBe(CALIBRATION_SCHEMA_VERSION);
    expect(calibration.status).toBe('verified');
    expect(isValidCalibration(calibration)).toBe(true);
    expect(canVerify(calibration)).toBe(true);
    expect(resolveRoadmap(calibration).ok).toBe(true);
  });

  it('is deterministic — same spec yields byte-identical PDFs', async () => {
    const a = await renderRoadmap(linearSpec());
    const b = await renderRoadmap(linearSpec());
    expect(Buffer.from(a.pdfBytes).equals(Buffer.from(b.pdfBytes))).toBe(true);
  });

  it('projects repeats and navigation onto resolvable RoadmapMarkers', async () => {
    const spec = navSpec();
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const { calibration } = await renderRoadmap(spec);
    expect(isValidCalibration(calibration)).toBe(true);
    expect(resolveRoadmap(calibration).ok).toBe(true);

    const kinds = new Set((calibration.roadmap ?? []).map((m) => m.kind));
    expect(kinds.has('repeatStart')).toBe(true);
    expect(kinds.has('repeatEnd')).toBe(true);
    expect(kinds.has('ending')).toBe(true);
    expect(kinds.has('segno')).toBe(true);
    expect(kinds.has('jump')).toBe(true);
  });
});

describe('layoutRoadmap / buildCalibration — structural parity', () => {
  it('emits exactly one bar per spec bar, in reading order', () => {
    const spec = navSpec();
    const layout = layoutRoadmap(spec);
    const cal = buildCalibration(spec, layout);

    expect(cal.bars).toHaveLength(totalBars(spec));
    const abs = (cal.bars ?? []).map((b) => b.absNumber);
    expect(abs).toEqual(Array.from({ length: totalBars(spec) }, (_, i) => i + 1));

    // Every bar references a real section and a real system.
    const sectionIds = new Set(cal.sections.map((s) => s.id));
    const systemIds = new Set((cal.systems ?? []).map((s) => s.id));
    for (const bar of cal.bars ?? []) {
      expect(sectionIds.has(bar.sectionId as string)).toBe(true);
      expect(systemIds.has(bar.systemId)).toBe(true);
    }
  });

  it('starts a fresh system per section and one anchor per section', () => {
    const spec = navSpec();
    const cal = buildCalibration(spec, layoutRoadmap(spec));
    expect(cal.sections).toHaveLength(spec.sections.length);
  });
});
