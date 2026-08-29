import { describe, it, expect } from 'vitest';
import {
  validateRoadmapSpec,
  isValidRoadmapSpec,
  isValidKey,
  QUALITY_WHITELIST,
  TIME_SIG_UNITS,
  RENDER_KEYS_MAJOR,
  RENDER_KEYS_MINOR,
  type RoadmapSpec,
} from '../lib/roadmap-spec';

// A minimal, valid spec: 4/4 in G, 4-bar intro over the I chord.
function baseSpec(): RoadmapSpec {
  return {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'G',
    barsPerLine: 4,
    sections: [
      { id: 's1', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
    ],
  };
}

// Assert validation failed and at least one error matches the substring.
function expectError(input: unknown, substring: string): void {
  const res = validateRoadmapSpec(input);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.errors.some((e) => e.includes(substring))).toBe(true);
  }
}

describe('validateRoadmapSpec — happy path', () => {
  it('accepts a minimal valid spec', () => {
    const res = validateRoadmapSpec(baseSpec());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.spec.sections).toHaveLength(1);
  });

  it('accepts a full song form with changes, split bars, holds, and a repeat', () => {
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'Bb',
      sections: [
        { id: 'intro', label: 'Intro', bars: 4 },
        {
          id: 'verse',
          label: 'Verse',
          bars: 8,
          changes: [
            { bar: 1, chords: [{ degree: 1 }] },
            { bar: 3, chords: [{ degree: 4 }] },
            { bar: 5, chords: [{ degree: 5 }, { degree: 1 }] }, // even split, 2 beats each
            { bar: 7, chords: [{ degree: 6, quality: 'm', held: true }] },
          ],
        },
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
          changes: [{ bar: 1, chords: [{ degree: 1, beats: 3 }, { degree: 5, bass: 7, beats: 1 }] }],
        },
      ],
      navigation: {
        segno: { section: 1, bar: 1 },
        coda: { section: 2, bar: 8 },
        toCoda: { section: 1, bar: 8 },
        fine: { section: 2, bar: 8 },
        jump: { at: { section: 2, bar: 8 }, from: 'segno', until: 'coda' },
      },
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('isValidRoadmapSpec is a boolean guard over the same logic', () => {
    expect(isValidRoadmapSpec(baseSpec())).toBe(true);
    expect(isValidRoadmapSpec({})).toBe(false);
  });
});

describe('validateRoadmapSpec — top-level shape', () => {
  it('rejects non-objects', () => {
    expectError(null, 'spec must be an object');
    expectError(42, 'spec must be an object');
  });

  it('fails closed on an unsupported version', () => {
    expectError({ ...baseSpec(), version: 0 }, 'unsupported spec version');
    expectError({ ...baseSpec(), version: 2 }, 'unsupported spec version');
    expectError({ ...baseSpec(), version: 1.5 }, 'unsupported spec version');
  });

  it('rejects a missing or malformed time signature', () => {
    expectError({ ...baseSpec(), timeSig: undefined }, 'timeSig must be an object');
    expectError({ ...baseSpec(), timeSig: { beats: 0, unit: 4 } }, 'timeSig.beats');
    expectError({ ...baseSpec(), timeSig: { beats: 4, unit: 3 } }, 'timeSig.unit');
  });

  it('accepts every supported time-sig unit', () => {
    for (const unit of TIME_SIG_UNITS) {
      const res = validateRoadmapSpec({ ...baseSpec(), timeSig: { beats: 4, unit } });
      expect(res.ok).toBe(true);
    }
  });

  it('rejects an invalid render key', () => {
    expectError({ ...baseSpec(), renderKey: 'H' }, 'renderKey');
    expectError({ ...baseSpec(), renderKey: 'g' }, 'renderKey');
    expectError({ ...baseSpec(), renderKey: 'Bbb' }, 'renderKey');
  });

  it('rejects a bad barsPerLine but allows it absent', () => {
    expectError({ ...baseSpec(), barsPerLine: 0 }, 'barsPerLine');
    expectError({ ...baseSpec(), barsPerLine: 17 }, 'barsPerLine');
    const { barsPerLine: _omit, ...noHint } = baseSpec();
    void _omit;
    expect(validateRoadmapSpec(noHint).ok).toBe(true);
  });

  it('rejects empty or non-array sections', () => {
    expectError({ ...baseSpec(), sections: [] }, 'sections must be a non-empty array');
    expectError({ ...baseSpec(), sections: 'nope' }, 'sections must be a non-empty array');
  });
});

