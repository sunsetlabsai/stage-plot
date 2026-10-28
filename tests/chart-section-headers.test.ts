import { describe, it, expect } from 'vitest';
import {
  findSectionHeaders,
  parseHeaderLine,
  type HeaderPage,
  type HeaderTextItem,
} from '@/lib/chart-section-headers';

// ── Track B anchors: the header grammar (docs/design-common-roadmap.md §4.1 step 2) ──
//
// The grammar is the whole risk: a lyric line misread as a header puts a bogus seek
// target on the owner's chart. So the refusals are tested as hard as the matches.

describe('parseHeaderLine — matches', () => {
  it.each([
    ['INTRO 4X', 'INTRO', { bars: 4 }],
    ['VERSE 1 8X', 'VERSE 1', { bars: 8 }],
    ['Verse 8x', 'Verse', { bars: 8 }],
    ['CHORUS x2', 'CHORUS', { plays: 2 }],
    ['Chorus X 2', 'Chorus', { plays: 2 }],
    ['Chorus (x2)', 'Chorus', { plays: 2 }],
    ['Chorus ×2', 'Chorus', { plays: 2 }],
    ['PRE-CHORUS', 'PRE-CHORUS', null],
    ['Pre Chorus:', 'Pre Chorus', null],
    ['Post-Chorus 4x', 'Post-Chorus', { bars: 4 }],
    ['Bridge:', 'Bridge', null],
    ['OUT 4X', 'OUT', { bars: 4 }],
    ['  Outro  ', 'Outro', null],
    ['[Verse 1]', 'Verse 1', null],
    ['[Pre-Verse]', 'Pre-Verse', null],
    ['[Outro (Fade out)]', 'Outro (Fade out)', null],
    ['[Chorus x2]', 'Chorus', { plays: 2 }],
  ])('%j → %j', (line, label, count) => {
    expect(parseHeaderLine(line)).toEqual({ label, count });
  });

  it('accepts every word in the §1 vocabulary', () => {
    for (const w of [
      'intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'solo', 'outro', 'out', 'tag',
      'ending', 'interlude', 'break', 'breakdown', 'vamp', 'refrain', 'hook',
      'instrumental', 'coda', 'turnaround',
    ]) {
      expect(parseHeaderLine(w)?.label).toBe(w);
    }
  });
});

describe('parseHeaderLine — refusals (a lyric line is never a header)', () => {
  it.each([
    'the chorus of the night',
    'Verse of my heart',
    'Chorus G C D',
    'INTRO 4X G C D G',
    'Outside',
    'Breaking down',
    'Hooked on a feeling',
    'Introduction',
    '[Spoken]',
    '[x2]',
    'Key: G',
    'G  C  D',
    '',
    '   ',
  ])('%j', (line) => {
    expect(parseHeaderLine(line)).toBeNull();
  });
});

// A text item on a 600×800 page. Baseline at PDF y (up from the bottom).
const item = (str: string, x: number, base: number, size = 12, width?: number): HeaderTextItem => ({
  str,
  transform: [size, 0, 0, size, x, base],
  width: width ?? str.length * size * 0.5,
  height: size,
});
const page = (items: HeaderTextItem[], n = 1, view: HeaderPage['view'] = [0, 0, 600, 800]): HeaderPage => ({
  page: n,
  view,
  items,
});

describe('findSectionHeaders', () => {
  it('normalizes to the line start and the GLYPH TOP, 0..1 top-down', () => {
    const [h] = findSectionHeaders([page([item('VERSE 8X', 60, 700)])]);
    expect(h).toMatchObject({ page: 1, label: 'VERSE', count: { bars: 8 } });
    expect(h.x).toBeCloseTo(60 / 600);
    // top of glyph = baseline 700 + height 12 = 712 → (800 - 712) / 800
    expect(h.y).toBeCloseTo(88 / 800);
  });

  it('respects a shifted page origin', () => {
    const [h] = findSectionHeaders([page([item('Chorus', 110, 788)], 1, [50, 100, 650, 900])]);
    expect(h.x).toBeCloseTo(60 / 600);
    expect(h.y).toBeCloseTo((900 - 800) / 800);
  });

  it('joins a header split across runs on one baseline ("[Verse| |1]")', () => {
    const items = [item('[Verse', 40, 500, 12, 36), item(' ', 76, 500, 12, 3), item('1]', 79, 500.3, 12, 12)];
    expect(findSectionHeaders([page(items)]).map((h) => h.label)).toEqual(['Verse 1']);
  });

  it('joins adjacent runs of one word without inventing a space', () => {
    const items = [item('CHO', 40, 500, 12, 18), item('RUS', 58, 500, 12, 18)];
    expect(findSectionHeaders([page(items)]).map((h) => h.label)).toEqual(['CHORUS']);
  });

  it('keeps the chord line above a header separate from it', () => {
    const items = [item('G   C   D', 40, 514), item('CHORUS', 40, 500)];
    expect(findSectionHeaders([page(items)]).map((h) => h.label)).toEqual(['CHORUS']);
  });

  it('a section word sharing its baseline with chords is NOT a header', () => {
    const items = [item('INTRO 4X', 40, 500, 12, 48), item('G  C  D', 200, 500)];
    expect(findSectionHeaders([page(items)])).toEqual([]);
  });

  it('returns reading order across pages', () => {
    const p1 = page([item('CHORUS', 40, 300), item('INTRO 4X', 40, 700)], 1);
    const p2 = page([item('OUT', 40, 600)], 2);
    expect(findSectionHeaders([p2, p1]).map((h) => `${h.page}:${h.label}`)).toEqual([
      '1:INTRO',
      '1:CHORUS',
      '2:OUT',
    ]);
  });

  it('skips a page with a degenerate box rather than dividing by zero', () => {
    expect(findSectionHeaders([page([item('Chorus', 10, 10)], 1, [0, 0, 0, 0])])).toEqual([]);
  });

  it('falls back to the transform for height when pdf.js omits it', () => {
    const it0: HeaderTextItem = { str: 'Bridge', transform: [10, 0, 0, 10, 0, 400] };
    const [h] = findSectionHeaders([page([it0])]);
    expect(h.y).toBeCloseTo((800 - 410) / 800);
  });
});
