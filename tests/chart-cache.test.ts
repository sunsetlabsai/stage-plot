import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cacheChart, chartCacheKey, evictChartCache, versionedChartUrl } from '../lib/chart-cache';
import type { Chart } from '../lib/types';

const base: Chart = {
  // minimal fields the cache helpers read
  url: 'https://x.supabase.co/storage/v1/object/public/charts/u/song/role.pdf',
  fileId: 'chart-1',
  modifiedTime: '2026-06-22T10:00:00.000Z',
} as Chart;

describe('chartCacheKey', () => {
  it('keys on fileId + full-millisecond version', () => {
    const ms = new Date(base.modifiedTime!).getTime();
    expect(chartCacheKey(base)).toBe(`/api/chart-cache/${base.fileId}/${ms}`);
  });

  it('distinguishes same-second replaces (ms precision, no flooring)', () => {
    const a = chartCacheKey({ ...base, modifiedTime: '2026-06-22T10:00:00.100Z' });
    const b = chartCacheKey({ ...base, modifiedTime: '2026-06-22T10:00:00.900Z' });
    expect(a).not.toBe(b);
  });

  it('returns null without fileId or modifiedTime, or on unparseable time', () => {
    expect(chartCacheKey({ ...base, fileId: undefined })).toBeNull();
    expect(chartCacheKey({ ...base, modifiedTime: undefined })).toBeNull();
    expect(chartCacheKey({ ...base, modifiedTime: 'not-a-date' })).toBeNull();
  });
});

describe('versionedChartUrl', () => {
  it('appends a ?v=<ms> token to bust caches on object replace', () => {
    const ms = new Date(base.modifiedTime!).getTime();
    expect(versionedChartUrl(base)).toBe(`${base.url}?v=${ms}`);
  });

  it('uses & when the url already has a query string', () => {
    const withQuery = { ...base, url: `${base.url}?token=abc` };
    const ms = new Date(base.modifiedTime!).getTime();
    expect(versionedChartUrl(withQuery)).toBe(`${withQuery.url}&v=${ms}`);
  });

  it('returns the url unchanged when there is no parseable modifiedTime', () => {
    expect(versionedChartUrl({ ...base, modifiedTime: undefined })).toBe(base.url);
    expect(versionedChartUrl({ ...base, modifiedTime: 'not-a-date' })).toBe(base.url);
  });
});

// ── Hash-mismatch eviction (B2b) ─────────────────────────────────────────────
//
// The Cache API half of the two-helper recovery. The other half lives in
// lib/pdf-viewer.ts and is asserted in pdf-viewer-evict.test.ts — eviction here alone
// is NOT sufficient, because loadPdfDoc memoizes the parsed doc AND its stale hash.

describe('evictChartCache', () => {
  /** Minimal Cache API stand-in: enough surface for keys()/delete()/open(). */
  function installCaches(paths: string[]) {
    const entries = new Set(paths.map((p) => `https://app.test${p}`));
    const cache = {
      keys: async () => [...entries].map((url) => ({ url })),
      delete: async (req: { url: string }) => entries.delete(req.url),
    };
    (globalThis as { caches?: unknown }).caches = { open: async () => cache };
    return entries;
  }

  it('drops EVERY cached version of the chart, not just the current key', async () => {
    const entries = installCaches([
      '/api/chart-cache/chart-1/1000',
      '/api/chart-cache/chart-1/2000',
      '/api/chart-cache/chart-2/1000',
    ]);
    await evictChartCache(base);
    expect([...entries]).toEqual(['https://app.test/api/chart-cache/chart-2/1000']);
  });

  it('never throws when there is no Cache API to evict from', async () => {
    (globalThis as { caches?: unknown }).caches = undefined;
    await expect(evictChartCache(base)).resolves.toBeUndefined();
  });
});

// ── Cross-version race (uat-plan-v1 §2.4) ────────────────────────────────────
//
// Two downloads of one chart in flight — the old version still arriving when a replace
// lands. Each `cacheChart` evicted every OTHER version of the fileId, so the slower OLD
// one deleted the NEW copy and stored itself: offline, the replaced chart was gone.

describe('cacheChart across versions', () => {
  /** Cache stand-in whose put() can be held, so the interleaving is deterministic. */
  function installCaches() {
    const entries = new Map<string, string>();
    const holds: Array<() => void> = [];
    let holdPuts = false;
    const cache = {
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      delete: async (req: { url: string }) => entries.delete(req.url),
      put: async (req: { url: string }, res: { body: string }) => {
        if (holdPuts) await new Promise<void>((r) => holds.push(r));
        entries.set(req.url, res.body);
      },
    };
    (globalThis as { caches?: unknown }).caches = { open: async () => cache };
    return {
      entries,
      hold: () => { holdPuts = true; },
      releaseAll: () => { holdPuts = false; holds.splice(0).forEach((r) => r()); },
    };
  }
  const ORIGIN = 'https://app.test';
  const v = (t: string) => ({ ...base, modifiedTime: t }) as Chart;
  const OLD = v('2026-06-22T10:00:00.000Z');
  const NEW = v('2026-06-22T11:00:00.000Z');
  const res = (body: string) => ({ body }) as unknown as Response;
  // Node's Request rejects a relative URL; a browser resolves it against the page origin.
  const NativeRequest = globalThis.Request;
  beforeEach(() => {
    globalThis.Request = class { url: string; constructor(u: string) { this.url = new URL(u, ORIGIN).href; } } as unknown as typeof Request;
  });
  afterEach(() => { globalThis.Request = NativeRequest; });
  const pathOf = (u: string) => (u.startsWith('http') ? new URL(u).pathname : u);
  const paths = (m: Map<string, string>) => [...m.keys()].map(pathOf);

  it('★ an OLD version that lands after the NEW one never evicts it', async () => {
    const c = installCaches();
    await cacheChart(NEW, res('new'));
    await cacheChart(OLD, res('old'));
    expect(paths(c.entries)).toEqual([chartCacheKey(NEW)]);
    expect([...c.entries.values()]).toEqual(['new']);
  });

  it('★ two writes in flight together still leave only the newest', async () => {
    const c = installCaches();
    c.hold();
    const a = cacheChart(OLD, res('old'));
    const b = cacheChart(NEW, res('new'));
    await new Promise((r) => setTimeout(r, 0));
    c.releaseAll();
    await Promise.all([a, b]);
    expect(paths(c.entries)).toEqual([chartCacheKey(NEW)]);
  });

  it('a NEWER version still replaces an older one', async () => {
    const c = installCaches();
    await cacheChart(OLD, res('old'));
    await cacheChart(NEW, res('new'));
    expect(paths(c.entries)).toEqual([chartCacheKey(NEW)]);
  });

  it('other charts are untouched', async () => {
    const c = installCaches();
    await cacheChart({ ...NEW, fileId: 'chart-2' } as Chart, res('other'));
    await cacheChart(NEW, res('new'));
    expect(paths(c.entries).sort()).toEqual([chartCacheKey({ ...NEW, fileId: 'chart-2' } as Chart), chartCacheKey(NEW)].sort());
  });
});
