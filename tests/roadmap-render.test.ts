import { describe, it, expect } from 'vitest';
import { renderRoadmap, buildCalibration, voltaLabel, headerBaselinesPt } from '../lib/roadmap-render';
import { layoutRoadmap, pickBarsPerLine, chunkIntoLines, lineStartNumbers, PAGE_W, PAGE_H, MARGIN_X, MARGIN_TOP, CONTENT_W } from '../lib/roadmap-layout';
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

describe('line-start measure numbers — the one shared rule (design §3.3)', () => {
  // A 3-section, multi-line, multi-page form; no explicit barsPerLine, so the
  // responsive override actually takes effect (resolveBarsPerLine: explicit wins).
  function multiSpec(): RoadmapSpec {
    return {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      sections: [
        { id: 'a', label: 'A', bars: 40 },
        { id: 'b', label: 'B', bars: 40 },
        { id: 'c', label: 'C', bars: 40 },
      ],
    };
  }

  it('labels each resolved line by the absNumber of its first bar', () => {
    const spec = multiSpec();
    const layout = layoutRoadmap(spec); // default wrap
    expect(layout.pageCount).toBeGreaterThan(1); // genuinely multi-page

    const numbers = lineStartNumbers(layout.systems.map((s) => s.bars));
    // Producer agrees with reading the first bar off each real line…
    expect(numbers).toEqual(layout.systems.map((s) => s.bars[0].absNumber));
    // …the first line is bar 1, and numbers strictly increase down the form.
    expect(numbers[0]).toBe(1);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i]!).toBeGreaterThan(numbers[i - 1]!);
    }
  });

  it('an empty line is never numbered', () => {
    expect(lineStartNumbers([[]])).toEqual([null]);
    expect(lineStartNumbers([[{ absNumber: 7 }], []])).toEqual([7, null]);
  });

  it('same bar → same number under different wraps (no drift), but line-start SETS differ by design', () => {
    const spec = multiSpec();
    const wide = layoutRoadmap(spec, { barsPerLine: 8 }); // PDF-ish
    const narrow = layoutRoadmap(spec, { barsPerLine: 2 }); // responsive preview

    // The producer labels EACH surface's own lines correctly.
    expect(lineStartNumbers(wide.systems.map((s) => s.bars))).toEqual(
      wide.systems.map((s) => s.bars[0].absNumber),
    );
    expect(lineStartNumbers(narrow.systems.map((s) => s.bars))).toEqual(
      narrow.systems.map((s) => s.bars[0].absNumber),
    );

    // The one guarantee: a given bar carries ONE number everywhere, independent of
    // how each surface wrapped. Compare every shared bar id across the two wraps.
    const numById = (l: ReturnType<typeof layoutRoadmap>) =>
      new Map(l.systems.flatMap((s) => s.bars).map((b) => [b.id, b.absNumber]));
    const wideMap = numById(wide);
    const narrowMap = numById(narrow);
    for (const [id, n] of wideMap) expect(narrowMap.get(id)).toBe(n);

    // The line-start SETS are NOT equal — asserting they were would bake in a
    // WYSIWYG requirement nobody chose (§3.3 item 2).
    const wideStarts = new Set(lineStartNumbers(wide.systems.map((s) => s.bars)));
    const narrowStarts = new Set(lineStartNumbers(narrow.systems.map((s) => s.bars)));
    expect(wideStarts).not.toEqual(narrowStarts);
  });

  it('the visual number does not perturb the born calibration', () => {
    // Drawing absNumber is ink only; the structured output must be byte-identical
    // to the pure layout→calibration projection (the "calibration unchanged" gate).
    const spec = multiSpec();
    const cal = buildCalibration(spec, layoutRoadmap(spec));
    expect(cal.bars?.map((b) => b.absNumber)).toEqual(
      Array.from({ length: totalBars(spec) }, (_, i) => i + 1),
    );
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

  it('the rhythm strip reaches the PDF: held suppresses slashes as INK, not geometry', async () => {
    // The bug this fixes: slashes lived only in the preview, never the printed PDF.
    // Two specs identical but for one whole-bar chord's `held` flag. Struck → four
    // slashes drawn under the bar; held → none (the ring). The rhythm strip is real
    // ink, so the bytes MUST differ — but the strip is drawn from the same layout,
    // so the born calibration MUST be byte-identical (the save route asserts parity).
    const struck: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'G',
      sections: [{ id: 'v', label: 'Verse', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] }],
    };
    const held: RoadmapSpec = {
      ...struck,
      sections: [{ id: 'v', label: 'Verse', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1, held: true }] }] }],
    };
    const s = await renderRoadmap(struck);
    const h = await renderRoadmap(held);
    expect(Buffer.from(s.pdfBytes).equals(Buffer.from(h.pdfBytes))).toBe(false); // slashes are ink
    expect(s.calibration).toEqual(h.calibration);                               // geometry unchanged
    // …and each is still deterministic.
    const hAgain = await renderRoadmap(held);
    expect(Buffer.from(h.pdfBytes).equals(Buffer.from(hAgain.pdfBytes))).toBe(true);
  });

  it('threads a song title into the header (changes bytes, stays deterministic)', async () => {
    const spec = richSpec();
    const untitled = await renderRoadmap(spec);
    const titled = await renderRoadmap(spec, { songTitle: 'Blue Skies' });
    const titledAgain = await renderRoadmap(spec, { songTitle: 'Blue Skies' });
    expect(Buffer.from(titled.pdfBytes).equals(Buffer.from(untitled.pdfBytes))).toBe(false);
    expect(Buffer.from(titled.pdfBytes).equals(Buffer.from(titledAgain.pdfBytes))).toBe(true);
  });

  it('re-key is a pure relabel — the calibration is key-invariant (Option A)', async () => {
    // A builder chart is Nashville/degree-based: only the printed key LABEL follows
    // the song. The structural truth (geometry, bars, markers) carries no key, so a
    // live re-key never needs a re-render or re-calibration. Render the same spec in
    // two keys: the born calibration is byte-identical; only the demoted header
    // ("Nashville (authored in <key>)") differs, so the PDFs are non-identical.
    const inD: RoadmapSpec = { ...richSpec(), renderKey: 'D' };
    const inBb: RoadmapSpec = { ...richSpec(), renderKey: 'Bb' };
    const d = await renderRoadmap(inD);
    const bb = await renderRoadmap(inBb);
    expect(d.calibration).toEqual(bb.calibration);
    expect(Buffer.from(d.pdfBytes).equals(Buffer.from(bb.pdfBytes))).toBe(false);
  });

  it('draws a chromatic-root accidental as a vector glyph — deterministic, calibration unperturbed (Gap 1)', async () => {
    // The motivating song's chorus C in D = ♭VII = { degree: 7, alter: -1 }.
    const flatSeven: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'D',
      sections: [{ id: 'ch', label: 'Chorus', bars: 4, changes: [{ bar: 1, chords: [{ degree: 7, alter: -1 }] }] }],
    };
    expect(validateRoadmapSpec(flatSeven).ok).toBe(true);

    const a = await renderRoadmap(flatSeven);
    const b = await renderRoadmap(flatSeven);
    expect(a.pdfBytes.length).toBeGreaterThan(200);
    expect(Buffer.from(a.pdfBytes).equals(Buffer.from(b.pdfBytes))).toBe(true); // deterministic

    // The accidental is a glyph-pass change only: vs the same chart with a plain
    // diatonic 7 it changes the bytes (the glyph draws) but leaves the born
    // calibration byte-identical (geometry/parity untouched).
    const plainSeven: RoadmapSpec = {
      ...flatSeven,
      sections: [{ id: 'ch', label: 'Chorus', bars: 4, changes: [{ bar: 1, chords: [{ degree: 7 }] }] }],
    };
    const plain = await renderRoadmap(plainSeven);
    expect(Buffer.from(a.pdfBytes).equals(Buffer.from(plain.pdfBytes))).toBe(false);
    expect(a.calibration).toEqual(plain.calibration);
  });
});

