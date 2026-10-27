import { describe, it, expect } from 'vitest';
import { mergeRepeatedSections } from '../lib/roadmap-merge';
import { parseModelDraft } from '../lib/roadmap-parse';
import { tallySpec } from '../lib/roadmap-authoring';
import { validateRoadmapSpec, type BarChange, type RoadmapNavigation, type RoadmapSection, type RoadmapSpec } from '../lib/roadmap-spec';

// docs/design-roadmap-structure-editing.md §4 + §6 "Merge": one fixture per merge
// condition, the near-misses that must stay longhand, and the read-back tally.

const D: BarChange[] = [{ bar: 1, chords: [{ degree: 1 }] }, { bar: 3, chords: [{ degree: 4 }] }];
const E: BarChange[] = [{ bar: 1, chords: [{ degree: 6, quality: 'm' }] }];

function sec(id: string, label: string, bars = 4, changes: BarChange[] = D, extra: Partial<RoadmapSection> = {}): RoadmapSection {
  return { id, label, bars, changes, ...extra };
}

function spec(sections: RoadmapSection[], navigation?: RoadmapNavigation): RoadmapSpec {
  return { version: 1, timeSig: { beats: 4, unit: 4 }, renderKey: 'C', sections, ...(navigation ? { navigation } : {}) };
}

describe('mergeRepeatedSections — merges', () => {
  it('folds two identical Choruses into one Chorus ×2 that keeps the first id', () => {
    const out = mergeRepeatedSections(spec([sec('c1', 'Chorus'), sec('c2', 'Chorus')]));
    expect(out.sections).toEqual([sec('c1', 'Chorus', 4, D, { repeat: { kind: 'plain', times: 2 } })]);
    expect(validateRoadmapSpec(out).ok).toBe(true);
  });

  it('merges Verse 1 + Verse 2 under the base label (ruling §8.2), case-insensitive', () => {
    const out = mergeRepeatedSections(spec([sec('v1', 'Verse 1'), sec('v2', 'verse 2')]));
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].label).toBe('Verse');
    expect(out.sections[0].repeat).toEqual({ kind: 'plain', times: 2 });
  });

  it('compares changes by value, not by key order', () => {
    const reordered: BarChange[] = [{ chords: [{ degree: 1 }], bar: 1 }, { chords: [{ degree: 4 }], bar: 3 }];
    const out = mergeRepeatedSections(spec([sec('c1', 'Chorus'), sec('c2', 'Chorus', 4, reordered)]));
    expect(out.sections).toHaveLength(1);
  });

  it('three identical Verses then an Outro with a ref: ×3 and the ref is remapped', () => {
    const out = mergeRepeatedSections(spec(
      [sec('v1', 'Verse'), sec('v2', 'Verse'), sec('v3', 'Verse'), sec('o', 'Outro', 2, E)],
      { fine: { section: 3, bar: 2 } },
    ));
    expect(out.sections.map((s) => s.id)).toEqual(['v1', 'o']);
    expect(out.sections[0].repeat).toEqual({ kind: 'plain', times: 3 });
    expect(out.navigation).toEqual({ fine: { section: 1, bar: 2 } });
    expect(validateRoadmapSpec(out).ok).toBe(true);
  });

  it('accumulates several runs and keeps a ref into the FIRST section of a run', () => {
    const out = mergeRepeatedSections(spec(
      [sec('v1', 'Verse'), sec('v2', 'Verse'), sec('c1', 'Chorus', 2, E), sec('c2', 'Chorus', 2, E), sec('o', 'Outro', 4, E)],
      { segno: { section: 2, bar: 1 }, fine: { section: 4, bar: 4 } },
    ));
    expect(out.sections.map((s) => [s.id, s.repeat?.kind === 'plain' ? s.repeat.times : null]))
      .toEqual([['v1', 2], ['c1', 2], ['o', null]]);
    expect(out.navigation).toEqual({ segno: { section: 1, bar: 1 }, fine: { section: 2, bar: 4 } });
  });

  it('leaves a spec with nothing to merge untouched', () => {
    const s = spec([sec('i', 'Intro', 2, E), sec('v', 'Verse')]);
    expect(mergeRepeatedSections(s)).toBe(s);
  });
});

