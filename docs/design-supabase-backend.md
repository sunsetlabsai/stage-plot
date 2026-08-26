# Design: Supabase Backend — Shows, Charts, Sharing

> ## ⚠ PARTIALLY BUILT — read `docs/design-single-backend.md` first
>
> **Status below is STALE.** "Awaiting build approval" is wrong: shows, charts,
> auth, songs, profiles and collaborators were all built and are in production.
>
> **What was NOT built, despite this document declaring it replaced:**
> - `/api/show` (Redis slug CRUD) — the replacement shipped 2026-05-25; **the
>   Redis route was never deleted and still sits in the tree with zero callers.**
> - `tryit_quota` + `increment_tryit()` — migrated in `001_initial_schema.sql`,
>   **never called.** Production still uses Redis `quota:{ip}`.
> - `user_secrets` — table created, **zero application code**.
> - Admin config — still Redis-only.
>
> **⇒ This document's `Replaces: Redis` claim has been TRUE ON PAPER AND FALSE IN
> PRODUCTION since May 2026.** `docs/design-single-backend.md` executes it, and
> supersedes two specifics here:
>
> - The **`user_secrets` policy block**. *(Corrected 2026-08-24: an earlier
>   version of this notice said those write policies "were never created". **That
>   was wrong** — `001_initial_schema.sql:149` and `:153` create them exactly as
>   specified here.* They are being **dropped** by `design-single-backend.md`
>   §4.2, because Supabase Vault requires server-side writes that a browser
>   client cannot perform, and because no DELETE policy exists for the Remove
>   action. *The write-only guarantee comes from the absent SELECT policy, which
>   this document got right.)*
> - The **"Env vars only"** row in the table below — Graham ruled 2026-08-24 for
>   a Supabase `admin_config` table instead.

**Status:** ~~Draft v1.4 — Post-adversarial review (14 findings across 3 rounds), awaiting build approval~~ — **superseded, see notice above**
**Replaces:** Redis (slugs, admin config, try-it quota) — **aspirational; only partially executed, see notice above**, Google Drive (charts), localStorage-as-primary
**Depends on:** None (greenfield backend addition)
**Scope:** Single Supabase project replaces all current server-side storage. Anonymous viewing, authenticated editing, chart uploads, multi-show dashboard.

---

## The Problem

ShowRunr has four storage systems that each solve one piece:

| System | What It Stores | Pain |
|---|---|---|
| localStorage | Active show config | One browser clear and it's gone |
| Redis (Vercel KV) | Published shows (slugs), admin config, try-it quota | Costs money, 90-day TTL, opaque blobs, config overhead |
| Google Drive | Charts (PDFs) | OAuth setup hell, folder structure conventions, batch resolution complexity, download proxy for CORS |
| Cache API | Offline chart blobs | Fine — stays |

The sharing model is also incomplete. A slug URL loads a snapshot, but there's no concept of "this is Graham's show, and Rachel is on it." The owner/collaborator relationship lives nowhere.

