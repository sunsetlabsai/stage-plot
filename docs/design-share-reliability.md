# Design: Share Reliability Fixes

**Status:** v1.4 — merge-ready pending final Codex pass
**Date:** 2025-06-03
**Scope:** 3 fixes — slug stability, print overflow, friendly 404

---

## Problem Statement

1. **Silent slug mutation** — The PUT `/api/shows/update` route regenerates the show slug whenever the display name changes, silently breaking every previously-shared link. Band members report intermittent 404s.

2. **Print cue sheet overflow** — `break-inside: avoid` on cue sheet columns can push content to page 2 invisibly. Long setlists need to flow across pages gracefully.

3. **Raw 404 on shared links** — Failed show links render an error banner but still show empty tab content below it. The broken URL also gets written to `showrunr-last-show` localStorage, poisoning offline launch.

---

## Fix 1: Immutable Slugs

### Change
Delete the slug-regeneration block from `app/api/shows/update/route.ts` (lines 31-65). Remove `RESERVED_SLUGS` and `slugify` from this file (dead code after removal). Remove `slug` from `updatePayload`. Keep `.select('updated_at, slug')` on the update query — `data.slug` is the unchanged value.

Remove all dead slug-update code from `lib/use-show.ts`:
- Lines 59-63 (`history.replaceState` block) — dead, slugs no longer change
- Line 55 `slug: newSlug` destructuring — parse only `{ updated_at }` from the response
- `ownerSlug` parameter (line 26) — remove if no remaining usages after cleanup; also remove from the `useCallback` dependency array (line 70)
- `slug` parameter usage — audit; remove from `doSave` dependencies if no longer referenced in the callback body

### Result
Slugs are set once at creation (POST `/api/shows`). Renaming a show changes the display name only. Shared links never break. A show created as "New Show" keeps its `/owner/new-show` slug permanently — this is an accepted tradeoff.

### Files changed
- `app/api/shows/update/route.ts` — remove ~35 lines
- `lib/use-show.ts` — remove ~8 lines, clean up unused params/deps

### Migration
None.

---

## Fix 2: Print Cue Sheet Overflow

### Changes

**A. Remove column break constraint** in `app/globals.css`:
Delete `break-inside: avoid` from `.cue-sheet-col`.

**B. Print density class** for 17+ songs:
```css
.cue-sheet-compact .cue-sheet-item { padding: 1.5pt 0; }
.cue-sheet-compact .cue-sheet-title { font-size: 13pt; }
.cue-sheet-compact .cue-sheet-num { font-size: 11pt; }
.cue-sheet-compact .cue-sheet-key { font-size: 11pt; }
```

Applied in the component:
```tsx
const songs = band.setlist ?? [];
const densityClass = songs.length > 16 ? 'cue-sheet-compact' : '';
```

**C. CSS columns layout for 29+ songs:**
Replace the manual two-column split with a single `<ol>` using CSS `columns: 2`. The browser flows songs sequentially across columns and pages.

```css
.cue-sheet-flow {
  columns: 2;
  column-gap: 24pt;
  list-style: none;
  padding: 0;
}
.cue-sheet-flow .cue-sheet-item {
  break-inside: avoid;
}
```

For <= 28 songs, keep the existing manual grid (proven single-page layout).

**D. Guard `band.setlist`** with `?? []` (`BandConfig.setlist` is optional per `lib/types.ts:68`).

### Files changed
- `app/globals.css` — remove `break-inside: avoid`, add density + flow classes
- `app/[owner]/[show]/page.tsx` — density class, 29+ flow branch, setlist guard

---

## Fix 3: Friendly 404 for Shared Shows

### Changes

**A. Add `showLoaded` state flag.**
`showId` is only set for authenticated users (`page.tsx:289`), so it's the wrong signal for anonymous visitors. Add a new boolean:

```tsx
const [showLoaded, setShowLoaded] = useState(false);
```

Set `true` after successful fetch, inside the `.then(async (data) => { ... })` block, after `setConfig(cfg)`:
```tsx
setShowLoaded(true);
```

**B. Distinguish error types in the 404 UI.**
`loadError` is set for both API 404s and network failures (`page.tsx:254-314`). The UI should reflect this:

```tsx
if (loadError) {
  const isNetworkError = loadError.includes('network');
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
      <div className="text-center max-w-md px-6">
        <h1 className="text-2xl font-bold mb-4">
          {isNetworkError ? 'Connection error' : 'Show not found'}
        </h1>
        <p className="text-gray-400 mb-6">
          {isNetworkError
            ? 'Could not reach ShowRunr. Check your connection and try again.'
            : 'This show may have been renamed or removed. If you received this link from someone, ask them for an updated link.'}
        </p>
        {isNetworkError && (
          <button
            onClick={() => window.location.reload()}
            className="text-blue-400 hover:text-blue-300 underline mr-4"
          >
            Retry
          </button>
        )}
        <a href="/" className="text-blue-400 hover:text-blue-300 underline">
          Go to ShowRunr home
        </a>
      </div>
    </div>
  );
}
```

Placed after all hooks (line ~360) to preserve React hook ordering. No tab content renders.

**C. Clear `loadError` at fetch start.**
At the top of the fetch `useEffect`, before the `fetch()` call:
```tsx
setLoadError('');
setShowLoaded(false);
```
This prevents stale error state if the user navigates client-side from a failed route to a valid one.

**D. Guard localStorage write** on `showLoaded`:
```tsx
useEffect(() => {
  if (owner && slug && showLoaded) {
    localStorage.setItem('showrunr-last-show', `/${owner}/${slug}`);
  }
}, [owner, slug, showLoaded]);
```

Works for both authenticated and anonymous visitors.

### Files changed
- `app/[owner]/[show]/page.tsx` — add `showLoaded` state, clear errors on fetch start, conditional render with error type, localStorage guard

---

## Test Plan

### Slug immutability
- [ ] Rename a show, verify slug does NOT change
- [ ] Share link, rename show, verify shared link still works
- [ ] Create "New Show", rename to "My Gig", verify slug remains `new-show` (accepted tradeoff)
- [ ] Multiple shows for same owner, all shared links resolve independently

### Friendly 404
- [ ] Visit non-existent show link — "Show not found" renders, no tabs
- [ ] Disconnect network, visit valid show — "Connection error" renders with retry button
- [ ] Visit non-existent show link — `showrunr-last-show` NOT updated
- [ ] Navigate client-side from invalid to valid route — error clears, show loads
- [ ] Valid shared link loads correctly for anonymous user
- [ ] Valid shared link updates `showrunr-last-show` for anonymous user

### Print
- [ ] Print 10 songs — one page, normal density
- [ ] Print 17 songs — compact density, one page
- [ ] Print 28 songs — manual two-column grid, compact density
- [ ] Print 29 songs — CSS columns flow layout kicks in
- [ ] Print 29+ songs — multi-page, sequential order
- [ ] Print 29+ songs with long titles — no truncation

---

## Out of Scope

- Prompt for show name on create
- Manual slug rename UI
- Slug redirect aliases
- Owner profile pages
- Server-side HTTP 404 status
