import { describe, it, expect } from 'vitest';
import type { Bar, ChartCalibration, RoadmapMarker, SectionAnchor } from '../lib/types';
import {
  type SongStructure,
  type CanonicalSection,
  type CanonicalBar,
  type ChartAlignment,
  normalizeLabel,
  locateRef,
  resolveRef,
  seedAlignment,
  rekeyAlignment,
} from '../lib/song-structure';

// ── builders ─────────────────────────────────────────────────────────────────
const cs = (id: string, label: string): CanonicalSection => ({ id, label });
const cbar = (id: string, sectionId: string): CanonicalBar => ({ id, sectionId });
const sa = (id: string, label: string): SectionAnchor => ({ id, page: 1, x: 0, y: 0, label });
const bar = (id: string, sectionId: string, absNumber: number): Bar => ({
  id, systemId: 'sys', xStart: 0, xEnd: 1, absNumber, sectionId,
});

// Canonical "song": Intro(2) Solo(8, written out) Outro(2), structurally flat.
function makeStructure(): SongStructure {
  return {
    songId: 'song-1',
    sections: [cs('intro', 'Intro'), cs('solo', 'Solo'), cs('outro', 'Outro')],
    bars: [
      cbar('c-i1', 'intro'), cbar('c-i2', 'intro'),
      cbar('c-s1', 'solo'), cbar('c-s2', 'solo'), cbar('c-s3', 'solo'), cbar('c-s4', 'solo'),
      cbar('c-s5', 'solo'), cbar('c-s6', 'solo'), cbar('c-s7', 'solo'), cbar('c-s8', 'solo'),
      cbar('c-o1', 'outro'), cbar('c-o2', 'outro'),
    ],
    roadmap: [],
  };
}

// Guitar writes the solo out: 8 physical bars, no structural markers (matches canonical).
function guitarCal(): Pick<ChartCalibration, 'sections' | 'bars' | 'roadmap'> {
  return {
    sections: [sa('g-intro', 'Intro'), sa('g-solo', 'Solo'), sa('g-outro', 'Outro')],
    bars: [
      bar('g-i1', 'g-intro', 1), bar('g-i2', 'g-intro', 2),
      bar('g-s1', 'g-solo', 3), bar('g-s2', 'g-solo', 4), bar('g-s3', 'g-solo', 5), bar('g-s4', 'g-solo', 6),
      bar('g-s5', 'g-solo', 7), bar('g-s6', 'g-solo', 8), bar('g-s7', 'g-solo', 9), bar('g-s8', 'g-solo', 10),
      bar('g-o1', 'g-outro', 11), bar('g-o2', 'g-outro', 12),
    ],
    roadmap: [],
  };
}

// Horn uses repeat signs: 4 physical solo bars + |: :| ×2. Same music, divergent geometry.
function hornCal(): Pick<ChartCalibration, 'sections' | 'bars' | 'roadmap'> {
  const roadmap: RoadmapMarker[] = [
    { id: 'h-rs', kind: 'repeatStart', barId: 'h-s1', edge: 'start' },
    { id: 'h-re', kind: 'repeatEnd', barId: 'h-s4', edge: 'end', repeatStartId: 'h-rs', times: 2 },
  ];
  return {
    sections: [sa('h-intro', 'Intro'), sa('h-solo', 'Solo'), sa('h-outro', 'Outro')],
    bars: [
      bar('h-i1', 'h-intro', 1), bar('h-i2', 'h-intro', 2),
      bar('h-s1', 'h-solo', 3), bar('h-s2', 'h-solo', 4), bar('h-s3', 'h-solo', 5), bar('h-s4', 'h-solo', 6),
      bar('h-o1', 'h-outro', 7), bar('h-o2', 'h-outro', 8),
    ],
    roadmap,
  };
}

describe('song-structure — normalizeLabel', () => {
  it('lowercases, trims, collapses whitespace', () => {
    expect(normalizeLabel('  Chorus ')).toBe('chorus');
    expect(normalizeLabel('Guitar   Solo')).toBe('guitar solo');
  });
});