// ── Fit-to-width: constant-width bars, partial-line tracking (Bug B) ──────────
describe('layoutRoadmap — constant bar width + partial-line system edge (Bug B)', () => {
  // The motivating defect: a 10-bar section at 4/line wraps to 4 + 4 + 2; the
  // trailing 2-bar line used to stretch to fill the row (cellW / barsThisLine).
  const tenBarIntro: RoadmapSpec = {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'G',
    barsPerLine: 4,
    sections: [{ id: 'intro', label: 'Intro', bars: 10 }],
  };

  it('gives EVERY bar the same width regardless of how many sit on its line', () => {
    const layout = layoutRoadmap(tenBarIntro);
    const expectedNormW = CONTENT_W / 4 / PAGE_W; // constant cellW (in normalized units)
    expect(layout.systems).toHaveLength(3); // 4 + 4 + 2
    expect(layout.systems.map((s) => s.barsThisLine)).toEqual([4, 4, 2]);
    for (const bar of layout.bars) {
      expect(bar.xEnd - bar.xStart).toBeCloseTo(expectedNormW, 10);
    }
  });

  it('left-aligns the partial line and stops its system edge at the last real bar', () => {
    const layout = layoutRoadmap(tenBarIntro);
    const partial = layout.systems[2]; // the 2-bar line
    const lastBar = partial.bars[partial.bars.length - 1];
    // The system's right edge tracks the last real bar — NOT the page content edge.
    expect(partial.xEnd).toBeCloseTo(lastBar.xEnd, 10);
    const cellW = CONTENT_W / 4;
    expect(partial.xEnd).toBeCloseTo((MARGIN_X + 2 * cellW) / PAGE_W, 10); // MARGIN_X + 2 cells
    // First partial bar still starts at the left margin (left-aligned, not centered).
    expect(partial.bars[0].xStart).toBeCloseTo(MARGIN_X / PAGE_W, 10);
  });

  it('leaves a FULL line spanning the whole content box (behavior-preserving)', () => {
    const layout = layoutRoadmap(tenBarIntro);
    const full = layout.systems[0]; // a 4-bar line
    expect(full.xEnd).toBeCloseTo((PAGE_W - MARGIN_X) / PAGE_W, 10); // = (PAGE_W - MARGIN_X)/PAGE_W
  });
});

