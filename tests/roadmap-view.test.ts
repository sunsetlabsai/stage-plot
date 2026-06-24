import { describe, it, expect } from 'vitest';
import {
  parseBarInput,
  cellsToRaw,
  cellsToChordHits,
  chordHitsToCells,
  specToView,
  viewToSpec,
  fitBars,
  renderCell,
  degreeLetter,
  type ViewCell,
} from '../lib/roadmap-view';
import { validateRoadmapSpec, type RoadmapSpec } from '../lib/roadmap-spec';

const cell = (degree: number, beats: number, extra: Partial<ViewCell> = {}): ViewCell => ({
  degree,
  quality: '',
  beats,
  ...extra,
});

describe('parseBarInput', () => {
  it('empty input clears the bar (inherit)', () => {
    expect(parseBarInput('   ', 4)).toEqual({ ok: true, cells: [] });
  });

  it('single chord spans the whole bar', () => {
    expect(parseBarInput('1', 4)).toEqual({ ok: true, cells: [cell(1, 4)] });
  });

  it('two chords split a 4-beat bar evenly (2 + 2)', () => {
    expect(parseBarInput('5 4', 4)).toEqual({ ok: true, cells: [cell(5, 2), cell(4, 2)] });
  });

  it('tie grammar weights an uneven 2/1/1 split', () => {
    expect(parseBarInput('1 - 4 5', 4)).toEqual({
      ok: true,
      cells: [cell(1, 2), cell(4, 1), cell(5, 1)],
    });
  });

  it('rejects a non-dividing even split and suggests "-"', () => {
    const r = parseBarInput('1 4 5', 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/don't divide 4 beats evenly/);
  });

  it('rejects tied beats that do not fill the bar', () => {
    const r = parseBarInput('1 - 4', 4); // 2 + 1 = 3
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sum to 3, expected 4/);
  });

  it('rejects a leading "-"', () => {
    const r = parseBarInput('- 4', 4);
    expect(r.ok).toBe(false);
  });

  it('normalizes roman numerals (IV → 4)', () => {
    expect(parseBarInput('IV', 4)).toEqual({ ok: true, cells: [cell(4, 4)] });
  });

  it('lowercase roman is minor (vi → 6m)', () => {
    expect(parseBarInput('vi', 4)).toEqual({
      ok: true,
      cells: [cell(6, 4, { quality: 'm' })],
    });
  });

  it('keeps an explicit quality on a roman (V7 → 5 dom7)', () => {
    expect(parseBarInput('V7', 4)).toEqual({
      ok: true,
      cells: [cell(5, 4, { quality: '7' })],
    });
  });

  it('parses a slash chord (1/3)', () => {
    expect(parseBarInput('1/3', 4)).toEqual({
      ok: true,
      cells: [cell(1, 4, { bass: 3 })],
    });
  });

  it('rejects an unknown quality', () => {
    const r = parseBarInput('1xyz', 4);
    expect(r.ok).toBe(false);
  });

  it('rejects a degree out of range (8)', () => {
    const r = parseBarInput('8', 4);
    expect(r.ok).toBe(false);
  });

  it('handles a non-4/4 even split (3 chords in 6/8 → 2 each)', () => {
    expect(parseBarInput('1 4 5', 6)).toEqual({
      ok: true,
      cells: [cell(1, 2), cell(4, 2), cell(5, 2)],
    });
  });
});

describe('cellsToRaw — terse round-trip', () => {
  it('single chord → just the chord', () => {
    expect(cellsToRaw([cell(1, 4)], 4)).toBe('1');
  });

  it('even split → no dashes', () => {
    expect(cellsToRaw([cell(5, 2), cell(4, 2)], 4)).toBe('5 4');
  });

  it('uneven split → dashes', () => {
    expect(cellsToRaw([cell(1, 2), cell(4, 1), cell(5, 1)], 4)).toBe('1 - 4 5');
  });

  it('empty → empty string', () => {
    expect(cellsToRaw([], 4)).toBe('');
  });

  it('round-trips minor + slash', () => {
    const cells = [cell(6, 2, { quality: 'm' }), cell(1, 2, { bass: 3 })];
    expect(cellsToRaw(cells, 4)).toBe('6m 1/3');
  });
});