describe('song-structure — seedAlignment (label+ordinal seed)', () => {
  it('matches by normalized label → local, unmatched → unmapped', () => {
    const s = makeStructure();
    const a = seedAlignment(s, 'guitar', guitarCal());
    expect(a.sections['intro']).toEqual({ status: 'local', localSectionId: 'g-intro', barIsomorphic: true });
    expect(a.sections['solo']).toEqual({ status: 'local', localSectionId: 'g-solo', barIsomorphic: true });
    expect(a.sections['outro']).toEqual({ status: 'local', localSectionId: 'g-outro', barIsomorphic: true });
  });

  it('flags a divergent (repeat-sign) section as NOT bar-isomorphic', () => {
    const s = makeStructure();
    const a = seedAlignment(s, 'horn', hornCal());
    // bar count differs (8 canonical vs 4 local) AND the local span carries a repeat.
    expect(a.sections['solo']).toEqual({ status: 'local', localSectionId: 'h-solo', barIsomorphic: false });
    expect(a.sections['intro']).toEqual({ status: 'local', localSectionId: 'h-intro', barIsomorphic: true });
  });

  it('seeds an absent canonical section as unmapped (never tacet — honest, → review)', () => {
    const s = makeStructure();
    s.sections.splice(2, 0, cs('bridge', 'Bridge')); // canonical has a Bridge the chart lacks
    s.bars.push(cbar('c-b1', 'bridge'), cbar('c-b2', 'bridge'));
    const a = seedAlignment(s, 'guitar', guitarCal());
    expect(a.sections['bridge']).toEqual({ status: 'unmapped' });
  });

  it('disambiguates repeated labels by ordinal (Chorus #1 ↔ #1, #2 ↔ #2)', () => {
    const s: SongStructure = {
      songId: 'song-2',
      sections: [cs('ch1', 'Chorus'), cs('vs', 'Verse'), cs('ch2', 'Chorus')],
      bars: [cbar('b1', 'ch1'), cbar('b2', 'vs'), cbar('b3', 'ch2')],
      roadmap: [],
    };
    const cal = {
      sections: [sa('l-ch1', 'Chorus'), sa('l-vs', 'Verse'), sa('l-ch2', 'Chorus')],
      bars: [bar('lb1', 'l-ch1', 1), bar('lb2', 'l-vs', 2), bar('lb3', 'l-ch2', 3)],
      roadmap: [],
    };
    const a = seedAlignment(s, 'c', cal);
    expect((a.sections['ch1'] as { localSectionId: string }).localSectionId).toBe('l-ch1');
    expect((a.sections['ch2'] as { localSectionId: string }).localSectionId).toBe('l-ch2');
  });
});

describe('song-structure — §2.4 divergence (same place, different charts)', () => {
  it('a {section} ref resolves to each chart\'s OWN local section', () => {
    const s = makeStructure();
    const g = seedAlignment(s, 'guitar', guitarCal());
    const h = seedAlignment(s, 'horn', hornCal());
    const ref = { kind: 'section', sectionId: 'solo' } as const;
    expect(resolveRef(s, g, ref)).toEqual({ status: 'local', localSectionId: 'g-solo', barOffset: 0, barApproximate: false });
    expect(resolveRef(s, h, ref)).toEqual({ status: 'local', localSectionId: 'h-solo', barOffset: 0, barApproximate: false });
  });

  it('a mid-section barOffset passes through an isomorphic chart, drops to head on a divergent one (§2.3.1)', () => {
    const s = makeStructure();
    const g = seedAlignment(s, 'guitar', guitarCal());
    const h = seedAlignment(s, 'horn', hornCal());
    const ref = { kind: 'section', sectionId: 'solo', barOffset: 4 } as const;
    // Guitar is bar-isomorphic → honor the offset exactly.
    expect(resolveRef(s, g, ref)).toEqual({ status: 'local', localSectionId: 'g-solo', barOffset: 4, barApproximate: false });
    // Horn is not → coarsen to the section head, flag approximate. Never a guessed bar.
    expect(resolveRef(s, h, ref)).toEqual({ status: 'local', localSectionId: 'h-solo', barOffset: 0, barApproximate: true });
  });
});

describe('song-structure — tacet (rest + re-home, §2.2.0)', () => {
  it('resolves to tacet with the next present local section as re-home target', () => {
    const s = makeStructure();
    s.sections.splice(2, 0, cs('bridge', 'Bridge'));
    s.bars.push(cbar('c-b1', 'bridge'));
    const a: ChartAlignment = {
      songId: 'song-1',
      chartId: 'horn',
      sections: {
        intro: { status: 'local', localSectionId: 'h-intro', barIsomorphic: true },
        solo: { status: 'local', localSectionId: 'h-solo', barIsomorphic: false },
        bridge: { status: 'tacet' },
        outro: { status: 'local', localSectionId: 'h-outro', barIsomorphic: true },
      },
    };
    expect(resolveRef(s, a, { kind: 'section', sectionId: 'bridge' })).toEqual({
      status: 'tacet',
      rehomeSectionId: 'h-outro',
    });
  });

  it('re-home is null when nothing present follows (tacet to the end)', () => {
    const s: SongStructure = {
      songId: 'song-1',
      sections: [cs('intro', 'Intro'), cs('outro', 'Outro')],
      bars: [cbar('c-i1', 'intro'), cbar('c-o1', 'outro')],
      roadmap: [],
    };
    const a: ChartAlignment = {
      songId: 'song-1',
      chartId: 'horn',
      sections: {
        intro: { status: 'local', localSectionId: 'h-intro', barIsomorphic: true },
        outro: { status: 'tacet' },
      },
    };
    expect(resolveRef(s, a, { kind: 'section', sectionId: 'outro' })).toEqual({
      status: 'tacet',
      rehomeSectionId: null,
    });
  });
});