// ── Responsive bars/line selection + explicit override (design §4.2 / Q1) ─────
describe('pickBarsPerLine — responsive {2,4,8} tiers', () => {
  it('picks 2 below the phone breakpoint', () => {
    expect(pickBarsPerLine(360)).toBe(2);
    expect(pickBarsPerLine(479)).toBe(2);
  });
  it('picks 4 in the mid band', () => {
    expect(pickBarsPerLine(480)).toBe(4);
    expect(pickBarsPerLine(699)).toBe(4);
  });
  it('picks 8 at/above the wide breakpoint', () => {
    expect(pickBarsPerLine(700)).toBe(8);
    expect(pickBarsPerLine(1280)).toBe(8);
  });
});

describe('layoutRoadmap — barsPerLine resolution (Q1 explicit override)', () => {
  const spec = (barsPerLine?: number): RoadmapSpec => ({
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'C',
    ...(barsPerLine != null ? { barsPerLine } : {}),
    sections: [{ id: 's', label: 'S', bars: 16 }],
  });

  it('honors spec.barsPerLine when set (no override)', () => {
    expect(layoutRoadmap(spec(8)).systems).toHaveLength(2); // 16 / 8
  });
  it('defaults to 4/line when spec.barsPerLine is unset', () => {
    expect(layoutRoadmap(spec()).systems).toHaveLength(4); // 16 / 4
  });
  it('uses the responsive override only when spec.barsPerLine is unset', () => {
    // With no explicit spec value, the override (the responsive preview pick) is
    // what applies — beating the default.
    expect(layoutRoadmap(spec(), { barsPerLine: 2 }).systems).toHaveLength(8); // 16 / 2
  });
  it('makes explicit spec.barsPerLine win over the responsive override (Q1 enforced in the resolver)', () => {
    // Q1 lives in resolveBarsPerLine, not the caller: an explicit spec value beats
    // any override, so a reopened/AI-authored spec can never be silently re-wrapped.
    expect(layoutRoadmap(spec(8), { barsPerLine: 2 }).systems).toHaveLength(2); // 16 / 8, override ignored
  });
});

