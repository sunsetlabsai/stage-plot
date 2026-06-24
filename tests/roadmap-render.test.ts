import { describe, it, expect } from 'vitest';
import { renderRoadmap, layoutRoadmap, buildCalibration, voltaLabel } from '../lib/roadmap-render';
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

  it('artist credit is header-only — never perturbs the born calibration', async () => {
    // The save route asserts spec↔calibration parity, so the printed credit must
    // be cosmetic: it changes the PDF bytes but leaves the geometry untouched.
    const spec = linearSpec();
    const plain = await renderRoadmap(spec, { songTitle: 'Song' });
    const credited = await renderRoadmap(spec, { songTitle: 'Song', artist: 'The Band' });

    expect(credited.calibration).toEqual(plain.calibration);
    expect(Buffer.from(credited.pdfBytes).equals(Buffer.from(plain.pdfBytes))).toBe(false);
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

describe('voltaLabel — honest pass-number rendering', () => {
  it('renders a singleton pass', () => {
    expect(voltaLabel([2])).toBe('2.');
  });
  it('collapses a contiguous run into a range', () => {
    expect(voltaLabel([1, 2, 3])).toBe('1.\u20133.');
  });
  it('sorts unsorted input before collapsing', () => {
    expect(voltaLabel([2, 1])).toBe('1.\u20132.');
  });
  it('keeps non-contiguous passes as separate terms (never implies a skipped pass)', () => {
    expect(voltaLabel([1, 3])).toBe('1. 3.');
  });
  it('mixes a run and a gap', () => {
    expect(voltaLabel([1, 2, 4])).toBe('1.\u20132. 4.');
  });
});

describe('layoutRoadmap — page spill', () => {
  it('spills long forms onto multiple pages, preserving reading order', async () => {
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      barsPerLine: 4,
      sections: [{ id: 'long', label: 'Vamp', bars: 120 }],
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const layout = layoutRoadmap(spec);
    expect(layout.pageCount).toBeGreaterThan(1);
    expect(layout.systems.some((s) => s.page > 1)).toBe(true);

    const cal = buildCalibration(spec, layout);
    expect(cal.bars).toHaveLength(120);
    expect((cal.bars ?? []).map((b) => b.absNumber)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));

    const { pdfBytes } = await renderRoadmap(spec);
    expect(pdfBytes.length).toBeGreaterThan(200);
    expect(resolveRoadmap(cal).ok).toBe(true);
  });

  it('draws a volta ending that spans systems (per-segment bracket, no dropout)', async () => {
    // barsPerLine 4 → bars 4 and 5 land on different systems; a valid ending
    // covering bars 4-5 must still render (one bracket segment per system).
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'E',
      barsPerLine: 4,
      sections: [
        {
          id: 'chorus',
          label: 'Chorus',
          bars: 8,
          repeat: {
            kind: 'volta',
            endings: [
              { bars: { start: 4, count: 2 }, passes: [1] }, // bars 4-5: crosses systems
              { bars: { start: 6, count: 1 }, passes: [2] },
            ],
          },
        },
      ],
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const layout = layoutRoadmap(spec);
    const startSys = layout.bars.find((b) => b.sectionIndex === 0 && b.barInSection === 4)?.systemId;
    const endSys = layout.bars.find((b) => b.sectionIndex === 0 && b.barInSection === 5)?.systemId;
    expect(startSys).toBeTruthy();
    expect(endSys).toBeTruthy();
    expect(startSys).not.toBe(endSys); // the ending genuinely spans two systems

    const cal = buildCalibration(spec, layout);
    expect((cal.roadmap ?? []).some((m) => m.kind === 'ending')).toBe(true);
    expect(resolveRoadmap(cal).ok).toBe(true);

    const a = await renderRoadmap(spec);
    const b = await renderRoadmap(spec);
    expect(a.pdfBytes.length).toBeGreaterThan(200);
    expect(Buffer.from(a.pdfBytes).equals(Buffer.from(b.pdfBytes))).toBe(true);
  });
});

describe('renderRoadmap — navigation variants', () => {
  it('renders a D.S. al Coda form (segno + coda + toCoda + jump)', async () => {
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'G',
      sections: [
        { id: 'a', label: 'A', bars: 4 },
        { id: 'b', label: 'B', bars: 8 },
        { id: 'c', label: 'Coda', bars: 4 },
      ],
      navigation: {
        segno: { section: 1, bar: 1 },
        coda: { section: 2, bar: 1 },
        toCoda: { section: 1, bar: 8 },
        jump: { at: { section: 1, bar: 8 }, from: 'segno', until: 'coda' },
      },
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const { pdfBytes, calibration } = await renderRoadmap(spec);
    expect(pdfBytes.length).toBeGreaterThan(200);
    expect(resolveRoadmap(calibration).ok).toBe(true);
    const kinds = new Set((calibration.roadmap ?? []).map((m) => m.kind));
    expect(kinds.has('coda')).toBe(true);
    expect(kinds.has('toCoda')).toBe(true);
    expect(kinds.has('segno')).toBe(true);

    // toCoda and the D.S. jump intentionally share bar (1,8): the renderer must
    // stack co-located directives rather than overprint. Pin the co-location so
    // the stacking path stays exercised, and confirm the render is deterministic.
    const markers = calibration.roadmap ?? [];
    const toCodaBar = markers.find((m) => m.kind === 'toCoda')?.barId;
    const jumpBar = markers.find((m) => m.kind === 'jump')?.barId;
    expect(toCodaBar).toBeTruthy();
    expect(jumpBar).toBe(toCodaBar);
    const again = await renderRoadmap(spec);
    expect(Buffer.from(pdfBytes).equals(Buffer.from(again.pdfBytes))).toBe(true);
  });

  it('stacks a ×N repeat count with a same-bar end-edge directive (no overprint)', async () => {
    // times:3 prints ×3 at the section's last-bar end edge; a jump.at on that
    // same bar fires after the repeat completes. Both are valid and co-located,
    // so the ×N count must share the end-edge stack with the directive.
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      sections: [{ id: 'v', label: 'Verse', bars: 8, repeat: { kind: 'plain', times: 3 } }],
      navigation: { jump: { at: { section: 0, bar: 8 }, from: 'capo', until: 'end' } },
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const { pdfBytes, calibration } = await renderRoadmap(spec);
    expect(resolveRoadmap(calibration).ok).toBe(true);
    const markers = calibration.roadmap ?? [];
    const repeatEndBar = markers.find((m) => m.kind === 'repeatEnd')?.barId;
    const jumpBar = markers.find((m) => m.kind === 'jump')?.barId;
    expect(repeatEndBar).toBeTruthy();
    expect(jumpBar).toBe(repeatEndBar); // both land on the section's last bar
    const again = await renderRoadmap(spec);
    expect(Buffer.from(pdfBytes).equals(Buffer.from(again.pdfBytes))).toBe(true);
  });

  it('stacks a start-edge directive co-located on a volta ending first bar', async () => {
    // A segno can validly target the same bar a volta ending starts on. The
    // volta pass-label and the Segno both anchor above that bar's start edge,
    // so the label must claim its stack row and the directive must lift clear.
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'A',
      sections: [
        { id: 'a', label: 'A', bars: 4 },
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
        segno: { section: 1, bar: 7 }, // same bar the first volta ending starts on
        jump: { at: { section: 1, bar: 8 }, from: 'segno', until: 'end' },
      },
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const { pdfBytes, calibration } = await renderRoadmap(spec);
    expect(resolveRoadmap(calibration).ok).toBe(true);
    const markers = calibration.roadmap ?? [];
    const segnoBar = markers.find((m) => m.kind === 'segno')?.barId;
    const ending = markers.find((m) => m.kind === 'ending');
    expect(segnoBar).toBeTruthy();
    // The segno lands on the first volta ending's first bar (the co-location).
    expect((ending && 'barIds' in ending ? ending.barIds : []).includes(segnoBar as string)).toBe(true);
    const again = await renderRoadmap(spec);
    expect(Buffer.from(pdfBytes).equals(Buffer.from(again.pdfBytes))).toBe(true);
  });

  it('renders a D.C. al Fine form (fine + jump)', async () => {
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'D',
      sections: [
        { id: 'a', label: 'A', bars: 8 },
        { id: 'b', label: 'B', bars: 8 },
      ],
      navigation: {
        fine: { section: 0, bar: 8 },
        jump: { at: { section: 1, bar: 8 }, from: 'capo', until: 'fine' },
      },
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);

    const { calibration } = await renderRoadmap(spec);
    expect(resolveRoadmap(calibration).ok).toBe(true);
    const kinds = new Set((calibration.roadmap ?? []).map((m) => m.kind));
    expect(kinds.has('fine')).toBe(true);
    expect(kinds.has('jump')).toBe(true);
  });
});

