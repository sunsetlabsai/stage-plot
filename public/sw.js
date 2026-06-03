// ShowRunr — Service Worker
// Chart cache (synthetic URLs) + app shell caching for offline performer use.

const APP_CACHE = 'showrunr-app-v1';
const CHART_CACHE = 'stageplot-charts-v1';

// On install: precache start_url + PDF worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) =>
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
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== APP_CACHE && k !== CHART_CACHE)
            .map((k) => caches.delete(k))
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
          } catch {
            // Skip failed URLs silently
          }
        }
      })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Chart cache — synthetic URLs for cached chart PDFs
  if (url.pathname.startsWith('/api/chart-cache/')) {
    event.respondWith(
      caches.open(CHART_CACHE).then((cache) =>
        cache.match(event.request).then(
          (cached) =>
            cached ||
            new Response('Chart not available offline', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
        )
      )
    );
    return;
  }

  // Skip API calls — never cache these
  if (url.pathname.startsWith('/api/')) return;

  // Static assets — cache-first (immutable hashed filenames + PDF worker)
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname === '/pdf.worker.min.mjs'
  ) {
    event.respondWith(
      caches.open(APP_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((res) => {
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
        .then((res) => {
          const clone = res.clone();
          caches.open(APP_CACHE).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() =>
          caches
            .open(APP_CACHE)
            .then((cache) => cache.match(event.request))
        )
    );
    return;
  }
});