describe('song-structure — unmapped self-nav (§2.2.0 / §7)', () => {
  it('an unmapped section resolves to unresolved (no snap, member self-navigates)', () => {
    const s = makeStructure();
    const a: ChartAlignment = {
      songId: 'song-1',
      chartId: 'x',
      sections: { solo: { status: 'unmapped' } },
    };
    expect(resolveRef(s, a, { kind: 'section', sectionId: 'solo' })).toEqual({ status: 'unresolved' });
  });

  it('a canonical section with NO alignment entry also self-navigates (never guesses)', () => {
    const s = makeStructure();
    const a: ChartAlignment = { songId: 'song-1', chartId: 'x', sections: {} };
    expect(resolveRef(s, a, { kind: 'section', sectionId: 'solo' })).toEqual({ status: 'unresolved' });
  });
});

describe('song-structure — locateRef (ref forms → canonical section + offset)', () => {
  it('pieceStart → first section, offset 0', () => {
    const s = makeStructure();
    expect(locateRef(s, { kind: 'pieceStart' })).toEqual({ sectionId: 'intro', offset: 0 });
  });

  it('segno / coda / fine resolve through their canonical bar', () => {
    const s = makeStructure();
    s.roadmap = [
      { id: 'sg', kind: 'segno', barId: 'c-s2', edge: 'start' },
      { id: 'cd', kind: 'coda', barId: 'c-o1', edge: 'start' },
      { id: 'fn', kind: 'fine', barId: 'c-o2', edge: 'end' },
    ];
    expect(locateRef(s, { kind: 'segno' })).toEqual({ sectionId: 'solo', offset: 1 });
    expect(locateRef(s, { kind: 'coda' })).toEqual({ sectionId: 'outro', offset: 0 });
    expect(locateRef(s, { kind: 'fine' })).toEqual({ sectionId: 'outro', offset: 1 });
  });

  it('a repeatStart ref offsets from the repeat bar within its section', () => {
    const s = makeStructure();
    s.roadmap = [{ id: 'rs', kind: 'repeatStart', barId: 'c-s3', edge: 'start' }];
    expect(locateRef(s, { kind: 'repeatStart', markerId: 'rs' })).toEqual({ sectionId: 'solo', offset: 2 });
    expect(locateRef(s, { kind: 'repeatStart', markerId: 'rs', barOffset: 2 })).toEqual({ sectionId: 'solo', offset: 4 });
  });

  it('returns null for a ref naming a marker the structure lacks (stale/corrupt directive)', () => {
    const s = makeStructure();
    expect(locateRef(s, { kind: 'segno' })).toBeNull();
    expect(locateRef(s, { kind: 'repeatStart', markerId: 'nope' })).toBeNull();
    expect(locateRef(s, { kind: 'section', sectionId: 'ghost' })).toBeNull();
  });
});

describe('song-structure — re-key on owner edit (§2.2.1, stable ids)', () => {
  it('rename preserves ids → all alignments survive untouched', () => {
    const s = makeStructure();
    const a = seedAlignment(s, 'guitar', guitarCal());
    const renamed: SongStructure = { ...s, sections: [cs('intro', 'Opening'), cs('solo', 'Guitar Solo'), cs('outro', 'Tag')] };
    const { alignment, broken } = rekeyAlignment(renamed, a);
    expect(broken).toEqual([]);
    expect(alignment.sections).toEqual(a.sections);
    // id-keyed, so resolveRef still works against the renamed structure.
    expect(resolveRef(renamed, alignment, { kind: 'section', sectionId: 'solo' }))
      .toEqual({ status: 'local', localSectionId: 'g-solo', barOffset: 0, barApproximate: false });
  });

  it('reorder preserves ids → alignments survive', () => {
    const s = makeStructure();
    const a = seedAlignment(s, 'guitar', guitarCal());
    const reordered: SongStructure = { ...s, sections: [s.sections[2], s.sections[0], s.sections[1]] };
    const { alignment, broken } = rekeyAlignment(reordered, a);
    expect(broken).toEqual([]);
    expect(Object.keys(alignment.sections).sort()).toEqual(['intro', 'outro', 'solo']);
  });

  it('split/replace mints new ids → ONLY the removed node breaks; survivors carry over', () => {
    const s = makeStructure();
    const a = seedAlignment(s, 'guitar', guitarCal());
    // Owner splits Solo into SoloA/SoloB — old id 'solo' is gone, two new ids minted.
    const split: SongStructure = {
      ...s,
      sections: [cs('intro', 'Intro'), cs('solo-a', 'Solo A'), cs('solo-b', 'Solo B'), cs('outro', 'Outro')],
    };
    const { alignment, broken } = rekeyAlignment(split, a);
    expect(broken).toEqual(['solo']);
    expect(alignment.sections['intro']).toBeDefined();
    expect(alignment.sections['outro']).toBeDefined();
    expect(alignment.sections['solo']).toBeUndefined();
    // The new sections have no entry yet → self-nav until re-seeded.
    expect(resolveRef(split, alignment, { kind: 'section', sectionId: 'solo-a' })).toEqual({ status: 'unresolved' });
  });
});
