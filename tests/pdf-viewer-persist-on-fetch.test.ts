import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchChartBytes } from '../lib/pdf-viewer';
import { chartCacheKey } from '../lib/chart-cache';
import type { Chart } from '../lib/types';

// Relay chunk 8 — persist on fetch (design-relay-cloud.md §9.1).
//
// The trap this guards: before chunk 8 the ONLY writer to the persistent chart cache was
// downloadAllCharts, so a chart could render perfectly online and be absent offline. These
// tests assert the WRITE happens on the network path, and — just as importantly — that a
// failure to write never breaks the render the caller is awaiting.

const supabaseChart: Chart = {
  role: 'Guitar',
  url: 'https://x.supabase.co/storage/v1/object/public/charts/u/song/guitar.pdf',
  fileId: 'chart-1',
  mimeType: 'application/pdf',
  modifiedTime: '2026-06-22T10:00:00.000Z',
} as Chart;

const driveChart: Chart = {
  role: 'Lyrics',
  url: 'https://drive.google.com/file/d/legacy',
  fileId: 'drive-1',
  mimeType: 'application/pdf',
  modifiedTime: '2026-06-22T10:00:00.000Z',
} as Chart;

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 fake chart bytes').buffer;

const ORIGIN = 'https://app.local';

// cacheChart builds `new Request('/api/chart-cache/...')`. A browser resolves that relative
// URL against the document; undici throws without a base. This shim supplies the base so the
// product code under test runs unmodified.
class FakeRequest {
  url: string;
  constructor(input: string | { url: string }) {
    this.url = new URL(typeof input === 'string' ? input : input.url, ORIGIN).toString();
  }
}

const pathOf = (req: FakeRequest | Request | string) =>
  new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;

/** Map-backed stand-in for the Cache API — node has no `caches`. */
function installFakeCaches() {
  const store = new Map<string, Response>();
  const cache = {
    async match(req: FakeRequest | Request | string) {
      const hit = store.get(pathOf(req));
      return hit ? hit.clone() : undefined;
    },
    async put(req: FakeRequest | Request | string, res: Response) {
      store.set(pathOf(req), res);
    },
    async keys() {
      return [...store.keys()].map((u) => new FakeRequest(u));
    },
    async delete(req: FakeRequest | Request | string) {
      return store.delete(pathOf(req));
    },
  };
  (globalThis as Record<string, unknown>).caches = { open: async () => cache };
  return store;
}

let store: Map<string, Response>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = installFakeCaches();
  fetchMock = vi.fn(
    async () =>
      new Response(PDF_BYTES.slice(0), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Request', FakeRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).caches;
});

/** The write is fire-and-forget, so let its microtask chain drain before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('fetchChartBytes — persist on fetch (chunk 8)', () => {
  it('writes fetched bytes to the persistent cache on a miss', async () => {
    const bytes = await fetchChartBytes(supabaseChart);
    await settle();

    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(PDF_BYTES.byteLength);
    expect(store.has(chartCacheKey(supabaseChart)!)).toBe(true);
  });

  it('makes a second read serve from cache with NO network call — the offline win', async () => {
    await fetchChartBytes(supabaseChart);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const again = await fetchChartBytes(supabaseChart);

    expect(fetchMock).toHaveBeenCalledTimes(1); // still 1 — served from cache
    expect(again).not.toBeNull();
    expect(new Uint8Array(again!)).toEqual(new Uint8Array(PDF_BYTES.slice(0)));
  });

  it('caches the legacy Drive proxy path too, not just Supabase', async () => {
    await fetchChartBytes(driveChart, 'token-abc');
    await settle();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/drive/download');
    expect(store.has(chartCacheKey(driveChart)!)).toBe(true);
  });

  it('stamps Content-Length so getCacheStats can size the entry', async () => {
    // A Response built from an ArrayBuffer carries no Content-Length, and getCacheStats
    // (chart-cache.ts:184) sums that header. Without this the download manager would count
    // the chart but weigh it 0.
    await fetchChartBytes(supabaseChart);
    await settle();

    const cached = store.get(chartCacheKey(supabaseChart)!)!;
    expect(cached.headers.get('content-length')).toBe(String(PDF_BYTES.byteLength));
    expect(cached.headers.get('content-type')).toBe('application/pdf');
  });

  it('does NOT cache a failed fetch — a 404 body must never poison the cache', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const bytes = await fetchChartBytes(supabaseChart);
    await settle();

    expect(bytes).toBeNull();
    expect(store.size).toBe(0);
  });

  // Codex R1-2: res.ok spans all of 2xx. A 204 or 206 would have passed that check and
  // persisted an empty or truncated body, which every later read then prefers over the
  // network — a poisoned cache that looks like a successful offline chart.
  it.each([
    ['204 No Content', 204, ''],
    ['206 Partial Content', 206, '%PDF-1.7 trunc'],
  ])('does NOT cache a %s — 2xx is not good enough, only 200 is', async (_label, status, body) => {
    fetchMock.mockResolvedValueOnce(new Response(status === 204 ? null : body, { status }));

    const bytes = await fetchChartBytes(supabaseChart);
    await settle();

    expect(bytes).toBeNull();
    expect(store.size).toBe(0);
  });

  it('still returns bytes when the cache WRITE throws — the render must not depend on it', async () => {
    // Quota exceeded. Offline availability is a bonus on top of a render that already
    // succeeded; it can never be a precondition for one.
    (globalThis as Record<string, unknown>).caches = {
      open: async () => ({
        match: async () => undefined,
        put: async () => {
          throw new Error('QuotaExceededError');
        },
        keys: async () => [],
        delete: async () => false,
      }),
    };

    const bytes = await fetchChartBytes(supabaseChart);
    await settle();

    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(PDF_BYTES.byteLength);
  });

  // Codex R1-3: the READ side was unguarded — it sat outside the try, so a rejecting
  // caches.open() failed the render before the network was ever tried. The previous version
  // of this suite CLAIMED to cover "no Cache API" but only made put() throw, which exercises
  // the write path. These two hit the read path specifically.
  it('still renders when `caches` is undefined entirely (no secure context)', async () => {
    delete (globalThis as Record<string, unknown>).caches;

    const bytes = await fetchChartBytes(supabaseChart);
    await settle();

    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(PDF_BYTES.byteLength);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still renders when the cache READ rejects (private browsing)', async () => {
    (globalThis as Record<string, unknown>).caches = {
      open: async () => {
        throw new Error('SecurityError');
      },
    };

    const bytes = await fetchChartBytes(supabaseChart);
    await settle();

    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(PDF_BYTES.byteLength);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns bytes for a chart with no modifiedTime (unkeyable, so uncacheable)', async () => {
    // chartCacheKey returns null without modifiedTime, so cacheChart no-ops. That chart
    // renders online and stays absent offline — a real residual gap, asserted here so it
    // is a known shape rather than a surprise.
    const unkeyable = { ...supabaseChart, modifiedTime: undefined } as Chart;

    const bytes = await fetchChartBytes(unkeyable);
    await settle();

    expect(bytes).not.toBeNull();
    expect(store.size).toBe(0);
  });
});
