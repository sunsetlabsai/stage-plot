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

  it('chart URL carries song position + role, query-encoded', () => {
    expect(buildChartShareUrl('https://x.test', 'band', 'show', 3, 'Lead Vox')).toBe(
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

  it('matches song by POSITION (the number the sender saw), not array index', () => {
    expect(parseChartDeepLink('?song=7&chart=Guitar', setlist)).toEqual({ songIdx: 2, role: 'Guitar' });
  });

  it('role is optional — song-only links open the viewer on the default chart', () => {
    expect(parseChartDeepLink('?song=2', setlist)).toEqual({ songIdx: 1, role: null });
  });

  it('round-trips buildChartShareUrl encoding (roles with spaces)', () => {
    const url = new URL(buildChartShareUrl('https://x.test', 'b', 's', 2, 'Lead Vox'));
    expect(parseChartDeepLink(url.search, setlist)).toEqual({ songIdx: 1, role: 'Lead Vox' });
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
