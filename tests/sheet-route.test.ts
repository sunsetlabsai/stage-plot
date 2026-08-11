import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/sheet/route';
import { sheetCsvUrl, mapHeaders } from '../lib/setlist-import';

// This exercises the REAL route handler with `fetch` stubbed, rather than
// mirroring its logic in the test file. The existing convention here
// (tests/show-creation.test.ts) re-implements route helpers in the test, which
// cannot catch drift between the copy and the original — the exact
// claim-vs-mechanism gap the design's §8 refactor exists to close.

function req(url: string) {
  return new NextRequest(
    `http://localhost/api/sheet?url=${encodeURIComponent(url)}`,
  );
}

function stubSheet(csv: string, ok = true, status = 200) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => csv,
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const SHEET = 'https://docs.google.com/spreadsheets/d/abc123/edit';

afterEach(() => vi.unstubAllGlobals());

describe('sheetCsvUrl', () => {
  it('builds the CSV export URL from a normal sheet link', () => {
    expect(sheetCsvUrl(SHEET)).toBe(
      'https://docs.google.com/spreadsheets/d/abc123/export?format=csv',
    );
  });

  it('carries the tab across from the URL fragment', () => {
    // The address bar shows #gid=NNN when you switch tabs — without this,
    // import silently reads the FIRST tab whatever the user was looking at.
    expect(sheetCsvUrl(`${SHEET}#gid=1836`)).toContain('&gid=1836');
  });

  it('carries the tab across from the query string too', () => {
    expect(sheetCsvUrl(`${SHEET}?gid=42`)).toContain('&gid=42');
  });

  it('ignores a non-numeric gid rather than forwarding garbage', () => {
    expect(sheetCsvUrl(`${SHEET}#gid=abc`)).not.toContain('gid=abc');
  });

  it('returns null for a URL that is not a Google Sheet', () => {
    expect(sheetCsvUrl('https://example.com/foo')).toBeNull();
  });
});

describe('GET /api/sheet', () => {
  it('400s with no ?url=', async () => {
    const res = await GET(new NextRequest('http://localhost/api/sheet'));
    expect(res.status).toBe(400);
  });

  it('400s on a non-Sheets URL', async () => {
    const res = await GET(req('https://example.com/nope'));
    expect(res.status).toBe(400);
  });

  it('fetches the gid-specific tab', async () => {
    const spy = stubSheet('Title\nA\n');
    await GET(req(`${SHEET}#gid=99`));
    expect(spy.mock.calls[0][0]).toContain('&gid=99');
  });

  it('502s when Google returns an error', async () => {
    stubSheet('', false, 503);
    const res = await GET(req(SHEET));
    expect(res.status).toBe(502);
  });

  it('422s when the sheet has no data rows', async () => {
    stubSheet('Title\n');
    const res = await GET(req(SHEET));
    expect(res.status).toBe(422);
  });

  it('422s when no title column can be resolved', async () => {
    stubSheet('Lead,Notes\nRachel,x\n');
    const res = await GET(req(SHEET));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/title/i);
  });

  it('returns rows with the new key and sceneNote columns', async () => {
    stubSheet('Title,Key,Lead,Scene Note\nOphelia,Bb,Rachel,save scene\n');
    const res = await GET(req(SHEET));
    const body = await res.json();
    expect(body.songs).toEqual([
      { title: 'Ophelia', key: 'Bb', lead: 'Rachel', sceneNote: 'save scene' },
    ]);
  });

  it('orders rows by the # column, not physical order', async () => {
    stubSheet('#,Title\n2,B\n1,A\n');
    const body = await (await GET(req(SHEET))).json();
    expect(body.songs.map((s: { title: string }) => s.title)).toEqual(['A', 'B']);
  });

  it('reports recognized-but-ignored columns so the preview can say so', async () => {
    stubSheet('Title,BPM,Artist\nA,120,The Band\n');
    const body = await (await GET(req(SHEET))).json();
    expect(body.ignored).toEqual({ bpm: true, artist: true });
    // Recognized, but never returned as an importable field.
    expect(body.songs[0].bpm).toBeUndefined();
  });

  it('502s on a network throw rather than escaping', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const res = await GET(req(SHEET));
    expect(res.status).toBe(502);
  });
});

describe('mapHeaders — the last-resort title pass (chunk 2)', () => {
  it('still binds a "Songs" column, as the live route does today', () => {
    // Regression guard. §5 makes `song` an exact alias to stop "Song Key"
    // stealing title; taken literally that also breaks a sheet whose only
    // title header is "Songs", which imports fine today via includes('song').
    expect(mapHeaders(['Songs', 'Lead']).title).toBe(0);
  });

  it('binds "Songwriter" as title only when nothing better exists', () => {
    expect(mapHeaders(['Songwriter']).title).toBe(0);
    // ...and never when a real title column is present.
    expect(mapHeaders(['Songwriter', 'Title']).title).toBe(1);
  });

  it('does NOT fall back to a column already bound to key', () => {
    // "Song Key" is consumed by `key` in pass 1, so it is ineligible here and
    // the sheet correctly errors instead of importing keys as song titles.
    expect(() => mapHeaders(['Song Key', 'Lead'])).toThrow();
  });
});