*(Amended 2026-08-25: the original read "…and **Rachel can add her charts to it**." That is a non-owner WRITE, which the roles ruling removed — see `design-single-backend.md` §3.3c. **The problem statement still stands**; what changed is what solving it grants. Rachel gets the show on her dashboard and read access to the owner's library — not upload rights. If she needs a chart added, she sends it to the owner, or becomes an owner herself.)*

**Goal:** One backend (Supabase) that handles identity, shows, charts, permissions, and sharing. Kill Redis. Kill the Google Drive dependency. Make sharing durable and collaborative.

---

## Architecture

```
Browser (Next.js client)
  |
  |-- Supabase Auth (6-digit email OTP, optional Google OAuth)
  |-- Supabase Postgres (shows, collaborators, user_secrets)
  |-- Supabase Storage (chart files)
  |-- Cache API (offline chart cache — unchanged)
  |
  |-- localStorage (offline cache only — no longer primary)
```

### What Goes Away

| Component | Replacement | Files Deleted |
|---|---|---|
| Redis client + Vercel KV | Supabase client | `lib/admin-config.ts` |
| `POST/GET /api/show` (Redis slug CRUD) | Supabase query | `app/api/show/route.ts` |
| `GET/PUT /api/admin/settings` | Env vars only | `app/api/admin/settings/route.ts`, `app/admin/page.tsx` |
| Google OAuth flow | Supabase Auth | `app/api/auth/google/*` |
| Drive batch resolution | Direct chart upload | `app/api/drive/*`, `lib/drive.ts` |
| Drive download proxy | Supabase Storage public URL | `app/api/drive/download/route.ts` |
| `stageplot-google-token` in localStorage | Supabase session | — |
| `stageplot-publish-token` in localStorage | Supabase row ownership | — |
| Try-it quota (Redis INCR) | Supabase RPC or rate-limit table | — |

### What Stays (Unchanged)

| Component | Why |
|---|---|
| Cache API + Service Worker | Offline chart access at gigs — works great, no change needed |
| YAML export/import | Portable backup/transfer format — bumped to `showrunr/v2` (carries song IDs for chart linkage, R2 Finding #3) |
| `?config=` shareable URLs | Base64-encoded full config in URL — still works as a fallback |
| AI Codesigner | Modifies in-memory config; save triggers write to Supabase instead of localStorage |
| Print/PDF | Renders from in-memory config |

---

## Data Model

### `shows`

```sql
create table shows (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  owner_id uuid not null references auth.users(id),
  config jsonb not null,           -- full AppConfig (stage plot, inputs, monitors, setlist, notes)
  name text not null,              -- denormalized from config for list views
  venue text,                      -- denormalized
  show_date date,                  -- denormalized
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Server-managed updated_at — never trust client clocks (Finding #3)
create trigger set_shows_updated_at
  before update on shows
  for each row execute function moddatetime(updated_at);

alter table shows enable row level security;

create index shows_owner_idx on shows(owner_id);
create index shows_slug_idx on shows(slug);
```

`config` is the full `AppConfig` as JSONB — same structure as today's localStorage blob minus ephemeral fields (charts). Song IDs are now stable and persisted (no longer regenerated on load). Denormalized `name`, `venue`, `show_date` avoid parsing JSONB for dashboard list views.

**Note:** `updated_at` is set by a database trigger, never by the client. This eliminates clock-skew issues in the offline merge flow (Finding #3).

### `show_collaborators`

```sql
create table show_collaborators (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references shows(id) on delete cascade,
  user_id uuid references auth.users(id),  -- null until invite is accepted
  email text not null,                      -- invite target
  -- ⛔ `role` is DELETED by chunk 6 — see design-single-backend.md §3.3c (v1.9).
  -- It shipped as below and is still live on `main`; collaborators are now VIEW
  -- ONLY, so a column whose only legal value would be 'viewer' carries no
  -- information. Shown as-shipped, NOT as a target state.
  role text not null check (role in ('editor', 'viewer')),
  invited_at timestamptz default now(),
  accepted_at timestamptz,
  unique(show_id, email)
);

alter table show_collaborators enable row level security;
```

Owner is implicit (shows.owner_id). Collaborators are invited by email. `user_id` is null until they accept the OTP and a Supabase Auth user is created/linked. RLS checks `user_id` after acceptance, `email` during the invite-pending window.

**What a collaborator row buys, restated 2026-08-25:** not access — **discoverability**. Any holder of the show link can already view it (the public route reads via the service role and bypasses RLS entirely), so membership grants no additional read capability. What it does is put the show on that person's dashboard. That is the reason to keep this table once `role` is gone.

### `user_secrets` (R2 Finding #1)

```sql
create table user_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  claude_api_key text,             -- BYOA key, encrypted at rest by Supabase
  updated_at timestamptz default now()
);

alter table user_secrets enable row level security;

-- No SELECT policy — secrets are NEVER readable from the browser client (R3 Finding #7).
-- All reads go through server-side API routes using the admin client (bypasses RLS).

-- Write policies: user can save/update their own key via authenticated server client
create policy "User write own secrets"
  on user_secrets for insert
  with check (auth.uid() = user_id);

create policy "User update own secrets"
  on user_secrets for update
  using (auth.uid() = user_id);
```

**Why not Auth user_metadata (R2 Finding #1):** Supabase user_metadata is user-editable and can be included in JWT claims, meaning the API key could ride inside auth tokens and be exposed to client/runtime surfaces. A dedicated table ensures the key never appears in JWTs or client-accessible metadata.

**Why no SELECT policy (R3 Finding #7):** The doc claims "browser never sees the key after initial entry," but a SELECT policy would allow any authenticated browser client to read the key directly. By omitting the SELECT policy, RLS blocks all client-side reads. Only the admin client (service role, server-side) can read the key — used in the chat API route to pass the key to Anthropic.

**Access pattern:**
- **Save key:** `POST /api/user/api-key` → authenticated server client (RLS enforced) inserts/updates the row
- **Read key:** `POST /api/agent/chat` → admin client (service role, bypasses RLS) reads the key, passes to Anthropic
- **Browser never sees the key after initial entry** — the save endpoint accepts it, the chat endpoint uses it server-side, no read path exists for the browser client

### `charts`

```sql
create table charts (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references shows(id) on delete cascade,
  song_id uuid not null,           -- stable song UUID from AppConfig setlist (Finding #4)
  role text not null,              -- 'Guitar', 'Lyrics', 'Keys', 'Bass', 'Horns', etc.
  file_name text not null,         -- original filename for display
  storage_path text not null,      -- path in Supabase Storage bucket
  mime_type text not null,         -- 'application/pdf', 'image/png', etc.
  file_size integer not null,      -- bytes, for UI display
  uploaded_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),  -- (Finding #5) set by trigger, used for cache invalidation
  unique(show_id, song_id, role)   -- one chart per song per role
);

alter table charts enable row level security;

-- Server-managed updated_at (Finding #3 pattern — never trust client clocks)
create trigger set_charts_updated_at
  before update on charts
  for each row execute function moddatetime(updated_at);
```

**Song ID linkage (Finding #4):** Songs already have stable UUIDs (`id` field from `withStableIds()`). With Supabase as primary storage, these IDs are persisted in `config.setlist[].id` and no longer regenerated on load. Charts link to `song_id`, not title — immune to song renames or duplicate titles.

**YAML format version bump (R2 Finding #3):** The YAML export format bumps to `showrunr/v2` and now includes song IDs:

```yaml
format: showrunr/v2

setlist:
  - id: f7e8d9c0-1234-5678-abcd-ef0123456789   # stable UUID, preserved across export/import
    title: Valerie
    lead: Rachel
    key: E
```

Import behavior:
- `showrunr/v2` files: IDs preserved as-is. Chart linkage survives round-trip.
- `showrunr/v1` files (legacy): IDs missing → regenerated via `withStableIds()`. Charts won't auto-link (acceptable for legacy files — user re-uploads charts after import). No data loss, just a manual re-association step.
- The serializer (`serializeShow()`) always writes v2 format going forward.

The `unique(show_id, song_id, role)` constraint means uploading a new Guitar chart for a song replaces the old one. If a song needs multiple charts per role (rare), we can relax this later.

### Storage Bucket

```
Bucket: charts (public read for downloads, write via API route only)

Path convention:
  {show_id}/{song_id}/{role}.{ext}

Example:
  a1b2c3d4/f7e8d9c0/guitar.pdf
  a1b2c3d4/f7e8d9c0/lyrics.pdf
  a1b2c3d4/b2c3d4e5/guitar.pdf
```

Public bucket means chart URLs are directly loadable — no proxy, no signed URLs, no CORS issues. Chart PDFs aren't sensitive (they're chord charts for cover songs).

**Storage write security (Finding #2):** The browser client never writes to Storage directly. All chart uploads go through a Next.js API route (`POST /api/charts/upload`) that:
1. Validates the user's Supabase session (JWT from cookie)
2. Verifies the user is **the owner** of the target show (DB query) *(amended 2026-08-25: was "owner or editor" — §3.3c)*
3. Constructs the Storage path server-side (prevents path traversal)
4. Uploads to Storage using the service role key
5. Inserts the `charts` row

This prevents any authenticated user from writing to arbitrary paths. The browser never sees the service role key or the Storage upload API directly.

---

## Auth Model

### Three Access Tiers

| Tier | Who | How They Get In | What They Can Do |
|---|---|---|---|
| **Anonymous** | Anyone with a slug URL | Just open the link | View show details, view/download charts, use at the gig |
| **Collaborator** | Invited by an owner | Email OTP (6-digit code) → session | **View only** — same as anonymous, plus the show appears on their dashboard |
| **Owner** | Show creator | Email OTP or Google OAuth → dashboard | Everything: full show editing, manage collaborators, delete show |

**⛔ AMENDED 2026-08-25 — the `Editor` tier is DELETED.** See
`design-single-backend.md` §3.3c (v1.9), which is authoritative.

This table previously carried an **Editor** tier with *"full show editing (config,
stage plot, inputs, charts, notes)"*, and a note reading *"editors are trusted
collaborators (bandmates, sound engineers), not restricted guests … RLS is correct
as-is."* **Graham ruled that out on 2026-08-25:** collaborators view, they do not
modify. The original intent was collaborator chart upload, judged a bad trade —
charts can be emailed to the owner, and anyone wanting to create their own can
become an owner (self-serve).

**What a collaborator row now buys is DISCOVERABILITY, not access.** Because any
holder of the link can already view, membership adds no read capability — it puts
the show on their dashboard. That is the reason to keep the table.

### Why Email OTP (Not Magic Links)

Musicians don't want to create accounts with passwords. A 6-digit code keeps them in the app:

1. Enter email → Supabase sends 6-digit OTP
2. Check email (or phone for SMS — future option) → type 6 digits → done

**Why OTP over magic links:**
- **Stays in-app** — no context switch to email client and back
- **Works on any device** — FOH engineer at soundcheck can check email on their phone and type the code on the venue's tablet, even if email isn't configured on that device
- **No deep-link issues** — magic links on mobile often open in the mail app's webview, creating session-in-wrong-browser problems
- **Same security model** — short-lived, one-use, tied to email address

Supabase Auth supports OTP natively:
```typescript
// Send OTP
await supabase.auth.signInWithOtp({ email });

// Verify OTP
await supabase.auth.verifyOtp({ email, token: '123456', type: 'email' });
```

For Graham specifically, Google OAuth is also available (you're already signed into Google everywhere). Both auth methods create the same Supabase Auth user.

**Future option:** SMS OTP via Twilio integration (Supabase supports it). Same code path, different delivery channel. Useful for the "musician who doesn't check email at soundcheck" case.

### Auth Flow

**Owner (first use):**
1. Open ShowRunr → "Sign in" → enter email → 6-digit code sent
2. Enter code → Supabase creates user + session → redirect to dashboard
3. Create a show → slug generated → show saved to Postgres
4. Session persists in browser (Supabase handles refresh)

**Collaborator (invited):**
1. Owner enters collaborator's email in show settings *(amended 2026-08-25: was "email + role (editor/viewer)" — there is no role to choose; §3.3c)*
   → Inserts `show_collaborators` row with `email`, `user_id = null`, `accepted_at = null` *(amended 2026-08-25: `role` removed from the insert — the column is dropped by chunk 6; §3.3c)*
2. Collaborator opens the show's slug URL → sees the show *(amended 2026-08-25: was "read-only view → 'Sign in to edit' prompt". Signing in does NOT grant editing — it makes the show appear on their dashboard; §3.3c)*
3. Enters email → OTP sent → enters code → Supabase Auth user created (if new) → session established
4. **Invite activation (R3 Finding #2/5):** After successful OTP verification, the app calls a server-side API route (`POST /api/auth/activate-invites`) that:
   ```sql
   -- Link the new user to any pending invites matching their email
   update show_collaborators
   set user_id = auth.uid(),
       accepted_at = now()
   where email = (select email from auth.users where id = auth.uid())
     and user_id is null;
   ```
   This runs via the admin client (service role) because the collaborator can't update their own row via RLS until `user_id` is set (chicken-and-egg). Runs once at sign-in time, idempotent.
5. RLS policies now match on `user_id = auth.uid()` → collaborator has **read access, and the show lists on their dashboard** *(amended 2026-08-25: was "editor/viewer access"; §3.3c)*
6. Collaborator is associated with that show permanently (until owner removes them)

**Anonymous viewer (shared link):**
1. Owner shares slug URL: `showrunr.app/loosely-covered`
2. Recipient opens link → no auth required → show loads read-only
3. Signing in does not confer editing. **Only the owner writes** *(amended 2026-08-25: was "If they want to edit, they sign in → if they're a listed collaborator, they get edit access"; §3.3c)*

### RLS Policies

**Key principle (Finding #1):** Anonymous slug lookups do NOT go through the browser Supabase client. They go through a Next.js API route that uses the service role key server-side. This means the `shows` table RLS only needs to authorize authenticated users — no `using (true)` that would expose full-table enumeration.

```sql
-- shows: owner can read their own shows
create policy "Owner read own shows"
  on shows for select
  using (auth.uid() = owner_id);

-- shows: collaborators can read shows they're invited to
create policy "Collaborator read"
  on shows for select
  using (
    exists (
      select 1 from show_collaborators
      where show_id = shows.id
        and user_id = auth.uid()
    )
  );

-- shows: only owner can insert
create policy "Owner insert"
  on shows for insert
  with check (auth.uid() = owner_id);

-- shows: owner can update their shows
create policy "Owner update"
  on shows for update
  using (auth.uid() = owner_id);

-- ⛔ DELETED 2026-08-25 — see design-single-backend.md §3.3c (v1.9).
-- This block previously created an "Editor update" policy granting UPDATE on
-- shows to collaborators with role = 'editor'. Collaborators are now VIEW ONLY,
-- and `show_collaborators.role` is dropped entirely. The policy shipped and is
-- live on `main`; chunk 6 removes it. Do NOT copy this block into a migration.
--
-- Only "Owner update" above governs writes to shows.

-- shows: owner can delete
create policy "Owner delete"
  on shows for delete
  using (auth.uid() = owner_id);

-- ⛔ DELETED 2026-08-25 — this ENTIRE charts policy block is doubly obsolete.
-- See design-single-backend.md §3.3c (v1.9).
--
-- 1. WRONG TABLE. `charts` was dropped in 003_chart_library.sql:13 and replaced
--    by owner-scoped `chart_library`. These policies exist in no live database
--    and cannot be recreated — their table is gone.
-- 2. WRONG MODEL. Chart write granted insert/update/delete to collaborators
--    with role = 'editor'. Collaborators are now VIEW ONLY, and `role` is
--    dropped entirely by chunk 6.
--
-- chart_library's live policies are owner-only from creation
-- (003_chart_library.sql:58-68): auth.uid() = owner_id on insert, update and
-- delete, plus a read policy for collaborators of that owner's shows.
--
-- ⚠ DO NOT COPY THIS BLOCK INTO A MIGRATION.
```

### Collaborator Table RLS (Finding #7)

```sql
-- collaborators: owner of the show can CRUD collaborator rows
create policy "Owner manage collaborators"
  on show_collaborators for all
  using (
    exists (
      select 1 from shows
      where shows.id = show_collaborators.show_id
        and shows.owner_id = auth.uid()
    )
  );

-- collaborators: collaborators can read their own invites
create policy "Collaborator read own"
  on show_collaborators for select
  using (user_id = auth.uid());
```

---

## Show CRUD + Sharing

### Create Show

Owner signs in → clicks "New Show" → enters name/venue/date → slug auto-generated from name → empty show saved to Supabase. Config starts with the same defaults as today's localStorage blank slate.

**Slug generation:** Same `slugify()` logic as today. On collision, append random suffix (same retry logic from PR #40). The `unique` constraint on `shows.slug` is the race-safety mechanism — no more Redis SETNX.

**Reserved slugs (R2 Finding #4):** Slug creation rejects values that collide with static routes. Enforced at the application layer before DB insert:

```typescript
const RESERVED_SLUGS = new Set([
  'dashboard', 'sign-in', 'sign-out', 'api', 'admin',
  'settings', 'new', 'import', 'export', 'about', 'help',
  'pricing', 'terms', 'privacy', 'favicon.ico', 'robots.txt',
]);

function isSlugAvailable(slug: string): boolean {
  return !RESERVED_SLUGS.has(slug);
}
```

If a band name slugifies to a reserved word (unlikely but possible — e.g., band called "Dashboard"), the suffix logic kicks in: `dashboard-7x3k`.

### Edit Show

Every config change writes to Supabase (debounced 2s, same as current localStorage pattern). The write uses the Supabase client's `update()` with the show ID. localStorage gets the same write as an offline cache.

**Offline editing (Finding #3 — server timestamps only):** If Supabase is unreachable (gig venue, no wifi), edits accumulate in localStorage. The client stores the `updated_at` value returned from its last successful save. On reconnect:

1. Fetch the show's current `updated_at` from Supabase
2. Compare with the stored last-known `updated_at`
3. If they match → no one else edited → save local version (server sets new `updated_at` via trigger)
4. If they differ → conflict → surface: "This show was edited while you were offline. Keep your version or the remote version?"

All timestamps are server-generated (database trigger). The client never writes `updated_at` — it only reads and compares the values the server returns. This eliminates clock-skew data loss.

### Save semantics

The save operation updates the `config` column plus denormalized fields. The `updated_at` is set by a database trigger, not the client (Finding #3):

```typescript
const { data } = await supabase
  .from('shows')
  .update({
    config: appConfig,
    name: appConfig.showInfo.bandName,   // or showName
    venue: appConfig.showInfo.venue,
    show_date: appConfig.showInfo.eventDate,
    // updated_at is set by moddatetime trigger — never sent from client
  })
  .eq('id', showId)
  .select('updated_at')  // return server timestamp for offline tracking
  .single();

// Cache the server timestamp for offline conflict detection
localStorage.setItem(`showrunr-last-saved-${showId}`, data.updated_at);
```

### Load Show (Slug Resolution — Finding #1)

Anonymous slug lookups go through a Next.js API route, NOT through the browser Supabase client. This prevents table enumeration while still allowing frictionless anonymous viewing.

```
GET showrunr.app/loosely-covered
  → Next.js page calls GET /api/shows/[slug]
  → API route uses service role client (server-side only)
  → Supabase query: select config, charts from shows + charts where slug = 'loosely-covered'
  → Returns show config + chart metadata (public Storage URLs)
  → Client hydrates the app
  → No auth required from the browser — the API route handles the privileged query
```

The API route is a thin read-only proxy. It returns the config and chart list but never exposes the service role key to the browser. Rate-limiting (by IP) prevents abuse.

Latency: Supabase Postgres read is ~50-100ms (similar to Redis, faster than GitHub API).

### My Shows Dashboard

New page: `/dashboard` (authenticated only).

```
GET /dashboard
  → Supabase query: select id, slug, name, venue, show_date, updated_at
      from shows
      where owner_id = auth.uid()
      order by updated_at desc
  → Renders card grid: show name, venue, date, last edited, slug link
  → "New Show" button
  → Each card: open | share | manage collaborators | delete
```

This is the "not bound to one local system" solve. Graham signs in on any device → sees all his shows → opens one → it loads.

### Share Flow

Owner clicks "Share" on a show → modal with:
1. **Slug URL** (copy to clipboard): `showrunr.app/loosely-covered` — anyone can view
2. **Invite collaborator**: email → collaborator signs in via OTP when they open the show *(amended 2026-08-25: was "email + role (editor/viewer)"; §3.3c)*
3. **Current collaborators**: list with remove option

No publish step. The show is always live at its slug URL. Every save is instantly visible to anyone who loads the slug.

---

## Charts: Upload Replaces Drive

### Current Flow (Google Drive — 6 steps)

1. Admin configures Google OAuth credentials (client ID, secret, redirect URI)
2. User authorizes Google account (OAuth consent screen)
3. User creates folder structure in Drive (Charts/ → role subfolders)
4. User names files to match song titles
5. User triggers batch resolution (API calls to Drive)
6. User debugs when song title matching fails

### New Flow (Supabase Storage — 2 steps)

1. On any song in the setlist, click "Add Chart" (or drag-and-drop a file)
2. Pick role from dropdown → file uploads to Supabase Storage → chart row created → done

### Upload UX

**Per-song upload (primary):**

In Setup tab, each setlist song row gets a chart section (expandable or inline):

```
  Valerie                          Rachel    E
  [Charts: Guitar.pdf, Lyrics.pdf]  [+ Add Chart]
```

Click "+ Add Chart" → file picker (accepts `.pdf`, `.png`, `.jpg`) → role dropdown auto-populated from filename if possible ("guitar-chart.pdf" → Guitar) → upload → appears immediately.

Drag-and-drop also works: drop a file onto a song row → same flow, role picker appears.

**Bulk upload (setup day):**

"Upload Charts" button in Setup tab header → drop zone for multiple files → app attempts to match filenames to songs:

```
  guitar-valerie.pdf     → Valerie (Guitar)     [Confirm]
  lyrics-superstition.pdf → Superstition (Lyrics) [Confirm]
  horns-crazy.pdf        → Crazy (Horns)         [Confirm]
  unknown-file.pdf       → [Pick song] [Pick role] [Confirm]
```

Matching uses the same `normalize()` function from the current Drive resolution logic. Unmatched files get manual assignment. One "Upload All" button after review.

**Chart viewer (no change to UX):**

The inline chart viewer (pdf.js, PR #34) works the same way. Instead of fetching from Drive, it loads the Supabase Storage public URL directly. No proxy, no CORS, no token issues.

```typescript
// Before (Drive):
const res = await fetch('/api/drive/download', {
  method: 'POST',
  body: JSON.stringify({ fileId, mimeType }),
});

// After (Supabase Storage):
const url = supabase.storage.from('charts').getPublicUrl(storagePath);
// Load directly in pdf.js — it's a public URL, no proxy needed
```

**Offline caching (no change to UX):**

The "Download Charts for Offline" flow stays the same conceptually. Instead of fetching from Drive via the download proxy, it fetches from Supabase Storage public URLs. Same Cache API, same Service Worker, same offline behavior at the gig.

The cache key changes slightly:
```typescript
// Before: /api/chart-cache/{driveFileId}/{modifiedTime}
// After:  /api/chart-cache/{chartId}/{updatedAt}
// updatedAt comes from the charts table (set by moddatetime trigger — Finding #5)
```

**Collaborator chart upload:**

**⛔ DELETED 2026-08-25 — collaborator chart upload is exactly what the roles ruling removed.** This read: *"An editor collaborator can upload charts to any song in a show they're invited to. Same UX as the owner."* Graham ruled it a bad trade — a collaborator emails the chart to the owner, or becomes an owner themselves (§3.3c). **Only the owner uploads.** The `uploaded_by` column still tracks who added what, and becomes trivially the owner.

### What Gets Deleted (Drive Integration)

| File | Purpose | Replaced By |
|---|---|---|
| `lib/drive.ts` | Drive API query helpers | Supabase Storage client |
| `app/api/drive/route.ts` | Single-song chart resolution | Direct DB query |
| `app/api/drive/batch/route.ts` | Batch chart resolution | Direct DB query |
| `app/api/drive/download/route.ts` | Chart download proxy (CORS + token) | Public Storage URL (no proxy needed) |
| `app/api/auth/google/*` | Google OAuth flow | Supabase Auth |
| Google OAuth env vars | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Supabase env vars |
| `stageplot-google-token` (localStorage) | Google access/refresh tokens | Supabase session |

### Chart Size Limits

Supabase Storage free tier: 1GB total. Typical chart PDF: 50-500KB. A show with 20 songs and 3 charts each = ~30MB. You'd fit 30+ shows before touching the limit. At commercial scale, the Pro plan ($25/mo) gives 100GB.

Upload limit per file: 50MB (Supabase default). More than enough for any chart PDF.

---

## Try-It Mode (AI Codesigner)

### Current: Redis INCR per IP, 10 messages / 30 days

### New: Supabase table

```sql
create table tryit_quota (
  ip_hash text primary key,        -- SHA-256 of IP (don't store raw IPs)
  message_count integer default 0,
  window_start timestamptz default now()
);

-- RLS enabled, but NO policies — table is completely inaccessible to browser clients.
-- Only the admin client (service role) and the security definer function can touch it.
alter table tryit_quota enable row level security;
```

```sql
-- Atomic increment via RPC (R3 Finding #3/6 — hardened)
create or replace function increment_tryit(p_ip_hash text, p_limit integer, p_window_days integer)
returns integer as $$
declare
  current_count integer;
begin
  insert into tryit_quota (ip_hash, message_count, window_start)
  values (p_ip_hash, 1, now())
  on conflict (ip_hash) do update
  set message_count = case
    when tryit_quota.window_start < now() - (p_window_days || ' days')::interval
    then 1  -- reset window
    else tryit_quota.message_count + 1
  end,
  window_start = case
    when tryit_quota.window_start < now() - (p_window_days || ' days')::interval
    then now()
    else tryit_quota.window_start
  end
  returning message_count into current_count;

  return current_count;
end;
$$ language plpgsql security definer;

-- Revoke default execute from public/anon roles — only the service role can call this.
-- The chat API route calls it via the admin client (service role).
revoke execute on function increment_tryit from public, anon, authenticated;
```

**Hardening (R3 Finding #3/6):**
- RLS enabled with no policies → browser clients can't read or write the table directly
- `security definer` on the function is necessary (it writes to a table the caller can't access)
- `revoke execute` ensures only the service role can invoke the function — anonymous/authenticated browser clients can't call it directly via `supabase.rpc()`
- Called exclusively from the server-side chat API route via the admin client

---

## Supabase Project Setup

### Env Vars (Vercel)

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...   # public, safe to expose
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...        # server-side only, never in client
```

### Client Setup

```typescript
// lib/supabase-browser.ts — browser client (uses anon key, respects RLS)
import { createBrowserClient } from '@supabase/ssr';

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// lib/supabase-server.ts — authenticated server client (respects RLS via user session)
// Used for: show CRUD, chart CRUD — operations that should respect row-level security
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function createSupabaseServerClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,  // anon key, NOT service role (Finding #6)
    { cookies: /* Next.js cookie adapter using cookies() */ }
  );
}

// lib/supabase-admin.ts — service role client (bypasses RLS)
// Used ONLY for: anonymous slug lookups, try-it quota, admin operations
// NEVER used in cookie-bound request flows (Finding #6)
import { createClient } from '@supabase/supabase-js';

export function createSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}
```

**Two server clients (Finding #6):** The authenticated server client (`createSupabaseServerClient`) uses the anon key + user's cookie session, so RLS is enforced. The admin client (`createSupabaseAdmin`) uses the service role key and bypasses RLS — used only for isolated operations where no user session exists (anonymous slug lookup, try-it quota). These are never mixed.

### Dependencies

```
npm install @supabase/supabase-js @supabase/ssr
```

Two packages. Replaces `redis` (removed) and all Google auth/Drive packages.

### Free Tier Limits

| Resource | Free Tier | ShowRunr Usage (Year 1) |
|---|---|---|
| Database | 500MB | ~1MB (hundreds of shows as JSONB) |
| Storage | 1GB | ~100MB (thousands of chart PDFs) |
| Auth users | 50,000 MAU | Dozens to hundreds |
| API requests | Unlimited | Low thousands/month |
| Realtime | 200 concurrent | Not used |
| Edge Functions | 500K/month | Not used |

You won't touch these limits before the product generates revenue.

---

## Migration Plan

### Phase 0: Supabase Setup (no code changes)
- Create Supabase project
- Run schema SQL (tables, RLS policies, storage bucket, RPC function)
- Add env vars to Vercel
- Verify connection from local dev

### Phase 1: Shows + Auth + Dashboard
- Add Supabase client (`lib/supabase-browser.ts`, `lib/supabase-server.ts`, `lib/supabase-admin.ts`)
- Auth: sign-in page (6-digit email OTP + optional Google OAuth), session management
- Dashboard: My Shows list, create show, delete show
- Show CRUD: create/load/save shows via Supabase (replaces Redis slug flow)
- Slug resolution: public read from Supabase (replaces `GET /api/show`)
- localStorage becomes offline cache (write-through: save to both Supabase + localStorage)
- Delete Redis slug routes
- Delete admin panel (move remaining config to env vars)

### Phase 2: Charts + Drive Removal
- Chart upload: per-song upload UI, bulk upload, role assignment
- Chart storage: Supabase Storage bucket
- Chart viewer: swap Drive URLs for Storage public URLs (pdf.js unchanged)
- Offline cache: swap Drive download proxy for Storage URLs (Cache API unchanged)
- Delete Google OAuth flow
- Delete Drive API routes
- Delete `lib/drive.ts`
- Remove `redis` package dependency

### Phase 3: Collaborators
- Invite flow: owner enters email → collaborator signs in via OTP when they open the show *(amended 2026-08-25: was "email + role" — there is no role to pick; §3.3c)*
- Collaborator list: show settings panel with add/remove
- RLS enforcement: **all collaborators are read-only** *(amended 2026-08-25: was "editor can update config + upload charts, viewer is read-only" — §3.3c)*
- Collaborator dashboard: shows I'm invited to (separate section on dashboard)
- BYOA key storage: `user_secrets` table + server-side API routes

All three phases can ship as one PR or three — the code doesn't require staging since the old and new systems don't need to coexist (no dual-write migration needed; existing Redis shows are snapshots, not living data).

---

## URL Structure

| URL | Auth | Purpose |
|---|---|---|
| `/` | None | Landing / marketing (future) |
| `/dashboard` | Required (owner) | My Shows list |
| `/{slug}` | None (view) / Required (edit) | Load and use a show |
| `/sign-in` | None | Email OTP / Google sign-in |

The slug moves from a query param (`?show=loosely-covered`) to a path segment (`/loosely-covered`). Cleaner URLs, same behavior. Old `?show=` URLs redirect for backwards compat.

---

## What This Design Intentionally Does NOT Cover

- **Real-time collaboration** — two users editing simultaneously. Out of scope. Supabase Realtime could enable this later, but async collaboration (save and reload) is fine for now.
- **Show versioning / undo** — Supabase doesn't give you git-style history. The YAML export is the backup mechanism. If version history becomes important, we can add a `show_versions` table later.
- **Role-based chart views ("My Charts")** — the existing per-role filter in the Show tab works client-side against the charts list. No backend change needed.
- **Google Drive import** — if users have existing charts on Drive, they'd need to download and re-upload. A "Import from Drive" button could fetch and re-upload in bulk, but that's a convenience feature, not a blocker.
- **Markdown chart normalization** — Phase 3 from the BYOS design doc. Still viable with Supabase Storage (store `.md` files instead of PDFs). Separate design when ready.
- **Multi-provider storage** — Supabase is the one backend. No BYOS provider abstraction needed unless we add alternatives later.

---

## Dependency Changes

### Added
- `@supabase/supabase-js` — Supabase client
- `@supabase/ssr` — Next.js server/client helpers

### Removed
- `redis` — Vercel KV client (no longer needed)
- Google OAuth server-side code (was hand-rolled, not a package)

### Unchanged
- `yaml` — show file serialization
- `pdfjs-dist` — chart viewer
- `@dnd-kit/*` — drag-and-drop
- `@anthropic-ai/sdk` — AI codesigner

Net dependency count: unchanged (add 2, remove 1, but Google OAuth was hand-rolled so effectively add 2, remove 1 package).

---

## Resolved Decisions

1. **Slug namespace:** Globally unique. `showrunr.app/loosely-covered`, not `showrunr.app/graham/loosely-covered`. Cleaner for sharing, correct for commercial use where slug is the show's public identity.

2. **Show deletion:** Manual deletion only. `ON DELETE CASCADE` handles collaborator rows and chart metadata in Postgres. Chart files in Storage are also deleted (application-level cleanup in the delete handler — iterate `charts` rows, delete each Storage object, then delete the show row). No orphan cleanup needed.

3. **BYOA key storage:** Persisted in a dedicated `user_secrets` table (NOT Auth user_metadata — R2 Finding #1). Read/written only via server-side API route. Enables multi-device use — sign in on laptop, sign in on iPad at the gig, key is there. See `user_secrets` table below.

4. **Existing Redis shows:** Let them expire. Near-zero usage in Redis today (dev mode only). No migration needed. Old `?show=` URLs will 404 after Redis TTL — acceptable.

5. **Google Drive import:** Not building. Users re-upload charts manually. The new upload UX is simpler than Drive setup was, so the friction is minimal.

---

## Adversarial Cross-Check (Codex Review — 2 rounds)

### Round 1 (v1.1 → v1.2): 7 findings, all addressed

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **CRITICAL** | RLS `using (true)` on shows/charts exposes full-table enumeration to anonymous clients | Anonymous slug lookups moved to a Next.js API route using the service role admin client server-side. RLS on `shows` and `charts` now scoped to owner + collaborators only. No anonymous browser-to-Supabase queries. |
| 2 | **CRITICAL** | Storage write security underspecified — any authenticated user could write to any path | Chart uploads go through a server-side API route that validates **ownership**, constructs the Storage path server-side, and uploads using the service role key. Browser never writes to Storage directly. *(Amended 2026-08-25: was "ownership/editor role"; §3.3c.)* |
| 3 | **HIGH** | `updated_at` set from client clock — clock skew can lose data in offline merge | `updated_at` now set by database trigger (`moddatetime`), never by client. Save operation returns server timestamp via `.select('updated_at')`. Offline conflict detection compares server-issued timestamps only. |
| 4 | **HIGH** | Chart linkage on `song_title` is brittle — titles are mutable and can repeat | Charts now link via `song_id` (stable UUID from `withStableIds()`). With Supabase as primary storage, song IDs are persisted and never regenerated. Unique constraint is `(show_id, song_id, role)`. |
| 5 | **HIGH** | Cache invalidation key references `updatedAt` but charts table had no such column | Added `updated_at` column to charts table with `moddatetime` trigger. Cache key is `{chartId}/{updatedAt}`. |
| 6 | **MEDIUM** | Server client example used service role key in a cookie-bound client, risking RLS bypass | Split into two server clients: `createSupabaseServerClient()` (anon key + cookie session, RLS enforced) for authenticated operations, and `createSupabaseAdmin()` (service role, no cookies) for isolated admin ops only. |
| 7 | **MEDIUM** | Collaborator table RLS policies were missing entirely | Added explicit policies: owner can CRUD collaborator rows for their shows, collaborators can read their own invite rows. |

Codex also recommended auto-cleanup on show deletion (vs. lazy orphaning). Agreed — delete handler removes Storage objects first, then the show row cascades in Postgres.

### Round 2 (v1.2 → v1.3): 4 findings, all addressed

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R2-1 | **CRITICAL** | BYOA key in Auth `user_metadata` is exposed in JWTs and client-accessible surfaces | Moved to dedicated `user_secrets` table with strict RLS. Key is only ever read/written via server-side API routes. Never in JWTs, never in client metadata. |
| R2-2 | **HIGH** | Editor tier description ("upload charts + edit notes") doesn't match RLS policy (full config UPDATE) | ~~Corrected tier table: editors have full show editing access.~~ **SUPERSEDED 2026-08-25** — the Editor tier is deleted outright; collaborators are view-only (`design-single-backend.md` §3.3c). This round-2 resolution reconciled the doc to the RLS by widening the doc; the ruling instead removes both. |
| R2-3 | **HIGH** | Song ID stability conflicts with YAML export (currently strips IDs) — re-import orphans chart linkage | YAML format bumped to `showrunr/v2` — includes `id` field in setlist entries. IDs preserved on round-trip. Legacy v1 imports still work (IDs regenerated, charts require manual re-association). |
| R2-4 | **MEDIUM** | Slug collisions with static routes (`/dashboard`, `/sign-in`) not handled | Added `RESERVED_SLUGS` blocklist enforced at creation time. Colliding names get the standard random suffix appended. |

### Round 3 (v1.3 → v1.4): 3 unique findings (6 reported, 3 were duplicates), all addressed

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R3-1 | **CRITICAL** | RLS policies defined but `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` never called — policies won't protect data | Added `alter table ... enable row level security` to all 5 tables: `shows`, `show_collaborators`, `user_secrets`, `charts`, `tryit_quota`. |
| R3-2 | **HIGH** | Collaborator invite activation unspecified — policies check `user_id` but no flow sets `user_id`/`accepted_at` on the `show_collaborators` row after OTP sign-in | Added explicit activation flow: `POST /api/auth/activate-invites` runs after OTP verification, uses admin client to `UPDATE show_collaborators SET user_id, accepted_at WHERE email matches`. Idempotent, runs once at sign-in. |
| R3-3 | **HIGH** | `increment_tryit` is `security definer` with default execute privileges — any browser client could call it via `supabase.rpc()` | Added `REVOKE EXECUTE ... FROM public, anon, authenticated`. RLS enabled on `tryit_quota` with no policies (table inaccessible to browser clients). Only admin client can invoke. |
| R3-4 | **MEDIUM** | `user_secrets` SELECT policy allows browser client to read API key, contradicting "server-only" claim | Removed SELECT policy entirely. RLS with no SELECT policy = browser reads blocked. Admin client (service role) reads the key server-side for chat requests. |
| R3-5 | **LOW** | Stale "magic link" references in share flow and URL structure sections | Updated to "OTP" / "Email OTP" consistently. |
