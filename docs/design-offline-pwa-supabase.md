# Design: Offline PWA — Supabase Storage Migration

**Status:** v1.5 — build-ready
**Date:** 2025-06-03
**Depends on:** Supabase backend (migration 003), chart library (PR #46+)
**Supersedes:** `design-offline-chart-cache.md` (Google Drive era — still valid for Drive charts)

---

## Context

The offline chart cache (PR #10, `lib/chart-cache.ts`) was built for Google Drive. Charts now live in Supabase Storage (`chart_library` table, `charts` bucket, public read URLs). The download path is hardcoded to the Drive proxy and needs to support Supabase Storage URLs.

The service worker only caches chart files. For offline performer use, the app shell (HTML/JS/CSS) must also be cached.

---

## Offline Model

**Best-effort.** After a successful show load, background caching begins: SW registration, app shell warming, chart downloads. The page renders immediately. A "Charts cached" indicator shows chart download progress/completion — the main signal a performer cares about before going offline. No guarantee that every resource is cached; whatever has cached works, whatever hasn't shows appropriate errors.

The indicator is advisory, not a contract. Users should confirm offline readiness before leaving a connected state (e.g., open the Perform tab, tap a chart, verify it loads).

---

## Scope

1. **Supabase chart download path** — `downloadAllCharts()` direct-fetches public Supabase URLs. Auto-caches on show load for all viewers. Drive path kept for backwards compat.
2. **App shell caching** — SW caches HTML, JS/CSS, PDF worker for offline page load.
3. **Config cache for all viewers** — localStorage config written on load for all viewers, with offline fallback on network/5xx errors.

---

## Change 1: Supabase Storage Download Path

### Current behavior
`lib/chart-cache.ts:108-116`: All downloads go through `POST /api/drive/download` with a Google OAuth access token.

### Proposed change

**A. Dual-path download in `downloadAllCharts()`:**

```typescript
let res: Response;
if (chart.url?.includes('/storage/v1/object/public/')) {
  // Supabase Storage — public URL, no auth needed
  res = await fetch(chart.url, { signal });
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
```

**B. `accessToken` becomes `string | null`.** Drive charts without a token are skipped.

**C. Auto-cache Supabase charts on show load (all viewers):**

After `setConfig(cfg)` in `loadShow()`, fire-and-forget:

```typescript
const supabaseCharts = (cfg.setlist ?? [])
  .flatMap(s => s.charts ?? [])
  .filter(c => c.url?.includes('/storage/v1/object/public/') && chartCacheKey(c));

if (supabaseCharts.length > 0) {
  registerServiceWorker().then(() => {
    downloadAllCharts(supabaseCharts, null, (p) => {
      setChartCacheProgress(p);
    }).catch(() => {});
  });
}
```

`chartCacheProgress` is a new state. The Perform tab shows it:

```tsx
{chartCacheProgress && chartCacheProgress.done < chartCacheProgress.total && (
  <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
    Caching charts {chartCacheProgress.done}/{chartCacheProgress.total}...
  </span>
)}
{chartCacheProgress && chartCacheProgress.done === chartCacheProgress.total && chartCacheProgress.failed.length === 0 && (
  <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">
    Charts cached
  </span>
)}
```

This is the practical signal: "your charts are downloaded, you can go offline." It doesn't promise the app shell or PDF.js chunks are cached — those are best-effort via the SW. But charts are what performers actually care about.

**D. Config tab download gate:**

```typescript
const cacheableCharts = charts.filter(c => !!chartCacheKey(c));
const canDownload = cacheableCharts.length > 0;
```

Remove `if (!googleToken) return` from `handleDownload`. Pass `googleToken?.access_token ?? null`.

### Files changed
- `lib/chart-cache.ts` — dual-path fetch, nullable `accessToken`
- `app/[owner]/[show]/page.tsx` — auto-cache after load, progress state, Perform tab indicator, Config tab gate

---

## Change 2: App Shell Caching

### Service worker

Expand `public/sw.js`:

```javascript
const APP_CACHE = 'showrunr-app-v1';
const CHART_CACHE = 'stageplot-charts-v1';

// On install: precache start_url + PDF worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then(cache =>
      cache.addAll(['/', '/pdf.worker.min.mjs'])
    )
  );
  self.skipWaiting();
});

// On activate: claim clients + clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(k => k !== APP_CACHE && k !== CHART_CACHE)
            .map(k => caches.delete(k))
        )
      ),
    ])
  );
});

// On message: cache warming from client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'WARM_CACHE' && Array.isArray(event.data.urls)) {
    event.waitUntil(
      caches.open(APP_CACHE).then(async (cache) => {
        for (const url of event.data.urls) {
          try {
            if (!(await cache.match(url))) {
              const res = await fetch(url);
              if (res.ok) await cache.put(url, res);
            }
          } catch { /* skip */ }
        }
      })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Chart cache — existing logic
  if (url.pathname.startsWith('/api/chart-cache/')) {
    event.respondWith(
      caches.open(CHART_CACHE).then(cache =>
        cache.match(event.request).then(cached =>
          cached || new Response('Chart not available offline', {
            status: 503, headers: { 'Content-Type': 'text/plain' }
          })
        )
      )
    );
    return;
  }

  // Skip API calls
  if (url.pathname.startsWith('/api/')) return;

  // Static assets — cache-first (immutable hashed filenames + PDF worker)
  if (url.pathname.startsWith('/_next/static/') || url.pathname === '/pdf.worker.min.mjs') {
    event.respondWith(
      caches.open(APP_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(res => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // HTML pages — network-first, cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(APP_CACHE).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.open(APP_CACHE).then(cache => cache.match(event.request)))
    );
    return;
  }
});
```

### Registration + cache warming

```typescript
// In lib/chart-cache.ts:

const SW_TIMEOUT = 5000;

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
```

Registration is fire-and-forget from `loadShow()`. Cache warming is best-effort — no ack, no readiness gate. The SW's ongoing `fetch` handler will cache additional resources as the user interacts (navigating tabs, opening charts, etc.). On subsequent visits, the SW is already active and caches everything from the start.

---

## Change 3: Config Cache for All Viewers

### Current behavior
`showrunr-cache-{showId}` is only written by `saveConfig()`, which skips read-only/anonymous viewers.

### Proposed change

Write config to localStorage for all viewers after successful load:

```typescript
// After setConfig(cfg), wrap in try/catch:
try {
  if (data.show_id) {
    localStorage.setItem(`showrunr-cache-${data.show_id}`, JSON.stringify(cfg));
    const showIds = JSON.parse(localStorage.getItem('showrunr-show-ids') || '{}');
    showIds[`${owner}/${slug}`] = data.show_id;
    localStorage.setItem('showrunr-show-ids', JSON.stringify(showIds));
  }
} catch {
  // Non-fatal — offline fallback won't be available
}
```

### Offline fallback

On network errors or 5xx, fall back to cached config. Client errors (400-499) are hard failures.

```typescript
function tryOfflineFallback(owner: string, slug: string): boolean {
  try {
    const showIds = JSON.parse(localStorage.getItem('showrunr-show-ids') || '{}');
    const showId = showIds[`${owner}/${slug}`];
    if (!showId) return false;
    const cached = localStorage.getItem(`showrunr-cache-${showId}`);
    if (!cached) return false;
    setConfig(withStableIds(JSON.parse(cached)));
    setLoadedPath(`/${owner}/${slug}`);
    return true;
  } catch {
    return false;
  }
}
```

Used in `loadShow()`: called in the `catch` block (network error) and when `res.status >= 500`.

---

## Files Changed

| File | Change |
|------|--------|
| `lib/chart-cache.ts` | Dual-path download, nullable `accessToken`, `registerServiceWorker()` with warming |
| `public/sw.js` | Install precache, activate claim, `WARM_CACHE` handler, static + navigation strategies |
| `app/[owner]/[show]/page.tsx` | `chartCacheProgress` state + Perform tab indicator, auto-cache on load, config cache for all viewers, `showrunr-show-ids`, offline fallback, Config tab download gate |

---

## Test Plan

### Chart download
- [ ] Load show as anonymous performer — verify Supabase charts auto-cached
- [ ] Verify "Caching charts X/Y" progress on Perform tab
- [ ] Verify "Charts cached" indicator when complete
- [ ] Open chart navigator offline — verify chart renders from cache
- [ ] Drive charts with token — verify Drive proxy path works
- [ ] Drive charts without token — verify skipped, not fatal
- [ ] Config tab download button — verify gated on cacheable charts, not Drive

### App shell offline
- [ ] Load show with Wi-Fi, go offline, reload — verify page renders
- [ ] Go back online — verify fresh data loads (network-first)

### Config cache + fallback
- [ ] Anonymous shared link — verify config written to localStorage
- [ ] Go offline — verify show loads from fallback
- [ ] localStorage quota exceeded — verify online load still works
- [ ] True 404 — no fallback
- [ ] 500 — fallback if cached
- [ ] Network error — fallback if cached
- [ ] First visit offline (no cache) — "network error" with retry

---

## Out of Scope

- Guaranteed offline readiness indicator (best-effort only)
- Offline editing
- Background sync
- TWA / app store wrapper
- Push notifications
