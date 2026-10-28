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
    // Measured on a live sheet: a two-digit count is a count, never ordinal + count.
    ['VERSE 16X', 'VERSE', { bars: 16 }],
    ['CHORUS 12X', 'CHORUS', { bars: 12 }],
    ['VERSE 2 16X', 'VERSE 2', { bars: 16 }],
    ['VERSE 12', 'VERSE 12', null],
    ['VERSE 1 X', 'VERSE 1', null],
    ['INTRO ?X', 'INTRO', null],
    ['CHORUS X', 'CHORUS', null],
    ['CHORUS INSTRUMENTAL 8X', 'CHORUS INSTRUMENTAL', { bars: 8 }],
    ['Intro Vamp', 'Intro Vamp', null],
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
      const cap = w[0].toUpperCase() + w.slice(1);
      expect(parseHeaderLine(cap)?.label).toBe(cap);
      expect(parseHeaderLine(w.toUpperCase())?.label).toBe(w.toUpperCase());
    }
  });
});

describe('parseHeaderLine — refusals (a lyric line is never a header)', () => {
  it.each([
    'the chorus of the night',
    'Verse of my heart',
    'Chorus G C D',
    'Chorus girl',
    'VERSE 1X2',
    'INTRO 4X G C D G',
    'Outside',
    'Breaking down',
    'Hooked on a feeling',
    'Introduction',
    '[Spoken]',
    '[x2]',
    // A lyric's last word wrapped onto its own line (measured on the live library).
    'out',
    'break',
    'chorus',
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
    // Chords a few spaces after the label — one line, not two columns.
    const items = [item('INTRO 4X', 40, 500, 12, 48), item('G  C  D', 112, 500)];
    expect(findSectionHeaders([page(items)])).toEqual([]);
  });

  it('two columns: a left-column header beside a right-column lyric on (nearly) one baseline', () => {
    // Measured on the live library: "VERSE 1" at x=36 next to a lyric at x=320, baselines 2pt apart.
    const items = [item('VERSE 1', 36, 689.25, 11.5, 50.5), item('Like thoughts inside a dream', 320, 687, 14, 180)];
    expect(findSectionHeaders([page(items)]).map((h) => h.label)).toEqual(['VERSE 1']);
  });

  it('two columns, narrow gutter: a header 2.7pt off a lyric baseline, 34pt to its right', () => {
    // Measured on a live sheet ("1979"): too narrow for the gutter split; the baseline decides.
    const items = [item('.. Double cross the vacant and the bored', 36, 275, 14, 250), item('OUTRO VERSE 8X', 320, 272.3, 11.5, 106)];
    expect(findSectionHeaders([page(items)]).map((h) => h.label)).toEqual(['OUTRO VERSE']);
  });

  it('two columns: a right-column header beside a left-column lyric', () => {
    const items = [item('Oh, let the sun beat down', 36, 500, 14, 170), item('CHORUS', 320, 500)];
    const [h] = findSectionHeaders([page(items)]);
    expect(h.label).toBe('CHORUS');
    expect(h.x).toBeCloseTo(320 / 600);
  });

  it('a song TITLED like a section ("Breakdown") is not a header', () => {
    const items = [
      item('Breakdown', 36, 739, 21, 95),
      item('Tom Petty · Key A', 36, 720, 11.5, 90),
      item('INTRO 8X', 36, 689, 11.5, 48),
      item('Breakdown, honey, take me through the night', 36, 670, 14, 250),
      item('VERSE 1', 36, 640, 11.5, 45),
      item('It is alright if you love me', 36, 620, 14, 200),
    ];
    expect(findSectionHeaders([page(items)]).map((h) => h.label)).toEqual(['INTRO', 'VERSE 1']);
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