// ── Header band ordering (Bug A) ──────────────────────────────────────────────
describe('headerBaselinesPt — top-margin band, descending order (Bug A)', () => {
  const inBand = (y: number) => y >= PAGE_H - MARGIN_TOP && y <= PAGE_H;

  it('places title > artist > key, all within the top margin band (with artist)', () => {
    const h = headerBaselinesPt({ hasArtist: true });
    expect(h.title).toBeGreaterThan(h.artist);
    expect(h.artist).toBeGreaterThan(h.key);
    expect(inBand(h.title)).toBe(true);
    expect(inBand(h.artist)).toBe(true);
    expect(inBand(h.key)).toBe(true);
  });

  it('drops the key into the artist slot when no credit is present (title still highest)', () => {
    const h = headerBaselinesPt({ hasArtist: false });
    expect(h.title).toBeGreaterThan(h.key);
    expect(h.key).toBe(h.artist);
    expect(inBand(h.title)).toBe(true);
    expect(inBand(h.key)).toBe(true);
  });
});

// ── chunkIntoLines: the grouping decision the preview consumes (design §4.3) ──
describe('chunkIntoLines — same wrapping rule the PDF layout applies', () => {
  it('splits into ceil(N/perLine) lines with a left-aligned partial last line', () => {
    const lines = chunkIntoLines([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
    expect(lines).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]); // 4 + 4 + 2
  });
  it('matches layoutRoadmap line count for the same bars/perLine', () => {
    const lines = chunkIntoLines(Array.from({ length: 10 }, (_, i) => i), 4);
    const layout = layoutRoadmap({
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'G',
      barsPerLine: 4,
      sections: [{ id: 'i', label: 'I', bars: 10 }],
    });
    expect(lines).toHaveLength(layout.systems.length);
  });
  it('returns no lines for an empty section', () => {
    expect(chunkIntoLines([], 4)).toEqual([]);
  });
});

// ── Module boundary: the shared layout must not pull pdf-lib into the client ──
// The invariant isn't "this one file's source has no pdf-lib" — it's that nothing
// in roadmap-layout.ts's RUNTIME import graph reaches pdf-lib (a local helper it
// imports could pull it in). So crawl: follow runtime (non-type-only) local
// imports transitively; `import type`/`export type` erase at compile time, so
// they can't bundle anything and are skipped.
describe('roadmap-layout module boundary (client-bundle safety)', () => {
  it('pulls no pdf-lib through its runtime import graph (React preview never bundles it)', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // Resolve a relative specifier to a concrete TS source file.
    const resolveLocal = (fromFile: string, spec: string): string | null => {
      const base = resolve(dirname(fromFile), spec);
      for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (existsSync(cand)) return cand;
      }
      return null;
    };

    const visited = new Set<string>();
    const offenders: string[] = [];

    const crawl = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const src = readFileSync(file, 'utf8');

      // Runtime `import ...`/`export ... from` (NOT `import type`/`export type`),
      // plus side-effect imports and CJS require. Capture the module specifier.
      const fromRe = /^\s*(?:import|export)(?!\s+type\b)[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm;
      const sideEffectRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
      const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

      const specs = new Set<string>();
      for (const re of [fromRe, sideEffectRe, requireRe]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) specs.add(m[1]);
      }

      for (const spec of specs) {
        if (spec === 'pdf-lib' || spec.startsWith('pdf-lib/')) {
          offenders.push(`${file} → ${spec}`);
          continue;
        }
        if (spec.startsWith('.')) {
          const local = resolveLocal(file, spec);
          if (local) crawl(local);
        }
      }
    };

    crawl(fileURLToPath(new URL('../lib/roadmap-layout.ts', import.meta.url)));
    expect(offenders).toEqual([]);
  });
});
