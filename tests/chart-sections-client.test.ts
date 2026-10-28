import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Track B anchors, client half: the one stale-bytes retry ─────────────────────
// A 409 means the bytes on screen were a stale cached copy. The recovery must evict BOTH
// caches before reloading (a reload that reads the Cache API again loops on the same
// stale bytes), re-read the headers from the FRESH document, post under the FRESH hash,
// and retry exactly once.

const calls: string[] = [];
const freshDoc = {
  numPages: 1,
  getPage: async () => ({
    getViewport: () => ({ transform: [1, 0, 0, -1, 0, 800], width: 600, height: 800 }),
    getTextContent: async () => ({
      items: [
        { str: 'INTRO', transform: [12, 0, 0, 12, 40, 700], width: 30, height: 12 },
        { str: 'CHORUS', transform: [12, 0, 0, 12, 40, 400], width: 36, height: 12 },
      ],
    }),
  }),
};

vi.mock('@/lib/chart-cache', () => ({ evictChartCache: async () => { calls.push('evictCache'); } }));
vi.mock('@/lib/pdf-viewer', () => ({
  evictChartDoc: () => { calls.push('evictDoc'); },
  loadPdfDoc: async (_c: unknown, _t: unknown, opts: { bypassCache?: boolean }) => {
    calls.push(`load bypass=${opts?.bypassCache}`);
    return reload ? { doc: freshDoc, sourceHash: 'b'.repeat(64) } : null;
  },
}));

let reload = true;
let statuses: number[] = [];
const posted: { source_hash: string; sections: { label: string }[] }[] = [];

beforeEach(() => {
  calls.length = 0;
  posted.length = 0;
  reload = true;
  statuses = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body));
    const status = statuses.shift() ?? 200;
    return { ok: status === 200, status, json: async () => ({ generated: true }) };
  });
});

const { markSections } = await import('@/lib/chart-sections-client');

const args = {
  chart: { name: 'x', role: 'lyrics' } as never,
  chartId: '11111111-2222-4333-8444-555555555555',
  sourceHash: 'a'.repeat(64),
  headers: [
    { page: 1, x: 0.1, y: 0.1, label: 'VERSE', count: null },
    { page: 1, x: 0.1, y: 0.5, label: 'OUT', count: { bars: 4 } },
  ],
};

describe('markSections', () => {
  it('posts positions only (no counts) under the hash of the bytes on screen', async () => {
    const out = await markSections(args);
    expect(out).toEqual({ result: { generated: true } });
    expect(posted).toEqual([
      {
        chart_id: args.chartId,
        source_hash: 'a'.repeat(64),
        sections: [
          { page: 1, x: 0.1, y: 0.1, label: 'VERSE' },
          { page: 1, x: 0.1, y: 0.5, label: 'OUT' },
        ],
      },
    ]);
    expect(calls).toEqual([]);
  });

  it('409 → evict both caches, reload network-direct, re-read, re-post under the FRESH hash', async () => {
    statuses = [409, 200];
    const out = await markSections(args);
    expect(calls).toEqual(['evictCache', 'evictDoc', 'load bypass=true']);
    expect(posted[1].source_hash).toBe('b'.repeat(64));
    expect(posted[1].sections.map((s) => s.label)).toEqual(['INTRO', 'CHORUS']);
    expect(out.result).toEqual({ generated: true });
    expect(out.reloaded?.sourceHash).toBe('b'.repeat(64));
  });

  it('a second 409 is surfaced, not retried — and the caller still gets the fresh doc', async () => {
    statuses = [409, 409];
    const out = await markSections(args);
    expect(posted).toHaveLength(2);
    expect(out.result).toBeNull();
    expect(out.reloaded?.sourceHash).toBe('b'.repeat(64));
  });

  it('a failed reload ends with null and no second post', async () => {
    statuses = [409];
    reload = false;
    const out = await markSections(args);
    expect(posted).toHaveLength(1);
    expect(out).toEqual({ result: null });
  });

  it('a non-409 failure is returned as-is, never retried', async () => {
    statuses = [500];
    expect(await markSections(args)).toEqual({ result: null });
    expect(posted).toHaveLength(1);
  });
});
