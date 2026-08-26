# Alpha-Ready: Owner Namespacing + Offline PWA — Design Spec v1.2

> v1.2 changelog: Addressed 3 Codex round-2 findings (see Appendix B).
> v1.1 changelog: Addressed 5 Codex round-1 findings (see Appendix A).

## Goals

Get ShowRunr into the hands of friends/colleagues/pros for real usage. Two deliverables:
1. Clean owner-namespaced URLs: `/{owner}/{show}`
2. Full offline PWA: app shell + show data + charts cached for venue use

---

## Part 1: Owner Namespacing

### URL Structure

```
/                               -> landing (redirect to /dashboard or /sign-in)
/{owner-slug}/{show-slug}       -> show view (Perform/Mix/Config/AI)
/dashboard                      -> authenticated user's dashboard
/sign-in                        -> OTP auth
/claim                          -> "Claim your RunR" onboarding (first sign-in)
/api/*                          -> API routes (unchanged)
/admin                          -> admin panel (unchanged)
```

**Blocklist** (reserved first-segment values that cannot be owner slugs):
```
dashboard, sign-in, sign-out, claim, api, admin, about, help,
pricing, terms, privacy, settings, new, import, export
```

**Examples:**
- `showrunr.ai/loosely-covered/fernandos-party`
- `showrunr.ai/sleazzy-top/woof-camp-afterglow`
- `showrunr.ai/graham/nicholson-ranch`

### Data Model

#### New table: `profiles`

```sql
CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_slug text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON profiles FOR SELECT USING (true);
CREATE POLICY "Owner manage" ON profiles FOR ALL USING (auth.uid() = id);
```

#### Modify `shows` table

```sql
-- Relax slug uniqueness from global to per-owner
ALTER TABLE shows DROP CONSTRAINT shows_slug_key;
ALTER TABLE shows ADD CONSTRAINT shows_owner_slug_unique UNIQUE(owner_id, slug);
```

#### Seed existing users (env-specific, NOT part of migration)

Seeding is a **manual, env-specific script** — not part of the numbered migration files.
Migrations must be reproducible across branch DBs and staging resets. The seed script
lives at `supabase/seeds/seed_profiles.sql` and is run once manually per environment.

```sql
-- supabase/seeds/seed_profiles.sql
-- Run manually after migration 005. Replace UUIDs with values from your Supabase auth dashboard.
-- Production UUIDs are documented in 1Password / team vault, NOT checked into code.

INSERT INTO profiles (id, owner_slug, display_name) VALUES
  ('<primary-user-uuid>', 'graham', 'Graham'),
  ('<secondary-user-uuid>', 'fernando', 'Fernando')
ON CONFLICT (id) DO NOTHING;
```

### "Claim Your RunR" Onboarding

**When:** First authenticated visit where no `profiles` row exists for the user.

**Flow:**
1. Middleware checks auth session -> user exists -> query profiles table
2. No profile -> redirect to `/claim`
3. `/claim` page: simple form

