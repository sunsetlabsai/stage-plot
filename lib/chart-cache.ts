import type { Chart } from './types';

const CACHE_NAME = 'stageplot-charts-v1';
const SW_TIMEOUT = 5000;

/** Synthetic cache key for a chart file. Not a real URL — only used as Cache API key. */
export function chartCacheKey(chart: Chart): string | null {
  if (!chart.fileId || !chart.modifiedTime) return null;
  // Full-millisecond precision so same-second replaces don't collide on one key.
  const version = new Date(chart.modifiedTime).getTime();
  if (!Number.isFinite(version)) return null;
  return `/api/chart-cache/${chart.fileId}/${version}`;
}

/** Version-stamp a Supabase public chart URL so browser/CDN caches bust when the
 * underlying object is replaced (the storage path is stable + uploaded with
 * upsert). Keeps the viewer's fetched bytes in parity with the authoritative
 * object the converter hashes. Returns the url unchanged when there's no
 * modifiedTime to stamp with. */
export function versionedChartUrl(chart: Chart): string {
  const version = chart.modifiedTime ? new Date(chart.modifiedTime).getTime() : NaN;
  if (!Number.isFinite(version)) return chart.url;
  const sep = chart.url.includes('?') ? '&' : '?';
  return `${chart.url}${sep}v=${version}`;
}

/** Check if a specific chart is cached. */
export async function isChartCached(chart: Chart): Promise<boolean> {
  const key = chartCacheKey(chart);
  if (!key) return false;
  const cache = await caches.open(CACHE_NAME);
  const match = await cache.match(key);
  return !!match;
}

/** Get the cached chart bytes (as a Blob), or null if not cached. */
export async function getCachedChartBlob(chart: Chart): Promise<Blob | null> {
  const key = chartCacheKey(chart);
  if (!key) return null;
  const cache = await caches.open(CACHE_NAME);
  const match = await cache.match(key);
  if (!match) return null;
  return await match.blob();
}

/** Store a downloaded chart in the cache. */
export async function cacheChart(chart: Chart, response: Response): Promise<void> {
  const key = chartCacheKey(chart);
  if (!key) return;
  const cache = await caches.open(CACHE_NAME);

  // Evict any old version of this fileId (different modifiedTime)
  const keys = await cache.keys();
  const prefix = `/api/chart-cache/${chart.fileId}/`;
  for (const req of keys) {
    if (new URL(req.url).pathname.startsWith(prefix) && new URL(req.url).pathname !== key) {
      await cache.delete(req);
    }
  }

  await cache.put(new Request(key), response);
}

export interface DownloadProgress {
  total: number;
  done: number;
  skipped: number;
  failed: string[];  // fileIds that failed
  aborted: boolean;
}

/** Download all charts and cache them. Supports Supabase Storage (direct) and Google Drive (proxy). */
export async function downloadAllCharts(
  charts: Chart[],
  accessToken: string | null,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadProgress> {
  // Dedupe by fileId — same file shared across songs only needs one download
  const seen = new Set<string>();
  const cacheable = charts.filter((c) => {
    const key = chartCacheKey(c);
    if (!key || !c.fileId) return false;
    if (seen.has(c.fileId)) return false;
    seen.add(c.fileId);
    return true;
  });
  const progress: DownloadProgress = {
    total: cacheable.length,
    done: 0,
    skipped: 0,
    failed: [],
    aborted: false,
  };

  if (cacheable.length === 0) {
    onProgress(progress);
    return progress;
  }

  const cache = await caches.open(CACHE_NAME);

  for (const chart of cacheable) {
    if (signal?.aborted) {
      progress.aborted = true;
      onProgress(progress);
      return progress;
    }

    const key = chartCacheKey(chart)!;

    // Skip if already cached with same version
    const existing = await cache.match(key);
    if (existing) {
      progress.done++;
      progress.skipped++;
      onProgress(progress);
      continue;
    }

    try {
      let res: Response;

      if (chart.url?.includes('/storage/v1/object/public/')) {
        // Supabase Storage — public URL, no auth needed (version-stamped to bust caches)
        res = await fetch(versionedChartUrl(chart), { signal });
      } else if (accessToken) {
        // Google Drive — proxy through /api/drive/download
        res = await fetch('/api/drive/download', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fileId: chart.fileId, mimeType: chart.mimeType }),
          signal,
        });
      } else {
        // Drive chart but no token — skip
        progress.failed.push(chart.fileId!);
        progress.done++;
        onProgress(progress);
        continue;
      }

      if (!res.ok) {
        progress.failed.push(chart.fileId!);
        progress.done++;
        onProgress(progress);
        continue;
      }

      await cacheChart(chart, res);
      progress.done++;
      onProgress(progress);
    } catch {
      if (signal?.aborted) {
        progress.aborted = true;
        onProgress(progress);
        return progress;
      }
      progress.failed.push(chart.fileId!);
      progress.done++;
      onProgress(progress);
    }
  }

  return progress;
}

/** Count how many charts are currently cached. Also returns estimated total bytes. */
export async function getCacheStats(): Promise<{ count: number; bytes: number }> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let bytes = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) {
        const len = res.headers.get('content-length');
        bytes += len ? parseInt(len, 10) : 0;
      }
    }
    return { count: keys.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/** Delete all cached charts. */
export async function clearChartCache(): Promise<void> {
  await caches.delete(CACHE_NAME);
}

/** Register the service worker and warm the app cache with current page assets. */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    return;
  }

  // Wait for SW to control this page, with timeout
  await Promise.race([
    new Promise<void>((resolve) => {
      if (navigator.serviceWorker.controller) resolve();
      else navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    }),
    new Promise<void>((resolve) => setTimeout(resolve, SW_TIMEOUT)),
  ]);

  // Best-effort cache warming: current page + loaded static assets
  if (navigator.serviceWorker.controller) {
    const urls = [location.href];
    document.querySelectorAll('script[src*="/_next/static/"]').forEach(el =>
      urls.push((el as HTMLScriptElement).src)
    );
    document.querySelectorAll('link[href*="/_next/static/"]').forEach(el =>
      urls.push((el as HTMLLinkElement).href)
    );
    navigator.serviceWorker.controller.postMessage({ type: 'WARM_CACHE', urls });
  }
}

/** Format bytes as human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