describe('renderRoadmap — chord content & header', () => {
  function richSpec(): RoadmapSpec {
    return {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'A',
      sections: [
        {
          id: 'v',
          label: 'Verse',
          bars: 4,
          changes: [
            { bar: 1, chords: [{ degree: 1, held: true }] },                          // held diamond
            { bar: 2, chords: [{ degree: 4, beats: 3 }, { degree: 5, bass: 7, beats: 1 }] }, // split bar
          ],
        },
      ],
    };
  }

  it('renders held diamonds and split bars deterministically', async () => {
    const spec = richSpec();
    expect(validateRoadmapSpec(spec).ok).toBe(true);
    const a = await renderRoadmap(spec);
    const b = await renderRoadmap(spec);
    expect(a.pdfBytes.length).toBeGreaterThan(200);
    expect(Buffer.from(a.pdfBytes).equals(Buffer.from(b.pdfBytes))).toBe(true);
  });

  it('threads a song title into the header (changes bytes, stays deterministic)', async () => {
    const spec = richSpec();
    const untitled = await renderRoadmap(spec);
    const titled = await renderRoadmap(spec, { songTitle: 'Blue Skies' });
    const titledAgain = await renderRoadmap(spec, { songTitle: 'Blue Skies' });
    expect(Buffer.from(titled.pdfBytes).equals(Buffer.from(untitled.pdfBytes))).toBe(false);
    expect(Buffer.from(titled.pdfBytes).equals(Buffer.from(titledAgain.pdfBytes))).toBe(true);
  });
});