**Middleware carve-outs (Codex round-2 finding #1):** The profile-check redirect
must exempt these paths to prevent redirect loops:
- `/claim` (the destination itself)
- `/api/profiles` (the endpoint `/claim` POSTs to)
- `/sign-in`, `/sign-out` (auth flow)
- `/api/*` (all API routes — no profile gate on data endpoints)

```typescript
// middleware.ts — skip profile check for these paths
const PROFILE_CHECK_EXEMPT = new Set([
  '/claim', '/sign-in', '/sign-out',
]);
const skipProfileCheck =
  PROFILE_CHECK_EXEMPT.has(pathname) || pathname.startsWith('/api/');
```
   - Heading: "Claim your RunR"
   - Subheading: "Pick a handle for your ShowRunr URL"
   - Input: `showrunr.ai/` + [text field]
   - Validation: lowercase, alphanumeric + hyphens, 3-30 chars, not in blocklist, not taken
   - Optional: display name field
   - Submit -> insert into profiles -> redirect to `/dashboard`

**Implementation:** `app/claim/page.tsx` (client component) + `POST /api/profiles` (create profile endpoint).

### Route Changes

#### New route: `app/[owner]/[show]/page.tsx`
- Same component as current `app/[slug]/page.tsx` (moved, not copied)
- `useParams()` now returns `{ owner, show }` instead of `{ slug }`
- Show loading: `GET /api/shows/{owner}/{show}` (new endpoint, replaces `/api/shows/[slug]`)

#### Updated API: `GET /api/shows/[owner]/[show]/route.ts`
- Resolve owner_slug -> owner_id via profiles table
- Then resolve show by (owner_id, slug) pair
- Returns same payload as current `/api/shows/[slug]`

#### Backwards-compat redirect: hardcoded legacy map

**Problem (Codex finding #1):** Once global slug uniqueness is dropped, a middleware
query for "slug = X" across all owners is ambiguous. The middleware also uses the
anon-key server client, while anonymous slug resolution is intentionally isolated
behind the admin-client API route — mixing these would break the security boundary.

**Solution:** Since only 3 shows exist pre-migration, use a hardcoded redirect map
in middleware instead of a DB query. Zero ambiguity, zero auth boundary violations.

```typescript
// middleware.ts — legacy redirect map (frozen at migration time)
const LEGACY_REDIRECTS: Record<string, string> = {
  'woof-camp-afterglow-sleazzy-top': '/graham/woof-camp-afterglow-sleazzy-top',
  'nicholson-ranch':                 '/graham/nicholson-ranch',
  'fernandos-party':                 '/fernando/fernandos-party',
};
```

- Single-segment paths matching the map -> 301 redirect to namespaced URL
- Single-segment paths NOT in map and NOT in blocklist -> 404
- Map is frozen — no new entries. All future shows are created under `/{owner}/{show}`
- No DB query in middleware for legacy resolution

#### Dashboard link updates
- Show cards link to `/{owner_slug}/{show_slug}` instead of `/{slug}`
- Dashboard API returns owner_slug alongside show data
- Share URLs updated throughout

#### `use-show.ts` slug update
- `replaceState` path changes from `/${newSlug}` to `/${ownerSlug}/${newSlug}`

### Slug collision handling

Show slugs are now unique per-owner (not globally). Two different users can both have `/friday-night`. The collision check in `POST /api/shows` and `PUT /api/shows/update` changes from global to per-owner.

**Important (Codex finding #2):** The collision scope must always be
`show.owner_id`, NOT `auth.uid()`.

*(Amended 2026-08-25 — see `design-single-backend.md` §3.3c. This read "Editors can
update shows they don't own (via RLS `is_show_collaborator` policy) … otherwise an
editor's collision check would search the wrong owner's namespace." **Collaborators
are VIEW ONLY and the `editor` role is deleted**, so no non-owner updates a show
and the premise is gone. **The RULE still stands and must not be relaxed:**
resolving from `show.owner_id` is what makes the check correct independent of who
is acting — which is exactly why it survives the principal it was written for.)*

```typescript
// POST /api/shows (create) — caller is always the owner, no existing id to exclude
.eq('slug', slug).eq('owner_id', user.id)

// PUT /api/shows/update (rename) — must resolve owner from the show, not the session
const { data: show } = await supabase.from('shows').select('owner_id').eq('id', id).single();
.eq('slug', slug).eq('owner_id', show.owner_id).neq('id', id)
```

---

## Part 2: Offline PWA

### Problem

Venues often have poor connectivity. The current SW only caches chart PDFs. If you lose signal, the app shell won't load — Perform mode is dead.

### Strategy: Cache layers

| Layer | What | Strategy | When cached |
|-------|------|----------|-------------|
| App shell | HTML, JS, CSS, fonts | **Precache on SW install** | First visit / SW update |
| Show data | JSON config for a show | **Cache on view** (network-first) | When user opens a show |
| Charts | PDF files | **Existing** (user-triggered download) | Manual "Download for offline" |

### Service Worker Upgrade

Replace the minimal `sw.js` with a proper caching SW:

```
public/sw.js -> generated or hand-written with:
  1. PRECACHE: app shell assets (/_next/static/*, key HTML routes)
  2. RUNTIME: network-first for /api/shows/* (cache response on success)
  3. RUNTIME: cache-first for /_next/static/* (immutable hashes)
  4. EXISTING: cache-only for /api/chart-cache/* (unchanged)
```

**Approach: Hand-written SW** (not Workbox/next-pwa). Reasons:
- We already have a custom SW for charts
- The app is small — precache list is manageable
- No build-time plugin complexity
- Full control over caching strategy

### SW Implementation Details

#### Install event — precache app shell
```javascript
const APP_CACHE = 'showrunr-app-v1';
const SHOW_CACHE = 'showrunr-shows-v1';

// Populated at build time via a simple script that lists /_next/static output
const APP_SHELL_URLS = [
  '/',
  '/dashboard',
  '/sign-in',
  // /_next/static chunks will be added by build script
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then(cache => cache.addAll(APP_SHELL_URLS))
  );
  self.skipWaiting();
});
```

#### Fetch event — routing
```javascript
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Chart cache (existing behavior)
  if (url.pathname.startsWith('/api/chart-cache/')) {
    event.respondWith(chartCacheHandler(event));
    return;
  }

  // Show data API — network-first, cache fallback
  if (url.pathname.match(/^\/api\/shows\/[^/]+\/[^/]+$/)) {
    event.respondWith(networkFirst(event, SHOW_CACHE));
    return;
  }

  // Static assets — cache-first (hashed filenames)
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(event, APP_CACHE));
    return;
  }

  // Navigation requests — network-first with app shell fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationHandler(event));
    return;
  }
});
```

#### Show data caching
When a user opens `/{owner}/{show}`, the fetch to `/api/shows/{owner}/{show}` is intercepted:
1. Try network first
2. On success, clone response into `SHOW_CACHE`
3. On network failure, serve from cache
4. Cache key: the request URL

This means: **open a show once while online, and it's available offline forever** (until cache is cleared or updated).

#### Offline indicator
- Small banner at top of Perform tab: "Offline — showing cached data"
- Only appears when `navigator.onLine === false`
- Non-blocking — the show still works

### Build-time asset manifest

Next.js generates hashed filenames in `/_next/static/`. We need a small build script that:
1. Runs after `next build`
2. Lists all files in `.next/static/`
3. Writes them as a JSON array to `public/asset-manifest.json`
4. The SW fetches this manifest on install and precaches all entries

Add to `package.json`:
```json
"scripts": {
  "build": "next build && node scripts/generate-sw-manifest.js"
}
```

### Manifest.ts updates

**Note (Codex finding #3):** `start_url` must NOT be `/dashboard` — that route
depends on an authenticated API fetch that fails offline or with an expired session.
Keep `start_url: '/'` and let the root page's offline-aware logic serve the
last-viewed show from cache, or fall through to sign-in when online.

```typescript
start_url: '/',           // keep as-is (root handles offline routing)
id: '/',                  // stable PWA identity
```

The root page (`app/page.tsx`) gains an offline branch: if `!navigator.onLine`,
check `localStorage` for `showrunr-last-show` (set whenever a show is opened)
and redirect to that cached show URL. This means launching the PWA offline
drops you straight into your last gig's Perform tab.

### SW Registration (global)

**Note (Codex finding #4):** Current SW registration only happens when the user
manually downloads charts from Config tab. The install prompt and offline shell
require the SW to be registered much earlier.

**Fix:** Register the SW globally in `app/layout.tsx` via a `<script>` or
small client component:

```typescript
// app/sw-register.tsx ('use client')
'use client';
import { useEffect } from 'react';

export function SwRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js');
    }
  }, []);
  return null;
}
```

Added to `layout.tsx` body. This ensures:
- SW is active on first visit (not just chart download)
- `beforeinstallprompt` can fire (requires active SW)
- App shell precache happens immediately

The existing `registerServiceWorker()` in `lib/chart-cache.ts` becomes a no-op
guard (check if already registered, skip if so). No behavior change for chart
caching — the SW handles both chart-cache and app-shell concerns.

### Install prompt

Add a small "Add to Home Screen" prompt on Perform tab for eligible browsers:
- Listen for `beforeinstallprompt` event (captured globally via SwRegister)
- Show a dismissable banner: "Install ShowRunr for offline access"
- Store dismissal in localStorage (don't nag)
- Only show on Perform tab (that's where musicians are at the gig)

---

## Implementation Plan

### Phase 1: Owner namespacing (PR A)
1. Migration 005: profiles table + shows constraint change (schema only, no seed data)
2. Manual step: run `supabase/seeds/seed_profiles.sql` per environment
3. `POST /api/profiles` endpoint (claim handle)
4. `app/claim/page.tsx` onboarding page
5. Move `app/[slug]/page.tsx` -> `app/[owner]/[show]/page.tsx`
6. New `app/api/shows/[owner]/[show]/route.ts`
7. Middleware: legacy slug redirect + profile check
8. Dashboard: update links to `/{owner}/{show}` format
9. `use-show.ts`: update replaceState path
9. Update slug collision checks to per-owner scope

### Phase 2: Offline PWA (PR B)
1. `scripts/generate-sw-manifest.js` — build-time asset list
2. Rewrite `public/sw.js` — precache + runtime caching
3. Show data caching in SW fetch handler
4. Offline indicator component
5. Update `manifest.ts` (start_url, id)
6. Install prompt on Perform tab
7. Update build script in package.json

### Migration safety
- Only 3 shows, 2 users — low risk
- Backwards-compat redirects via hardcoded map (no DB query in middleware)
- Profile seed is a separate manual script, not part of numbered migrations
- Can run migration + deploy atomically on Vercel

---

## Appendix A: Codex Review Findings (v1.0 -> v1.1)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | CRITICAL | Legacy redirect used global slug query after dropping uniqueness; also mixed anon-key client into admin-only resolution path | Replaced with hardcoded 3-entry redirect map — no DB query, no auth boundary crossing |
| 2 | HIGH | Editor collision check scoped to `auth.uid()` instead of `show.owner_id` — wrong namespace for shows the editor doesn't own | Collision check now resolves `owner_id` from the show row, not the session |
| 3 | HIGH | `start_url: '/dashboard'` fails offline (requires auth API fetch) | Keep `start_url: '/'`, add offline branch that redirects to last-viewed show from localStorage |
| 4 | HIGH | SW registration only triggered on chart download — too late for install prompt and app shell precache | Global SW registration via `SwRegister` component in `layout.tsx` |
| 5 | MEDIUM | Migration seed with hardcoded UUIDs not reproducible across environments | Seed moved to `supabase/seeds/seed_profiles.sql` (manual, env-specific), UUIDs documented in vault not code |

## Appendix B: Codex Review Findings Round 2 (v1.1 -> v1.2)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 6 | HIGH | Claim-flow middleware redirect to `/claim` not exempted for `/claim` itself, `/api/profiles`, or auth routes — causes infinite redirect loop | Added explicit `PROFILE_CHECK_EXEMPT` set + `/api/*` prefix check |
| 7 | MEDIUM | Implementation plan step 1 still said "seed existing users" as part of migration 005, contradicting the env-specific seed decision | Split into step 1 (schema migration) and step 2 (manual seed script) |
| 8 | LOW | Create-path collision snippet included `.neq('id', id)` — misleading since create has no existing id | Removed `.neq('id', id)` from POST example, kept it for PUT |

---

## Open Questions

None — ready to build on approval.
