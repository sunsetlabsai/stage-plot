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
  parseLetterChord,
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

describe('navigation refs survive reorder / drop on remove (Codex #98 R2)', () => {
  // [A, B, C] with segno on B (index 1) and a D.S. al Fine: jump.at on C, fine on C.
  const NAV_SPEC: RoadmapSpec = {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'C',
    sections: [
      { id: 'a', label: 'A', bars: 2 },
      { id: 'b', label: 'B', bars: 2 },
      { id: 'c', label: 'C', bars: 2 },
    ],
    navigation: {
      segno: { section: 1, bar: 1 },
      fine: { section: 2, bar: 2 },
      jump: { at: { section: 2, bar: 2 }, from: 'segno', until: 'fine' },
    },
  };

  it('specToView keys nav refs by stable section id', () => {
    const v = specToView(NAV_SPEC);
    expect(v.navigation?.segno).toEqual({ sectionId: 'b', bar: 1 });
    expect(v.navigation?.fine).toEqual({ sectionId: 'c', bar: 2 });
    expect(v.navigation?.jump?.at).toEqual({ sectionId: 'c', bar: 2 });
  });

  it('round-trips at the same order', () => {
    expect(viewToSpec(specToView(NAV_SPEC))).toEqual(NAV_SPEC);
  });

  it('reorder retargets the index to follow the section, not the slot', () => {
    const v = specToView(NAV_SPEC);
    // Drag B to the top: [B, A, C].
    v.sections = [v.sections[1], v.sections[0], v.sections[2]];
    const spec = viewToSpec(v);
    // segno still points at B — now index 0, not the stale index 1 (would be A).
    expect(spec.navigation?.segno).toEqual({ section: 0, bar: 1 });
    expect(spec.navigation?.fine).toEqual({ section: 2, bar: 2 });
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('removing a referenced section drops navigation atomically', () => {
    const v = specToView(NAV_SPEC);
    // Remove B — segno's target id 'b' no longer resolves.
    v.sections = v.sections.filter((s) => s.id !== 'b');
    const spec = viewToSpec(v);
    expect(spec.navigation).toBeUndefined();
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('removing an unreferenced section keeps navigation (refs re-index)', () => {
    const v = specToView(NAV_SPEC);
    // Remove A — nothing references it; B/C refs survive at their new indices.
    v.sections = v.sections.filter((s) => s.id !== 'a');
    const spec = viewToSpec(v);
    expect(spec.navigation?.segno).toEqual({ section: 0, bar: 1 });
    expect(spec.navigation?.fine).toEqual({ section: 1, bar: 2 });
    expect(validateRoadmapSpec(spec).ok).toBe(true);
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

describe('Gap 1 — chromatic roots (alter)', () => {
  it('parses a flat root in both ASCII and Unicode (b7 / ♭7)', () => {
    expect(parseBarInput('b7', 4)).toEqual({ ok: true, cells: [cell(7, 4, { alter: -1 })] });
    expect(parseBarInput('♭7', 4)).toEqual({ ok: true, cells: [cell(7, 4, { alter: -1 })] });
  });

  it('parses a sharp root (#4 / ♯4)', () => {
    expect(parseBarInput('#4', 4)).toEqual({ ok: true, cells: [cell(4, 4, { alter: 1 })] });
    expect(parseBarInput('♯4', 4)).toEqual({ ok: true, cells: [cell(4, 4, { alter: 1 })] });
  });

  it('carries quality and a diatonic bass alongside an altered root (♭7 → b7/4)', () => {
    expect(parseBarInput('♭7/4', 4)).toEqual({ ok: true, cells: [cell(7, 4, { alter: -1, bass: 4 })] });
  });

  it('REJECTS a chromatic bass — never downgrades 1/b2 to 1/2', () => {
    const r = parseBarInput('1/b2', 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('chromatic bass');
    // the diatonic-bass form is still fine
    expect(parseBarInput('1/2', 4)).toEqual({ ok: true, cells: [cell(1, 4, { bass: 2 })] });
  });

  it('cellsToChordHits emits alter, omitting it when 0', () => {
    expect(cellsToChordHits([cell(7, 4, { alter: -1 })], 4)).toEqual([{ degree: 7, alter: -1 }]);
    expect(cellsToChordHits([cell(7, 4, { alter: 0 })], 4)).toEqual([{ degree: 7 }]);
    expect(cellsToChordHits([cell(7, 4)], 4)).toEqual([{ degree: 7 }]);
  });

  it('chordHitsToCells preserves alter', () => {
    expect(chordHitsToCells([{ degree: 7, alter: -1 }], 4)).toEqual([cell(7, 4, { alter: -1 })]);
  });

  it('a {7,-1} chord round-trips chordHitsToCells → cellsToChordHits', () => {
    const hits = [{ degree: 7, alter: -1 as const }];
    expect(cellsToChordHits(chordHitsToCells(hits, 4), 4)).toEqual(hits);
  });

  it('cellsToRaw shows the accidental glyph for an altered root', () => {
    expect(cellsToRaw([cell(7, 4, { alter: -1 })], 4)).toBe('♭7');
    expect(cellsToRaw([cell(4, 4, { alter: 1 })], 4)).toBe('♯4');
  });

  it('letters mode re-spells an altered root (♭7 in D = C, ♯4 in C = F#)', () => {
    expect(renderCell(cell(7, 4, { alter: -1 }), 'letters', 'D')).toBe('C');
    expect(renderCell(cell(4, 4, { alter: 1 }), 'letters', 'C')).toBe('F#');
  });
});

// Enharmonic key spelling (reported: F# selected → letters rendered "Gb"). A chart's
// letters must spell in the SELECTED key's own accidental, not its enharmonic twin.
// The bug was `/^F/` treating F# as a flat key; degreeLetter now decides by the
// key's actual # / b (and, for natural-letter keys, its signature).
describe('degreeLetter — spells in the selected key, not its enharmonic equivalent', () => {
  it('a SHARP key spells with sharps — F# is F#, not Gb (the reported bug)', () => {
    expect(degreeLetter(1, 'F#')).toBe('F#'); // was 'Gb'
    expect(degreeLetter(4, 'F#')).toBe('B');
    expect(degreeLetter(5, 'F#')).toBe('C#'); // was 'Db'
    expect(renderCell(cell(1, 4), 'letters', 'F#')).toBe('F#');
  });

  it('the other sharp keys the picker offers stay sharp', () => {
    expect(degreeLetter(1, 'C#m')).toBe('C#');
    expect(degreeLetter(1, 'F#m')).toBe('F#');
    expect(degreeLetter(1, 'G#m')).toBe('G#');
    expect(degreeLetter(7, 'D')).toBe('C#'); // sharp natural key's leading tone
  });

  it('spells only the ROOT — the chord QUALITY is untouched (i in F#m is F#m, not F#)', () => {
    // degreeLetter returns the root note; renderCell appends the chord quality. The
    // fix re-spells F#’s root (Gb → F#); it must NOT drop or change the minor.
    expect(renderCell(cell(1, 4, { quality: 'm' }), 'letters', 'F#m')).toBe('F#m');
    expect(renderCell(cell(4, 4, { quality: 'm' }), 'letters', 'F#m')).toBe('Bm');
    expect(renderCell(cell(5, 4), 'letters', 'F#m')).toBe('C#');
  });

  it('the flat keys the picker offers stay flat — Eb, Bb, Db, Ab, and Gb (F#’s twin)', () => {
    expect(degreeLetter(1, 'Eb')).toBe('Eb');
    expect(degreeLetter(1, 'Bb')).toBe('Bb');
    expect(degreeLetter(1, 'Db')).toBe('Db');
    expect(degreeLetter(1, 'Ab')).toBe('Ab');
    expect(degreeLetter(1, 'Gb')).toBe('Gb'); // Gb selected really does want Gb
    expect(degreeLetter(1, 'Ebm')).toBe('Eb');
  });

  it('natural-letter keys follow their signature — F major and the flat minors use flats', () => {
    expect(degreeLetter(4, 'F')).toBe('Bb'); // F major: subdominant is Bb, not A#
    expect(degreeLetter(3, 'Cm')).toBe('Eb'); // Cm: b3/b6/b7 spell flat
    expect(degreeLetter(6, 'Cm')).toBe('Ab');
    expect(degreeLetter(7, 'Cm')).toBe('Bb');
    expect(degreeLetter(3, 'Dm')).toBe('F');
  });
});

describe('parseLetterChord — letter chord → degree in a key (inverse of degreeLetter)', () => {
  it('reads a triad to its diatonic degree (key decides)', () => {
    // In D: G=4, A=5, Bm=6m, D=1.
    expect(parseLetterChord('G', 'D')).toEqual({ degree: 4 });
    expect(parseLetterChord('A', 'D')).toEqual({ degree: 5 });
    expect(parseLetterChord('D', 'D')).toEqual({ degree: 1 });
  });

  it('carries quality (G7 → 4/7, Bm7 → 6/m7)', () => {
    expect(parseLetterChord('G7', 'D')).toEqual({ degree: 4, quality: '7' });
    expect(parseLetterChord('Bm7', 'D')).toEqual({ degree: 6, quality: 'm7' });
  });

  it('reads a slash bass, and the KEY decides the degree (E/D: 2/1 in D, 6/5 in G)', () => {
    expect(parseLetterChord('E/D', 'D')).toEqual({ degree: 2, bass: 1 });
    expect(parseLetterChord('E/D', 'G')).toEqual({ degree: 6, bass: 5 });
  });

  it('reads flat-key letters (in Bb: Bb=1, Eb=4, F=5)', () => {
    expect(parseLetterChord('Bb', 'Bb')).toEqual({ degree: 1 });
    expect(parseLetterChord('Eb', 'Bb')).toEqual({ degree: 4 });
    expect(parseLetterChord('F', 'Bb')).toEqual({ degree: 5 });
  });

  it('canonicalizes a chromatic root to {degree,alter:-1} (Gap-1 prefer-flat-upper-neighbor)', () => {
    // C in D = ♭VII = upper neighbor of B(7) one semitone down → {7, alter:-1}.
    expect(parseLetterChord('C', 'D')).toEqual({ degree: 7, alter: -1 });
    // Eb in D = ♭2 (upper neighbor E=2); F in D = ♭3 (upper neighbor F#=3).
    expect(parseLetterChord('Eb', 'D')).toEqual({ degree: 2, alter: -1 });
    expect(parseLetterChord('F', 'D')).toEqual({ degree: 3, alter: -1 });
  });

  it('canonicalizes a chromatic root WITH quality (C7 in D → ♭7/7)', () => {
    expect(parseLetterChord('C7', 'D')).toEqual({ degree: 7, alter: -1, quality: '7' });
  });

  it('the five chromatic roots canonicalize to ♭2,♭3,♭5,♭6,♭7 in every MAJOR key', () => {
    // In a major scale the semitone gaps sit at 3-4 and 7-8, so the five chromatic
    // pitches flat-spell as ♭2,♭3,♭5,♭6,♭7 (♭4 and ♭1 would land ON a diatonic note,
    // so they are NOT chromatic). Re-spelling each back must round-trip the parse.
    for (const key of ['C', 'G', 'D', 'A', 'Bb', 'Eb']) {
      for (const degree of [2, 3, 5, 6, 7]) {
        const letter = degreeLetter(degree, key, -1);
        expect(parseLetterChord(letter, key)).toEqual({ degree, alter: -1 });
      }
    }
  });

  it('canonicalizes chromatic roots in a MINOR key by the same upper-neighbor rule', () => {
    // Minor's semitone gaps sit at 2-3 and 5-6, so the chromatic flats are a
    // different degree set: ♭1,♭2,♭4,♭5,♭7 (♭3 and ♭6 would land on a diatonic note).
    for (const key of ['Am', 'Em']) {
      for (const degree of [1, 2, 4, 5, 7]) {
        const letter = degreeLetter(degree, key, -1);
        expect(parseLetterChord(letter, key)).toEqual({ degree, alter: -1 });
      }
    }
  });

  it('defers the WHOLE token on a chromatic slash bass (E/Eb in D → null)', () => {
    expect(parseLetterChord('E/Eb', 'D')).toBeNull();
  });

  it('round-trips against degreeLetter across keys for every diatonic degree', () => {
    for (const key of ['C', 'G', 'D', 'A', 'Bb', 'Eb', 'Am', 'Em']) {
      for (let degree = 1; degree <= 7; degree++) {
        const letter = degreeLetter(degree, key);
        expect(parseLetterChord(letter, key)).toEqual({ degree });
      }
    }
  });
});

describe('parseBarInput — letter-aware in key context', () => {
  it('accepts a letter chord when renderKey is given (G7 in D → 4/7)', () => {
    expect(parseBarInput('G7', 4, 'D')).toEqual({ ok: true, cells: [cell(4, 4, { quality: '7' })] });
  });

  it('accepts a letter slash bass (E/D in D → 2 over 1)', () => {
    expect(parseBarInput('E/D', 4, 'D')).toEqual({ ok: true, cells: [cell(2, 4, { bass: 1 })] });
  });

  it('canonicalizes a chromatic letter root through the bar parser (C in D → ♭7)', () => {
    expect(parseBarInput('C', 4, 'D')).toEqual({ ok: true, cells: [cell(7, 4, { alter: -1 })] });
  });

  it('errors with the key name on a chromatic slash bass (E/Eb in D)', () => {
    const r = parseBarInput('E/Eb', 4, 'D');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('D');
  });

  it('still parses degree/roman tokens unchanged when a key is present', () => {
    expect(parseBarInput('4 5', 4, 'D')).toEqual({ ok: true, cells: [cell(4, 2), cell(5, 2)] });
  });
});

// ── §6 golden round-trip (the edit-loop fidelity guard) ──────────────────────
// The load-bearing claim for re-open: viewToSpec(specToView(spec)) is IDENTITY for
// any CANONICAL builder spec, so opening a saved chart and saving it without edits
// never silently mutates it. These fixtures are deliberately CANONICAL — the shapes
// the builder actually emits (Codex R2 LOW): the claim is NOT identity for every
// validateRoadmapSpec-valid JSON (noncanonical fields normalize away; see the last
// test). held + barsPerLine are pinned explicitly because both ride the ViewModel
// and a regression would silently drop a hold or re-flow the chart on save.
describe('§6 golden round-trip — canonical specs are identity', () => {
  const GOLDEN: Array<{ name: string; spec: RoadmapSpec }> = [
    {
      name: 'linear (sparse changes, single + inherited bars)',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'G',
        sections: [{ id: 'intro', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] }],
      },
    },
    {
      name: 'split bars (even division + uneven explicit beats)',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'C',
        sections: [
          {
            id: 'v',
            label: 'Verse',
            bars: 2,
            changes: [
              { bar: 1, chords: [{ degree: 1 }, { degree: 4 }] },
              { bar: 2, chords: [{ degree: 1, beats: 3 }, { degree: 5, beats: 1 }] },
            ],
          },
        ],
      },
    },
    {
      name: 'plain repeat',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'D',
        sections: [
          {
            id: 'ch',
            label: 'Chorus',
            bars: 4,
            repeat: { kind: 'plain', times: 2 },
            changes: [{ bar: 1, chords: [{ degree: 1 }] }],
          },
        ],
      },
    },
    {
      name: 'volta endings',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'A',
        sections: [
          {
            id: 'v',
            label: 'Verse',
            bars: 6,
            repeat: {
              kind: 'volta',
              endings: [
                { bars: { start: 5, count: 1 }, passes: [1] },
                { bars: { start: 6, count: 1 }, passes: [2] },
              ],
            },
            changes: [{ bar: 1, chords: [{ degree: 1 }] }],
          },
        ],
      },
    },
    {
      name: 'alters (♭VII), quality, and a diatonic slash bass',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'D',
        sections: [
          {
            id: 'br',
            label: 'Bridge',
            bars: 2,
            changes: [
              { bar: 1, chords: [{ degree: 7, alter: -1 }] },
              { bar: 2, chords: [{ degree: 4, quality: 'm7' }, { degree: 5, bass: 7 }] },
            ],
          },
        ],
      },
    },
    {
      name: 'held chords (diamond whole-bar)',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'G',
        sections: [{ id: 'out', label: 'Outro', bars: 2, changes: [{ bar: 1, chords: [{ degree: 1, held: true }] }] }],
      },
    },
    {
      name: 'non-default barsPerLine',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'C',
        barsPerLine: 2,
        sections: [{ id: 'a', label: 'A', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] }],
      },
    },
    {
      name: 'full navigation (D.S. al Coda)',
      spec: {
        version: 1,
        timeSig: { beats: 4, unit: 4 },
        renderKey: 'C',
        sections: [
          { id: 'a', label: 'A', bars: 4 },
          { id: 'b', label: 'B', bars: 4 },
        ],
        navigation: {
          segno: { section: 0, bar: 1 },
          coda: { section: 1, bar: 3 },
          toCoda: { section: 0, bar: 4 },
          jump: { at: { section: 1, bar: 4 }, from: 'segno', until: 'coda' },
        },
      },
    },
  ];

  for (const { name, spec } of GOLDEN) {
    it(`${name}: is a valid spec`, () => {
      expect(validateRoadmapSpec(spec).ok).toBe(true);
    });
    it(`${name}: viewToSpec(specToView(spec)) === spec`, () => {
      expect(viewToSpec(specToView(spec))).toEqual(spec);
    });
    it(`${name}: round-tripped spec stays valid`, () => {
      expect(validateRoadmapSpec(viewToSpec(specToView(spec))).ok).toBe(true);
    });
  }

  it('noncanonical-but-valid fields normalize away (NOT identity — by design)', () => {
    // quality:'', alter:0, held:false are all valid per validateRoadmapSpec but are
    // NOT the canonical form the builder emits, so the round trip drops them. This
    // pins the scoped claim: identity holds for canonical specs, not arbitrary JSON.
    const noncanonical: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      sections: [
        { id: 'a', label: 'A', bars: 1, changes: [{ bar: 1, chords: [{ degree: 1, quality: '', alter: 0, held: false }] }] },
      ],
    };
    expect(validateRoadmapSpec(noncanonical).ok).toBe(true);
    const round = viewToSpec(specToView(noncanonical));
    expect(round.sections[0].changes![0].chords[0]).toEqual({ degree: 1 });
    expect(round).not.toEqual(noncanonical);
  });
});
