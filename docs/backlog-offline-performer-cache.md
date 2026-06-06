# Backlog: Offline Performer Mode (Full PWA)

**Priority:** High
**Status:** Backlog — needs design spec before build
**Depends on:** Supabase chart library (built), role filter (built)
**Replaces:** Current Google Drive offline cache (`lib/chart-cache.ts`, `public/sw.js`, `OfflineSection` in Config tab)

---

## Problem

The current offline cache is hardwired to Google Drive: it requires a Google OAuth token, calls `/api/drive/download`, and only shows in Config tab when `canResolveCharts` (Google connected). This is legacy from our pre-Supabase architecture.

Google Drive as chart source has multiple problems:
- Complex setup (OAuth, folder ID, Drive API scopes)
- Only the show owner has Drive access — performers can't cache charts independently
- No clean way to give each performer their own Drive auth for offline
- Supabase chart library is now the canonical source

Beyond charts, the current approach assumes network access to load the app itself. "Offline" must mean fully offline — no network required to open the page, view the setlist, or navigate charts. You can't assume "limited access for the wrapper and offline only for the charts." Connectivity can drop at any point during a set.

## Goal

Any performer viewing a show can go fully offline on their device. One explicit "Ready for Offline" action while connected; after that, zero network dependency. The entire Perform experience — app shell, show data, charts — serves from local cache.

## Workflow

```
ONLINE (before gig):
  1. Performer opens /{owner}/{show} on their device
  2. Selects their role filter (e.g., "Guitar")
  3. Taps "Ready for Offline" on Perform tab
  4. App caches: shell (HTML/JS/CSS) + show data (setlist/keys) + role-filtered charts
  5. Confirmation: "Offline ready — 12 charts cached (1.8 MB)"

AT THE GIG (online or offline — doesn't matter):
  1. Open the URL (or PWA home screen icon)
  2. Service worker serves everything from cache
  3. Swipe songs, tap charts, page through PDFs — all local
  4. If connectivity exists, no difference in behavior
  5. If connectivity drops mid-set, no interruption

AFTER THE GIG:
  Cache evicts via any of three triggers (see Eviction Strategy)
```

## Key Design Constraints

1. **Full PWA, not just chart caching.** The service worker must cache the app shell (Next.js page, JS bundles, CSS, fonts, icons) so the page itself loads without network. This is the critical difference from the current implementation.

2. **Performer-scoped, not owner-scoped.** Each performer invokes offline mode on their own device. No owner auth required — charts are already accessible via the show's public URL.

3. **Role-filtered by default.** A guitarist doesn't need the keys charts. Cache only the charts matching the performer's active role filter. This is the most resource-efficient path — a 10-song set with 5 roles has 50 charts; a single role filter reduces that to ~10.

4. **Fallback: cache all if role = "all."** If no role filter is set, cache everything.

5. **Auto-cleanup.** Cached charts shouldn't accumulate forever. Three eviction triggers (any one suffices):
   - **Show date passes:** auto-evict after the event date (next app load after show date)
   - **Manual clear:** performer taps "Clear offline cache"
   - **Next show save:** when the show data changes (new setlist saved), stale cache is replaced

6. **UX location:** The "Ready for Offline" action belongs on the **Perform tab** (where performers actually are at showtime), not buried in Config. Possibly a small icon/button near the role filter.

7. **Source: Supabase chart library.** Charts are fetched from Supabase storage (already public URLs on the show's chart objects). No proxy route needed — just fetch the URL and cache the response.

8. **Pre-cache strategy:** Both auto-download in background on first load AND a manual "Ready for Offline" button so performers can verify/force. Not mutually exclusive.

## What Gets Cached

- **App shell:** HTML, JS bundles, CSS, fonts, icons — everything needed to render the Perform tab without network
- **Show data:** Setlist (song titles, keys, positions, order), show metadata — small JSON snapshot in Cache API or localStorage
- **Chart blobs:** PDF/image files for the active role filter (via Cache API, same approach as current implementation)
- **Role filter selection:** sessionStorage (already persisted)

## What Does NOT Get Cached

- Config/Setup tab state (stage plot, inputs, monitors, notes) — not needed at showtime for a performer
- Other performers' charts (unless role = all)
- AI tab, export features, edit functionality — Perform-only scope

## Eviction Strategy

```
On app load:
  If show.eventDate < today:
    Delete cache for this show
    Show toast: "Offline cache cleared — show date passed"

On show save (owner):
  Invalidate cache version key
  Next performer load detects stale cache, prompts re-download

On manual clear:
  Performer taps "Clear offline cache" — immediate delete
```

## Technical Scope

### App shell caching (new work)
- Service worker pre-caches Next.js page routes, JS chunks, CSS, static assets
- Navigation requests fall back to cached shell when offline
- Options: `next-pwa` package, Workbox, or manual SW config (design spec should evaluate)
- Need to handle Next.js dynamic routes (`/[owner]/[show]`) in SW routing

### Chart caching (refactor existing)
- Swap fetch source: `fetch(chart.url)` from Supabase instead of `POST /api/drive/download` with Google token
- Keep `lib/chart-cache.ts` Cache API helpers — refactor to remove Google-specific code
- Keep `public/sw.js` — extend to handle app shell in addition to chart cache

### Show data snapshot (new work)
- On "Ready for Offline," snapshot the current setlist/show metadata into Cache API or localStorage
- Perform tab reads from snapshot when offline (instead of Supabase API)

## Migration: Deprecate Google Drive Offline

- Remove `OfflineSection` from Config tab
- Remove `/api/drive/download` proxy route
- Remove Google token dependency from offline path
- The broader Google Drive deprecation (charts setup, OAuth, folder config) is a separate effort

## Open Questions

- Should the performer see a persistent "offline ready" indicator on the Perform tab? (e.g., green dot or checkmark next to role filter)
- Cache size budget per show? Current estimate: app shell ~2-5MB (one-time), charts ~1MB per role. Minimal.
- Home screen install prompt ("Add to Home Screen") — include in this scope or separate?
- Next.js + service worker integration approach — needs research during design spec (Next.js 16 may have opinions)

---

*Created: 2026-05-30*