describe('cellsToChordHits — canonical beats reconciliation (Codex caution)', () => {
  it('single chord emits NO beats field (whole bar)', () => {
    expect(cellsToChordHits([cell(1, 4)], 4)).toEqual([{ degree: 1 }]);
  });

  it('even split emits NO beats field (validator infers even division)', () => {
    expect(cellsToChordHits([cell(5, 2), cell(4, 2)], 4)).toEqual([
      { degree: 5 },
      { degree: 4 },
    ]);
  });

  it('uneven split emits explicit beats on every chord', () => {
    expect(cellsToChordHits([cell(1, 2), cell(4, 1), cell(5, 1)], 4)).toEqual([
      { degree: 1, beats: 2 },
      { degree: 4, beats: 1 },
      { degree: 5, beats: 1 },
    ]);
  });

  it('carries quality, bass, held', () => {
    expect(
      cellsToChordHits([cell(6, 4, { quality: 'm7', bass: 1, held: true })], 4),
    ).toEqual([{ degree: 6, quality: 'm7', bass: 1, held: true }]);
  });

  it('produced hits pass the spec validator (even, uneven, whole)', () => {
    const mk = (cells: ViewCell[]): RoadmapSpec => ({
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      sections: [
        { id: 's', label: 'S', bars: 1, changes: [{ bar: 1, chords: cellsToChordHits(cells, 4) }] },
      ],
    });
    expect(validateRoadmapSpec(mk([cell(1, 4)])).ok).toBe(true);
    expect(validateRoadmapSpec(mk([cell(5, 2), cell(4, 2)])).ok).toBe(true);
    expect(validateRoadmapSpec(mk([cell(1, 2), cell(4, 1), cell(5, 1)])).ok).toBe(true);
  });
});

describe('chordHitsToCells — inverse', () => {
  it('whole bar → single full-span cell', () => {
    expect(chordHitsToCells([{ degree: 1 }], 4)).toEqual([cell(1, 4)]);
  });

  it('even-division hits → equal spans', () => {
    expect(chordHitsToCells([{ degree: 5 }, { degree: 4 }], 4)).toEqual([
      cell(5, 2),
      cell(4, 2),
    ]);
  });

  it('explicit beats → those spans', () => {
    expect(
      chordHitsToCells([{ degree: 1, beats: 2 }, { degree: 4, beats: 1 }, { degree: 5, beats: 1 }], 4),
    ).toEqual([cell(1, 2), cell(4, 1), cell(5, 1)]);
  });
});

describe('fitBars', () => {
  it('pads short arrays with null', () => {
    expect(fitBars([[cell(1, 4)]], 3)).toEqual([[cell(1, 4)], null, null]);
  });
  it('truncates long arrays', () => {
    expect(fitBars([null, null, null], 2)).toEqual([null, null]);
  });
});

describe('spec ↔ view round-trip', () => {
  const SPEC: RoadmapSpec = {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'G',
    sections: [
      { id: 'intro', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
      {
        id: 'verse',
        label: 'Verse',
        bars: 2,
        repeat: { kind: 'plain', times: 2 },
        changes: [
          { bar: 1, chords: [{ degree: 1 }, { degree: 4 }] },          // even split
          { bar: 2, chords: [{ degree: 1, beats: 3 }, { degree: 5, beats: 1 }] }, // uneven explicit
        ],
      },
    ],
  };

  it('specToView expands sparse changes onto per-bar arrays', () => {
    const v = specToView(SPEC);
    expect(v.sections[0].chords).toHaveLength(4);
    expect(v.sections[0].chords[0]).toEqual([cell(1, 4)]);
    expect(v.sections[0].chords[1]).toBeNull();
    expect(v.sections[1].chords[0]).toEqual([cell(1, 2), cell(4, 2)]);
  });

  it('viewToSpec re-derives the same canonical spec', () => {
    expect(viewToSpec(specToView(SPEC))).toEqual(SPEC);
  });

  it('round-tripped spec stays valid', () => {
    expect(validateRoadmapSpec(viewToSpec(specToView(SPEC))).ok).toBe(true);
  });
});

describe('renderCell — numbers vs letters', () => {
  it('numbers mode shows the degree form', () => {
    expect(renderCell(cell(6, 4, { quality: 'm' }), 'numbers', 'G')).toBe('6m');
  });

  it('letters mode re-spells into the key', () => {
    // In G: 1=G, 4=C, 5=D, 6m=Em.
    expect(renderCell(cell(1, 4), 'letters', 'G')).toBe('G');
    expect(renderCell(cell(4, 4), 'letters', 'G')).toBe('C');
    expect(renderCell(cell(6, 4, { quality: 'm' }), 'letters', 'G')).toBe('Em');
  });

  it('re-spells a slash bass too', () => {
    expect(renderCell(cell(1, 4, { bass: 5 }), 'letters', 'C')).toBe('C/G');
  });

  it('degreeLetter handles flat keys', () => {
    expect(degreeLetter(4, 'Bb')).toBe('Eb');
  });
});
