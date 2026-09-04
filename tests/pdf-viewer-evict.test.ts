import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Chart } from '../lib/types';

// ── B2b: the in-memory half of the hash-mismatch recovery ────────────────────
//
// docs/design-chart-measurement.md §Cache eviction — two helpers, not one.
//
// The claim under test is the one that makes the second helper necessary at all:
// evicting the Cache API alone is NOT sufficient, because `loadPdfDoc` memoizes the
// parsed document AND the hash of the bytes it was parsed from, keyed by
// fileId:modifiedTime — so the next load would hand back the same stale document and the
// same stale hash, and the client would re-submit the very hash the server just rejected.

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1, destroy() {} }) }),
}));

const { loadPdfDoc, evictChartDoc, fetchChartBytes } = await import('../lib/pdf-viewer');

const chart: Chart = {
  role: 'Guitar',
  url: 'https://x.supabase.co/storage/v1/object/public/charts/u/song/guitar.pdf',
  fileId: 'chart-1',
  mimeType: 'application/pdf',
  modifiedTime: '2026-06-22T10:00:00.000Z',
} as Chart;

let bytes: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bytes = '%PDF-1.7 first bytes';
  fetchMock = vi.fn(
    async () =>
      new Response(new TextEncoder().encode(bytes), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  // No Cache API in node: every read below therefore goes to the network unless the
  // in-memory doc map answers first, which is exactly the thing being measured.
  delete (globalThis as Record<string, unknown>).caches;
  evictChartDoc(chart);
});

afterEach(() => {
  vi.unstubAllGlobals();
  evictChartDoc(chart);
});

describe('evictChartDoc', () => {
  it('the document map DOES memoize — the second load makes no network call', async () => {
    // The positive control. Without this, the assertion below would pass even if the
    // cache had never worked in the first place.
    const first = await loadPdfDoc(chart);
    const second = await loadPdfDoc(chart);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second!.doc).toBe(first!.doc);
    expect(second!.sourceHash).toBe(first!.sourceHash);
  });

  it('★ after eviction the next load re-fetches — and picks up a NEW hash', async () => {
    const stale = await loadPdfDoc(chart);
    evictChartDoc(chart);
    bytes = '%PDF-1.7 the storage object changed under us';

    const fresh = await loadPdfDoc(chart);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh!.sourceHash).not.toBe(stale!.sourceHash);
  });

  it('does not destroy the evicted document — the open viewer is still rendering it', async () => {
    const loaded = await loadPdfDoc(chart);
    const destroy = vi.spyOn(loaded!.doc, 'destroy');
    evictChartDoc(chart);
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('fetchChartBytes bypassCache', () => {
  it('★ ignores a cache HIT and goes to the network', async () => {
    // fetchChartBytes reads the Cache API before it considers any URL, so a
    // version-stamped URL alone can never escape a stale entry — the fetch would never
    // reach it. This flag is what makes the retry actually re-read storage.
    const cached = new Response(new TextEncoder().encode('%PDF-1.7 STALE cached copy'));
    (globalThis as Record<string, unknown>).caches = {
      open: async () => ({ match: async () => cached.clone() }),
    };

    const viaCache = await fetchChartBytes(chart);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(viaCache!)).toContain('STALE');

    const viaNetwork = await fetchChartBytes(chart, undefined, { bypassCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(viaNetwork!)).toBe(bytes);

    delete (globalThis as Record<string, unknown>).caches;
  });
});
