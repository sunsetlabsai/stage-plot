import { describe, expect, it } from 'vitest';
import {
  decideShareTier,
  chartShareFilename,
  buildChartShareUrl,
  buildShowShareUrl,
  parseChartDeepLink,
} from '../lib/share';
import type { SetlistSong } from '../lib/types';

// ── Chart-PDF share: the pure tier/filename/URL/parse layer ──────────────────

describe('decideShareTier', () => {
  it('file share wins when the device can share files', () => {
    expect(decideShareTier({ canShareFile: true, canShareUrl: true })).toBe('file');
  });

  it('falls to url share when files are out but share exists', () => {
    expect(decideShareTier({ canShareFile: false, canShareUrl: true })).toBe('url');
  });

  it('falls to clipboard when there is no Web Share at all', () => {
    expect(decideShareTier({ canShareFile: false, canShareUrl: false })).toBe('clipboard');
  });
});

describe('chartShareFilename', () => {
  it('builds "{Song Title} – {Role}.pdf"', () => {
    expect(chartShareFilename('Valerie', 'Guitar')).toBe('Valerie – Guitar.pdf');
  });

  it('scrubs filesystem-hostile characters from both parts', () => {
    expect(chartShareFilename('A/B: "Live?"', 'Key<s>|Synth')).toBe('A-B- -Live-- – Key-s--Synth.pdf');
  });

  it('never emits an empty part', () => {
    expect(chartShareFilename('', '')).toBe('Chart – Chart.pdf');
  });
});

describe('share URLs', () => {
  it('show URL is the bare show page, path-encoded', () => {
    expect(buildShowShareUrl('https://x.test', 'the band', 'fall-tour')).toBe(
      'https://x.test/the%20band/fall-tour'
    );
  });

  it('chart URL carries song position + songId + role, query-encoded', () => {
    expect(
      buildChartShareUrl('https://x.test', 'band', 'show', { position: 3, songId: 'song-a' }, 'Lead Vox'),
    ).toBe('https://x.test/band/show?song=3&sid=song-a&chart=Lead%20Vox');
  });

  it('an inline song with no songId gets a position-only link, as before', () => {
    expect(buildChartShareUrl('https://x.test', 'band', 'show', { position: 3 }, 'Lead Vox')).toBe(
      'https://x.test/band/show?song=3&chart=Lead%20Vox'
    );
  });
});

describe('parseChartDeepLink', () => {
  const setlist = [
    { position: 1, title: 'One', lead: '' },
    { position: 2, title: 'Two', lead: '' },
    { position: 7, title: 'Seven', lead: '' },
  ] as SetlistSong[];

  it('a link with no sid (older links, inline songs) matches by POSITION, not array index', () => {
    expect(parseChartDeepLink('?song=7&chart=Guitar', setlist)).toEqual({ kind: 'song', songIdx: 2, role: 'Guitar' });
  });

  it('role is optional — song-only links open the viewer on the default chart', () => {
    expect(parseChartDeepLink('?song=2', setlist)).toEqual({ kind: 'song', songIdx: 1, role: null });
  });

  it('round-trips buildChartShareUrl encoding (roles with spaces)', () => {
    const url = new URL(buildChartShareUrl('https://x.test', 'b', 's', { position: 2 }, 'Lead Vox'));
    expect(parseChartDeepLink(url.search, setlist)).toEqual({ kind: 'song', songIdx: 1, role: 'Lead Vox' });
  });

  it('ignores absent, non-numeric, or unmatched song params', () => {
    expect(parseChartDeepLink('', setlist)).toBeNull();
    expect(parseChartDeepLink('?chart=Guitar', setlist)).toBeNull();
    expect(parseChartDeepLink('?song=abc', setlist)).toBeNull();
    expect(parseChartDeepLink('?song=-1', setlist)).toBeNull();
    expect(parseChartDeepLink('?song=99', setlist)).toBeNull();
  });

  it('does not trip on an unrelated ?join link', () => {
    expect(parseChartDeepLink('?join=AB7XKQ', setlist)).toBeNull();
  });
});

// ★ UAT S6 — the reorder bug. Before: a link carried only the position, so after
// the owner moved songs it opened whatever now sat in that slot.
describe('parseChartDeepLink — matched by songId (S6)', () => {
  const sent = [
    { position: 1, songId: 'a', title: 'Alpha', lead: '' },
    { position: 2, songId: 'b', title: 'Bravo', lead: '' },
    { position: 3, songId: 'c', title: 'Charlie', lead: '' },
  ] as SetlistSong[];
  const link = new URL(buildChartShareUrl('https://x.test', 'o', 's', sent[1], 'Bass')).search;

  it('after a reorder, the link still opens the song the sender shared', () => {
    const reordered = [
      { ...sent[1], position: 1 },
      { ...sent[2], position: 2 },
      { ...sent[0], position: 3 },
    ];
    // Position 2 is now Charlie — the old parser opened it. Bravo is at index 0.
    expect(parseChartDeepLink(link, reordered)).toEqual({ kind: 'song', songIdx: 0, role: 'Bass' });
  });

  it('a song removed from the setlist is GONE — not whatever took its position', () => {
    const removed = [sent[0], { ...sent[2], position: 2 }];
    expect(parseChartDeepLink(link, removed)).toEqual({ kind: 'gone' });
  });

  it('the same song twice (a reprise): the copy at the linked position wins', () => {
    const reprise = [...sent, { position: 4, songId: 'b', title: 'Bravo (reprise)', lead: '' }] as SetlistSong[];
    const toReprise = new URL(buildChartShareUrl('https://x.test', 'o', 's', reprise[3], 'Bass')).search;
    expect(parseChartDeepLink(toReprise, reprise)).toEqual({ kind: 'song', songIdx: 3, role: 'Bass' });
    expect(parseChartDeepLink(link, reprise)).toEqual({ kind: 'song', songIdx: 1, role: 'Bass' });
  });

  it('a reprise whose linked position moved falls back to the FIRST copy', () => {
    const reprise = [
      { position: 1, songId: 'b', title: 'Bravo', lead: '' },
      { position: 2, songId: 'c', title: 'Charlie', lead: '' },
      { position: 3, songId: 'b', title: 'Bravo (reprise)', lead: '' },
    ] as SetlistSong[];
    // Link says position 2 + Bravo; position 2 is Charlie, so take the first Bravo.
    expect(parseChartDeepLink(link, reprise)).toEqual({ kind: 'song', songIdx: 0, role: 'Bass' });
  });
});