describe('mergeRepeatedSections — near-misses stay longhand', () => {
  const cases: [string, RoadmapSpec][] = [
    ['differs by one chord', spec([sec('c1', 'Chorus'), sec('c2', 'Chorus', 4, [D[0], { bar: 3, chords: [{ degree: 5 }] }])])],
    ['differs in bar count', spec([sec('c1', 'Chorus'), sec('c2', 'Chorus', 6)])],
    ['1-bar run (plain repeat needs >= 2 bars)', spec([sec('t1', 'Tag', 1, E), sec('t2', 'Tag', 1, E)])],
    ['Verse vs Chorus with identical chords', spec([sec('v', 'Verse'), sec('c', 'Chorus')])],
    ['non-adjacent', spec([sec('v1', 'Verse'), sec('c', 'Chorus', 2, E), sec('v2', 'Verse')])],
    ['existing repeat on the first', spec([sec('c1', 'Chorus', 4, D, { repeat: { kind: 'plain', times: 2 } }), sec('c2', 'Chorus')])],
    ['existing repeat on the second', spec([sec('c1', 'Chorus'), sec('c2', 'Chorus', 4, D, { repeat: { kind: 'plain', times: 2 } })])],
    ['nav ref into copy 2', spec([sec('c1', 'Chorus'), sec('c2', 'Chorus'), sec('o', 'Outro', 2, E)], { segno: { section: 1, bar: 3 } })],
    ['different blank bars (written content, never inherited — §8.5)', spec([sec('c1', 'Chorus', 4, [D[0]]), sec('c2', 'Chorus', 4, [D[0], { bar: 2, chords: [{ degree: 1 }] }])])],
  ];

  it.each(cases)('%s', (_name, s) => {
    expect(mergeRepeatedSections(s).sections).toHaveLength(s.sections.length);
  });

  it('two identical Verses before a D.C. stay longhand — merged would drop a pass (Codex R1)', () => {
    // Longhand plays V V O V V O (4 Verses). Merged, the VM keeps the repeat's pass
    // count across the D.C., so V×2 O V O plays 3 — not the same song.
    const s = spec(
      [sec('v1', 'Verse'), sec('v2', 'Verse'), sec('o', 'Outro', 2, E)],
      { jump: { at: { section: 2, bar: 2 }, from: 'capo', until: 'end' } },
    );
    expect(validateRoadmapSpec(s).ok).toBe(true);
    expect(mergeRepeatedSections(s)).toBe(s);
  });

  it('a jump that does NOT replay the run still allows the merge', () => {
    // D.S. back to the Outro's segno: the Verses are played once either way.
    const s = spec(
      [sec('v1', 'Verse'), sec('v2', 'Verse'), sec('o', 'Outro', 2, E), sec('t', 'Tag', 2, E)],
      { segno: { section: 2, bar: 1 }, jump: { at: { section: 3, bar: 2 }, from: 'segno', until: 'end' } },
    );
    const out = mergeRepeatedSections(s);
    expect(out.sections.map((x) => x.id)).toEqual(['v1', 'o', 't']);
    expect(out.navigation).toEqual({ segno: { section: 1, bar: 1 }, jump: { at: { section: 2, bar: 2 }, from: 'segno', until: 'end' } });
    expect(validateRoadmapSpec(out).ok).toBe(true);
  });
});

describe('parse pipeline — merge + read-back from the final spec', () => {
  const chorus = { bar: [{ degree: 1 }], bars: 4 };
  const draft = JSON.stringify({
    timeSig: { beats: 4, unit: 4 },
    sections: [
      { id: 'verse', label: 'Verse', spans: [{ bar: [{ degree: 1 }], bars: 2 }, { bar: [{ degree: 4, quality: '7' }], bars: 2 }] },
      { id: 'chorus-1', label: 'Chorus', spans: [chorus, { bar: [{ degree: 5 }], bars: 4 }] },
      { id: 'chorus-2', label: 'Chorus', spans: [chorus, { bar: [{ degree: 5 }], bars: 4 }] },
    ],
  });

  it('"2x chorus" from the model folds into Chorus ×2, and the tally says so', () => {
    const r = parseModelDraft(draft, 'D');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.sections.map((s) => s.id)).toEqual(['verse', 'chorus-1']);
    expect(r.spec.sections[1].repeat).toEqual({ kind: 'plain', times: 2 });
    expect(r.tally).toEqual([
      'Verse: 4 bars — D×2, G7×2',
      'Chorus ×2: 8 bars — D×4, A×4',
    ]);
  });

  it('keeps the SpanList tally (the diagnosis) when the draft fails', () => {
    const bad = JSON.stringify({
      timeSig: { beats: 4, unit: 4 },
      sections: [{ id: 'v', label: 'Verse', spans: [{ bar: [{ degree: 9 }], bars: 2 }] }],
    });
    const r = parseModelDraft(bad, 'D');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.tally?.[0]).toMatch(/^Verse: 2 bars/);
  });
});

describe('tallySpec — read-back from the final spec', () => {
  it('shows volta endings and leading blank bars without filling them in', () => {
    const lines = tallySpec(spec([
      sec('v', 'Verse', 4, [{ bar: 1, chords: [{ degree: 1 }] }, { bar: 4, chords: [{ degree: 5 }] }], {
        repeat: { kind: 'volta', endings: [{ bars: { start: 3, count: 1 }, passes: [1] }, { bars: { start: 4, count: 1 }, passes: [2] }] },
      }),
      sec('b', 'Break', 3, [{ bar: 3, chords: [{ degree: 4 }, { degree: 5 }] }]),
    ]));
    expect(lines).toEqual([
      'Verse, 2 endings: 4 bars — C×3, G',
      'Break: 3 bars — –×2, F G',
    ]);
  });
});
