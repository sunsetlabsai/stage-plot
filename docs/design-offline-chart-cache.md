# Design: Offline Chart Cache

**Status:** v1.1. Build state tracked in `docs/INDEX.md`, not here. The cache design here is LIVE and
primary; only its Drive transport and its manual CTA are legacy.
**Depends on:** Batch Chart Resolution & Navigator (PR #2 design)
**Scope:** Download chart files for offline access at the gig

---

## Problem

Chart links point to Google Drive. No internet = no charts. This matters for:
- iPads at side-stage with no Wi-Fi
- Venues with spotty cell coverage
- Outdoor gigs (festivals, Bohemian Club grove stages)
- General Murphy's Law at showtime

The batch resolution design (PR #2) solves the *link* problem — links are in localStorage. But the *files* still live in Google Drive.

---

## Design

### Core Concept

At setup time (with connectivity), download the actual chart files and cache them in the browser. At showtime, the navigator opens cached files instead of Drive URLs.

### Storage: Cache API

**Why Cache API over IndexedDB:**
- Cache API is designed for request/response pairs — exactly what we need (URL → file)
- Works with Service Workers for true offline support
- No serialization overhead — stores binary blobs natively
- Simpler API than IndexedDB for this use case

**Storage budget:** Browsers typically allow 50-100MB+ per origin. A chart library of 30 songs x 5 roles = 150 files, mostly 1-2 page PDFs at ~100KB each = ~15MB. Well within limits.

### Download Flow

```
User clicks "Download Charts for Offline" in Setup tab
  │
  ├─ For each song with resolved charts:
  │    For each chart:
  │      1. Check cache: cache.match(cacheKey) — skip if already cached
  │      2. Fetch via proxy: POST /api/drive/download { fileId, mimeType }
  │         (proxy handles Drive auth + Google Docs→PDF export)
  │      3. Store response in Cache API: cache.put(cacheKey, response)
  │
  ├─ Progress bar: "Downloading 42/87 charts..."
  │
  └─ Done: "87 charts cached (14.2 MB) — available offline"
```

### New API Route

#### `POST /api/drive/download`

Proxies a Drive file download. Needed because Drive API requires the access token, and we don't want to expose it to the Service Worker.

```ts
// Request
{
  fileId: string;
  mimeType?: string;  // for Google Docs → PDF export
}

// Response: the raw file bytes with appropriate Content-Type
```

**Google Docs handling:** Native Google Docs/Sheets/Slides can't be downloaded as-is. The endpoint detects Google MIME types and uses the export endpoint instead:
- `application/vnd.google-apps.document` → export as PDF
- `application/vnd.google-apps.spreadsheet` → export as PDF
- `application/vnd.google-apps.presentation` → export as PDF
- Everything else (PDFs, images, etc.) → direct download

**Export size limits:** Google Drive's export API has a 10MB limit for Workspace files. If export fails (403 or 413):
1. Return a structured error: `{ error: "export_too_large", fileId, fileName }`
2. The download manager marks that chart as "not cacheable" and continues with the rest
3. UI shows a summary after download: "85/87 cached. 2 files too large for offline — these will require internet"
4. The navigator shows these charts with a small "online only" indicator

### Cache Key Strategy

Cache API requires HTTP/HTTPS URLs as keys. We use a synthetic path under the app's own origin:

```
/api/chart-cache/{fileId}/{modifiedTime}
```

Example: `https://stage-plot-five.vercel.app/api/chart-cache/1a2b3c4d5e/1716234567`

- `fileId` identifies the Drive file
- `modifiedTime` (epoch seconds from `file.modifiedTime`) ensures cache busts when the file is edited in-place (same fileId, new revision)
- This URL doesn't need to resolve as a real route — it's only used as a Cache API key

### Service Worker

Minimal service worker that intercepts chart-cache requests:

```
public/sw.js

on fetch:
  if request.url matches /api/chart-cache/*
    → serve from Cache API (named cache: "stageplot-charts-v1")
    → if cache miss: Response("Chart not available offline", { status: 503 })
    (NO network fallback — synthetic URLs don't resolve to a real route)
  else
    → pass through to network (all other requests unaffected)
```

**App-level routing (navigator component):**
- Online + cached → open from cache (fast, avoids Drive round-trip)
- Online + not cached → open Drive URL directly (normal link)
- Offline + cached → open from cache
- Offline + not cached → show "Chart not available offline" message

The SW only handles cache hits/misses for synthetic keys. The app decides whether to use the synthetic cache URL or the real Drive URL based on online status and cache availability.

Registered on first "Download Charts" action. No service worker installed until the user opts in — keeps the app simple for users who don't need offline.

---

## UI Changes

### Setup Tab

New section below "Charts / Lead Sheets" (or within it):

```
┌──────────────────────────────────────┐
│  Offline Access                      │
│                                      │
│  Cache charts for offline use at     │
│  the gig. Requires active internet   │
│  connection to download.             │
│                                      │
│  [Download Charts for Offline]       │
│                                      │
│  Status: 87 charts cached (14.2 MB)  │
│  Last synced: May 20, 2026 3:42 PM   │
│                                      │
│  [Clear Cache]                       │
└──────────────────────────────────────┘
```

**Progress state:**
```
  Downloading charts...
  ████████████░░░░░░░░ 42/87
  [Cancel]
```

### Show Tab — Navigator Changes

The navigator overlay (from PR #2 design) gets a small enhancement:

- **Online:** chart link opens from cache (instant) or falls back to Drive URL
- **Offline:** chart opens from cache. If not cached, shows "Chart not available offline" with the role/filename so they know what's missing
- **Offline indicator:** small badge in navigator header: "Offline — using cached charts"

### Cache Management

| Action | Behavior |
|---|---|
| Download Charts | Downloads all resolved charts. Skips files where `cache.match(cacheKey)` hits (same fileId + modifiedTime). |
| Refresh Charts (from PR #2) | Re-resolves links. Updated `modifiedTime` values produce new cache keys — stale entries no longer match. |
| Download after Refresh | Only downloads files with changed/new cache keys. Evicts old entries for updated files. |
| Clear Cache | Removes all cached chart files. Frees storage. |
| Song removed from setlist | Cached file remains (harmless). Cleared on next "Clear Cache". |

---

## Data Model Changes

Extend the `Chart` interface:

```ts
interface Chart {
  role: string;
  url: string;           // Google Drive URL (existing)
  label?: string;
  dupeCount?: number;
  fileId?: string;        // Drive file ID (for download + cache key)
  modifiedTime?: string;  // ISO timestamp from Drive (for cache invalidation)
  mimeType?: string;      // original MIME type (for export detection)
}
```

**Cache invalidation:** Most chart edits are in-place revisions under the same `fileId`. Using `modifiedTime` in the cache key means any edit in Drive produces a new key, so "Download Charts" will re-fetch the updated file. The old cached version is evicted during download (delete old key, store new).

The `cached` boolean is **not stored on Chart**. Cache status is derived at runtime by checking `cache.match()` against the current key. This avoids stale flags when the browser evicts entries under storage pressure.

New fields (`fileId`, `modifiedTime`, `mimeType`) populated during batch resolution.

The batch endpoint (PR #2) needs to return `fileId`, `modifiedTime`, and `mimeType` in addition to the current fields.

---

## Offline Detection

```ts
// Simple: navigator.onLine + online/offline events
window.addEventListener('offline', () => setIsOffline(true));
window.addEventListener('online', () => setIsOffline(false));
```

Used to:
1. Show the offline badge in the navigator
2. Route chart opens to cache vs. Drive URL
3. Disable "Download Charts" button when offline

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Download interrupted (lost connection mid-batch) | Progress saved. "Resume Download" picks up where it left off (skips already-cached). |
| Google Doc chart | Exported as PDF during download. Cached as PDF. |
| Chart edited in-place in Drive | Stale cache until "Refresh Charts" (re-fetches `modifiedTime`) + re-download. New `modifiedTime` produces a new cache key; old entry evicted during download. |
| Chart file replaced (new fileId) | Same flow — "Refresh Charts" picks up the new fileId + modifiedTime. |
| Browser clears cache (storage pressure) | `cache.match()` returns miss. "Download Charts" re-downloads everything. No stale boolean flags. |
| Google Doc export too large (>10MB) | Skipped with error. Shown as "online only" in navigator. Download continues for remaining charts. |
| Multiple shows cached | Cache entries are keyed by fileId + modifiedTime, not song title. Same file used across shows shares one cache entry. No conflict, no duplication. |
| Storage quota exceeded | Catch the quota error, show "Not enough storage — clear other cached shows or browser data". |
| User never clicks Download | No service worker, no cache, no overhead. App works exactly as before. |

---

## Size Estimates

| Setlist size | Avg charts/song | Total files | Est. size |
|---|---|---|---|
| 15 songs (short set) | 3 | 45 | ~5 MB |
| 30 songs (full show) | 5 | 150 | ~15 MB |
| 30 songs (all 8 roles) | 8 | 240 | ~25 MB |

All well within browser storage limits (typically 50-100MB+ per origin).

---

## Implementation Order

1. Add `fileId` and `mimeType` to batch resolution response
2. Build `/api/drive/download` proxy endpoint
3. Build download manager (progress, resume, cache writes)
4. Register service worker on first download
5. Wire navigator to prefer cache over network
6. Add offline detection + badge
7. Setup tab UI (download button, status, clear cache)

---

## Out of Scope

- Syncing chart *edits* back to Drive (read-only cache)
- Automatic background sync (user-initiated only)
- Cross-device cache sharing (each device caches independently)
- Chart annotation/markup in the cached viewer
- PWA install prompt (could layer on later but not required)
