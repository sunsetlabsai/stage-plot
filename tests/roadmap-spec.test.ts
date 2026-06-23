import { describe, it, expect } from 'vitest';
import {
  validateRoadmapSpec,
  isValidRoadmapSpec,
  isValidKey,
  QUALITY_WHITELIST,
  TIME_SIG_UNITS,
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
          repeat: { times: 2, endings: [[1], [2]] },
          changes: [{ bar: 1, chords: [{ degree: 1, beats: 3 }, { degree: 5, bass: 7, beats: 1 }] }],
        },
      ],
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

  it('rejects a bad version', () => {
    expectError({ ...baseSpec(), version: 0 }, 'version must be an integer >= 1');
    expectError({ ...baseSpec(), version: 1.5 }, 'version must be an integer >= 1');
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

describe('validateRoadmapSpec — repeats & endings', () => {
  it('accepts a plain repeat', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { times: 2 };
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('rejects times < 2', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { times: 1 };
    expectError(spec, 'repeat.times must be an integer >= 2');
  });

  it('accepts balanced voltas', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { times: 3, endings: [[1, 2], [3]] };
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('rejects fewer than 2 ending groups', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { times: 2, endings: [[1]] };
    expectError(spec, 'at least 2 ending groups');
  });

  it('rejects overlapping ending passes', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { times: 2, endings: [[1], [1, 2]] };
    expectError(spec, 'appears in more than one ending');
  });

  it('rejects a gap in ending passes', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { times: 3, endings: [[1], [3]] };
    expectError(spec, 'do not cover 1..3');
  });

  it('rejects ending passes that disagree with times', () => {
    const spec = baseSpec();
    spec.sections[0].repeat = { times: 4, endings: [[1], [2]] };
    expectError(spec, 'repeat.times is 4');
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
