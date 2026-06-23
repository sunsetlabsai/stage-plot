import { describe, it, expect } from 'vitest';
import { chartCacheKey, versionedChartUrl } from '../lib/chart-cache';
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
