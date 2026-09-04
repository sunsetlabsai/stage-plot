import { describe, it, expect } from 'vitest';
import { chartCacheKey, evictChartCache, versionedChartUrl } from '../lib/chart-cache';
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