describe('isValidKey', () => {
  it('accepts common major and minor keys', () => {
    for (const k of ['C', 'G', 'D', 'Bb', 'F#', 'Eb', 'Am', 'C#m', 'Abm']) {
      expect(isValidKey(k)).toBe(true);
    }
  });
  it('rejects junk', () => {
    for (const k of ['H', 'g', 'Bbb', '', 'Gmaj', 1, null]) {
      expect(isValidKey(k)).toBe(false);
    }
  });
});

describe('validateRoadmapSpec — sections', () => {
  it('rejects duplicate section ids', () => {
    const spec = baseSpec();
    spec.sections.push({ id: 's1', label: 'Verse', bars: 8 });
    expectError(spec, 'duplicate section id');
  });

  it('rejects a blank label', () => {
    const spec = baseSpec();
    spec.sections[0].label = '   ';
    expectError(spec, 'label must be a non-empty string');
  });

  it('rejects non-positive bar counts', () => {
    expectError({ ...baseSpec(), sections: [{ id: 'a', label: 'A', bars: 0 }] }, 'bars must be an integer >= 1');
  });
});

describe('validateRoadmapSpec — changes & chords', () => {
  it('rejects a change bar outside the section', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 9, chords: [{ degree: 1 }] }];
    expectError(spec, 'bar must be an integer within 1..4');
  });

  it('rejects duplicate change bars', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [
      { bar: 1, chords: [{ degree: 1 }] },
      { bar: 1, chords: [{ degree: 4 }] },
    ];
    expectError(spec, 'duplicate change for bar 1');
  });

  it('rejects an out-of-range degree', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 8 }] }];
    expectError(spec, 'degree must be an integer 1..7');
  });

  it('rejects a quality outside the whitelist', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 5, quality: '7b9' }] }];
    expectError(spec, 'not in the v1 vocabulary');
  });

  it('accepts every whitelisted quality', () => {
    for (const quality of QUALITY_WHITELIST) {
      const spec = baseSpec();
      spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 1, quality }] }];
      expect(validateRoadmapSpec(spec).ok).toBe(true);
    }
  });

  it('rejects a bad bass degree', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 1, bass: 0 }] }];
    expectError(spec, 'bass must be an integer 1..7');
  });

  it('accepts a chromatic root via alter (♭VII = { degree: 7, alter: -1 })', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 7, alter: -1 }] }];
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('accepts alter on all of -1, 0, +1', () => {
    for (const alter of [-1, 0, 1] as const) {
      const spec = baseSpec();
      spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 4, alter }] }];
      expect(validateRoadmapSpec(spec).ok).toBe(true);
    }
  });

  it('rejects an out-of-range alter', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 4, alter: 2 as -1 | 0 | 1 }] }];
    expectError(spec, 'alter must be -1, 0, or 1');
  });

  it('rejects empty chords', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [] }];
    expectError(spec, 'chords must be a non-empty array');
  });
});

describe('validateRoadmapSpec — split-bar beat math', () => {
  it('accepts an even split with no explicit beats', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 1 }, { degree: 5 }] }]; // 2+2 in 4/4
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('rejects an uneven split with no explicit beats', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 1 }, { degree: 4 }, { degree: 5 }] }]; // 3 into 4
    expectError(spec, "don't divide 4 beats evenly");
  });

  it('accepts explicit beats that sum to the bar', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 1, beats: 3 }, { degree: 5, beats: 1 }] }];
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('rejects explicit beats that do not sum to the bar', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 1, beats: 2 }, { degree: 5, beats: 1 }] }];
    expectError(spec, 'split beats sum to 3, expected 4');
  });

  it('rejects a mix of beats and no-beats', () => {
    const spec = baseSpec();
    spec.sections[0].changes = [{ bar: 1, chords: [{ degree: 1, beats: 2 }, { degree: 5 }] }];
    expectError(spec, 'set beats on all chords or none');
  });
});

describe('validateRoadmapSpec — plain repeats', () => {
  it('accepts a plain repeat on a multi-bar section', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { kind: 'plain', times: 2 };
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('rejects plain times < 2', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { kind: 'plain', times: 1 };
    expectError(spec, 'plain repeat.times must be an integer >= 2');
  });

  it('rejects a plain repeat on a 1-bar section (repeatStart/repeatEnd would collide)', () => {
    const spec = baseSpec();
    spec.sections[0].bars = 1;
    spec.sections[0].changes = undefined;
    spec.sections[0].repeat = { kind: 'plain', times: 2 };
    expectError(spec, 'section.bars >= 2');
  });

  it('rejects an unknown repeat kind', () => {
    const spec = baseSpec();
    // @ts-expect-error — exercising the runtime guard on a bad discriminant
    spec.sections[0].repeat = { kind: 'loop', times: 2 };
    expectError(spec, "repeat.kind must be 'plain' or 'volta'");
  });
});

describe('validateRoadmapSpec — volta repeats', () => {
  function voltaSpec(endings: unknown): RoadmapSpec {
    const spec = baseSpec();
    spec.sections[0].bars = 8;
    spec.sections[0].changes = undefined;
    // @ts-expect-error — tests feed deliberately malformed endings through the validator
    spec.sections[0].repeat = { kind: 'volta', endings };
    return spec;
  }

  it('accepts balanced, non-overlapping voltas', () => {
    const spec = voltaSpec([
      { bars: { start: 7, count: 1 }, passes: [1, 2] },
      { bars: { start: 8, count: 1 }, passes: [3] },
    ]);
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('rejects fewer than 2 endings', () => {
    expectError(voltaSpec([{ bars: { start: 7, count: 1 }, passes: [1] }]), 'at least 2 endings');
  });

  it('rejects an ending starting at bar 1 (collides with the repeatStart)', () => {
    expectError(
      voltaSpec([
        { bars: { start: 1, count: 1 }, passes: [1] },
        { bars: { start: 8, count: 1 }, passes: [2] },
      ]),
      'bars.start must be > 1',
    );
  });

  it('rejects an ending running past the section', () => {
    expectError(
      voltaSpec([
        { bars: { start: 7, count: 4 }, passes: [1] },
        { bars: { start: 8, count: 1 }, passes: [2] },
      ]),
      'runs past the section',
    );
  });

  it('rejects overlapping ending bar ranges', () => {
    expectError(
      voltaSpec([
        { bars: { start: 6, count: 2 }, passes: [1] },
        { bars: { start: 7, count: 1 }, passes: [2] },
      ]),
      'bar ranges overlap',
    );
  });

  it('rejects overlapping passes', () => {
    expectError(
      voltaSpec([
        { bars: { start: 7, count: 1 }, passes: [1] },
        { bars: { start: 8, count: 1 }, passes: [1, 2] },
      ]),
      'appears in more than one ending',
    );
  });

  it('rejects a gap in pass coverage', () => {
    expectError(
      voltaSpec([
        { bars: { start: 7, count: 1 }, passes: [1] },
        { bars: { start: 8, count: 1 }, passes: [3] },
      ]),
      'do not cover 1..3',
    );
  });
});

describe('validateRoadmapSpec — navigation', () => {
  function navSpec(navigation: unknown): RoadmapSpec {
    const spec = baseSpec();
    spec.sections = [
      { id: 'a', label: 'A', bars: 4 },
      { id: 'b', label: 'B', bars: 4 },
    ];
    // @ts-expect-error — tests feed deliberately malformed navigation through the validator
    spec.navigation = navigation;
    return spec;
  }

  it('accepts a full, internally consistent navigation block', () => {
    const spec = navSpec({
      segno: { section: 0, bar: 1 },
      coda: { section: 1, bar: 4 },
      toCoda: { section: 0, bar: 4 },
      fine: { section: 1, bar: 4 },
      jump: { at: { section: 1, bar: 4 }, from: 'segno', until: 'coda' },
    });
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('rejects a BarRef to a non-existent section', () => {
    expectError(navSpec({ segno: { section: 5, bar: 1 } }), 'segno.section must index an existing section');
  });

  it('rejects a BarRef bar past its section length', () => {
    expectError(navSpec({ segno: { section: 0, bar: 9 } }), 'segno.bar must be within 1..4');
  });

  it('rejects a standalone toCoda with no coda', () => {
    expectError(navSpec({ toCoda: { section: 0, bar: 4 } }), 'navigation.toCoda requires navigation.coda');
  });

  it('rejects a segno jump with no segno', () => {
    expectError(
      navSpec({ jump: { at: { section: 0, bar: 4 }, from: 'segno', until: 'end' } }),
      'jump.from "segno" requires navigation.segno',
    );
  });

  it('rejects an al-Fine jump with no fine', () => {
    expectError(
      navSpec({ jump: { at: { section: 0, bar: 4 }, from: 'capo', until: 'fine' } }),
      'jump.until "fine" requires navigation.fine',
    );
  });

  it('rejects an al-Coda jump missing coda/toCoda', () => {
    expectError(
      navSpec({ jump: { at: { section: 0, bar: 4 }, from: 'capo', until: 'coda' } }),
      'jump.until "coda" requires navigation.coda and navigation.toCoda',
    );
  });

  it('rejects a bad jump.from / jump.until', () => {
    expectError(navSpec({ jump: { at: { section: 0, bar: 4 }, from: 'x', until: 'end' } }), "jump.from must be 'capo' or 'segno'");
    expectError(navSpec({ jump: { at: { section: 0, bar: 4 }, from: 'capo', until: 'x' } }), "jump.until must be 'end', 'fine', or 'coda'");
  });
});

describe('validateRoadmapSpec — reports all errors at once', () => {
  it('collects multiple independent problems', () => {
    const res = validateRoadmapSpec({
      version: 0,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'H',
      sections: [{ id: 'a', label: '', bars: 0 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── The offerable key menu ───────────────────────────────────────────────────
// The bug this pins: the builder's key picker carried a hand-written 14-entry list
// (10 majors, 4 minors), so F# was unreachable — you could not author a chart in a
// key the spec contract accepts perfectly well.
//
// "Every entry is valid" would NOT have caught that: the old list was entirely valid,
// just short. The test that catches it is COVERAGE — map each entry to its pitch class
// and demand all twelve. So pitchClass below is deliberately an INDEPENDENT
// reimplementation, not an import: a shared helper would agree with a wrong menu.
const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchClass(key: string): number {
  const m = key.match(/^([A-G])(#|b)?m?$/);
  if (!m) throw new Error(`not a key: ${key}`);
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (((NATURAL_PC[m[1]] + accidental) % 12) + 12) % 12;
}

describe('RENDER_KEYS — the offerable key menu', () => {
  it('offers all twelve major pitch classes, exactly once each', () => {
    const classes = RENDER_KEYS_MAJOR.map(pitchClass);
    expect(new Set(classes).size).toBe(12);
    expect([...classes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('offers all twelve minor pitch classes, exactly once each', () => {
    const classes = RENDER_KEYS_MINOR.map(pitchClass);
    expect(new Set(classes).size).toBe(12);
    expect([...classes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('every offered key satisfies the spec contract', () => {
    for (const k of [...RENDER_KEYS_MAJOR, ...RENDER_KEYS_MINOR]) {
      expect(isValidKey(k), `${k} must satisfy KEY_PATTERN`).toBe(true);
    }
  });

  it('separates the modes — majors carry no "m", minors all do', () => {
    for (const k of RENDER_KEYS_MAJOR) expect(k.endsWith('m')).toBe(false);
    for (const k of RENDER_KEYS_MINOR) expect(k.endsWith('m')).toBe(true);
  });

  it('offers F# and F#m — the key that was unreachable', () => {
    // The reported counterexample, named rather than implied: "9 to 5" is in F# and
    // the old menu's nearest offer was F, which is a different song.
    expect(RENDER_KEYS_MAJOR).toContain('F#');
    expect(RENDER_KEYS_MINOR).toContain('F#m');
  });

  it('spells each pitch class with the fewer-accidental key signature', () => {
    // Forced choices, not taste — Db is 5 flats where C# is 7 sharps; C#m is 4 sharps
    // where Dbm is 8. Pinning them stops a future "tidy-up" flipping the spelling.
    expect(RENDER_KEYS_MAJOR).toContain('Db');
    expect(RENDER_KEYS_MAJOR).not.toContain('C#');
    expect(RENDER_KEYS_MINOR).toContain('C#m');
    expect(RENDER_KEYS_MINOR).not.toContain('Dbm');
  });
});
