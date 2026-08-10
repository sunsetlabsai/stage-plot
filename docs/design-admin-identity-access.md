# Design — Admin identity, invite gate, tester deletion, and profiles read scope

Status: **DESIGN — Codex R2 folded, awaiting R3**
Version: **v3.1** (v1 = pre-Codex, v2 = R1, v3 = R2)
Scope: admin authn/authz, signup gating, tester deletion, `profiles` RLS
Driver: handing ShowRunr to outside UAT testers

**v2 changelog** — all three Codex R1 blockers folded, plus Graham's addition:

| Change | Source |
|---|---|
| §4 rewritten — the invite gate now covers the authenticated **API** surface. v1's "no app access" claim was **wrong**. | Codex R1 blocker 1 |
| §3.4 rewritten — **no admin DB check in middleware.** Server-component gate instead. Codex's runtime premise was stale for Next 16; the conclusion still lands. | Codex R1 blocker 2 |
| §3.3 rewritten — bootstrap is a **seeded migration on an exact user id**. The "empty table" rule is deleted. | Codex R1 blocker 3 + non-blocking 1 |
| **§6 NEW** — delete a tester. Uncovered a schema bug: deletion fails today. | Graham, 2026-08-10 |
| §5 `allowed_emails` CHECK constraint | Codex R1 non-blocking 2 |
| §3.6 audit moved **into scope** | Codex R1 non-blocking 5 |
| §8 profileless/direct-API regression tests | Codex R1 non-blocking 4 |
| §9 migration `004` resolved — it never existed | Graham asked; verified |

**v3 changelog:**

| Change | Source |
|---|---|
| §4.2 — `activate-invites` **removed** from the `requireAppUser` list; gated on eligibility instead, and also re-run after profile creation. v2 would have broken legitimate onboarding. | Codex R2 **blocking** |
| §3.1 / §3.6 / §5 — the three `auth.users` references this design **itself introduced** are now `ON DELETE SET NULL`; audit gains `actor_email` + target snapshots | Codex R2 high |
| §6.2 — deletion counts distinguish **attempted vs succeeded** storage removals | Codex R2 condition on hard delete |
| §3.3 — seed **both** Graham accounts if both should be admin; no runtime bootstrap | Codex R2 answer |

**v3.1:** §3.3 pre-build gate **resolved** — Graham, 2026-08-10: the platform
owner is **`graham.edwards@gmail.com`**, seeded as the sole bootstrap admin.
Raised two consequences of that choice which need checking before the migration
runs (profile existence vs the `/claim` redirect; the stale `seed_profiles.sql`
placeholder UUIDs).

---

## 1. Current state, stated plainly

**There is no role concept in ShowRunr.** `profiles` has four columns
(`005_owner_namespacing.sql:5-10`): `id`, `owner_slug`, `display_name`,
`created_at`. No `is_admin`, no `role`, no `plan`, no status. The `role` columns
that exist are unrelated — `show_collaborators.role` is `'editor'|'viewer'`
(`001_initial_schema.sql:34-43`) and `chart_library.role` is an *instrument*.

"Admin" is one shared string:

```ts
// lib/admin-rate-limit.ts:23-28
export function authenticate(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const provided = request.headers.get('authorization')?.replace('Bearer ', '');
  return !!provided && provided === secret;
}
```

| # | Fact | Why it matters at UAT |
|---|---|---|
| 1 | No admin *identity* | Every admin action is anonymous. No audit, no revoke short of rotating the secret for everyone. |
| 2 | `===` string compare | Timing-attackable. Minor next to (1), free to fix. |
| 3 | `/admin` has **no server gate** | `middleware.ts:63-71` gates only `/dashboard` and `/library`. `authenticated` is React state (`app/admin/page.tsx:22`) flipped after a 200 from `/api/admin/owners`. Shell renders for anyone. |
| 4 | Rate limit is a process-local `Map` (`lib/admin-rate-limit.ts:5`) | Resets on cold start, not shared across instances. |
| 5 | `pathname === '/dashboard'` | Exact equality. Any future sub-route is unauthenticated by default. |
| 6 | Sign-in **is** sign-up (`app/sign-in/page.tsx:34`) | Any email that receives a code gets an `auth.users` row. |
| 7 | `"Public read" ON profiles FOR SELECT USING (true)` (`005:13`) | Every user's auth UUID, slug, display name, join date is anon-enumerable. |
| 8 | Owner list is read-only | No way to disable, delete, or assist a tester. |

---

## 2. Decisions taken

Graham, 2026-08-10: **real admin identity** checked against the Supabase session;
`/admin` becomes a signed-in page; shared secret retired for the UI, kept for
migration endpoints. **Invite/allowlist gate** for the UAT window.
**Tester deletion is in scope** (added after Codex R1 — §6).

---

## 3. Admin identity

### 3.1 A separate table, not a column on `profiles`

**Do not add `profiles.is_admin`.** `005_owner_namespacing.sql:14` is:

```sql
CREATE POLICY "Owner manage" ON profiles FOR ALL USING (auth.uid() = id);
```

`FOR ALL`, no column restriction — any authenticated user can `UPDATE` their own
`profiles` row. Add `is_admin` there and **every user can grant themselves admin
with one anon-key request.** RLS has no column-level grant inside a policy.

```sql
-- 013_admin_users.sql
CREATE TABLE admin_users (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note       text
);
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
-- No policies. service_role only, per the tryit_quota precedent (001:88-89).
```

RLS on with zero policies = no anon/authenticated access. Existing pattern:
`tryit_quota` (`001:88-89`), `setlist_entries` (`006_songs.sql:55-60`).

Codex R1 concurred: *"Separate admin_users table is the right call."*

### 3.2 `requireAdmin()` — route handlers only

**New `lib/admin-auth.ts`:**

```ts
export async function requireAdmin(): Promise<
  { ok: true; user: User } | { ok: false; status: 401 | 403 }
>
```

Session via `getSupabaseServer()` → `getUser()`; membership via a service-role
`admin_users` lookup. 401 signed out, 403 signed in but not admin.

**This is a route-handler and server-component helper. It is never imported into
middleware** — see §3.4.

| Endpoint | After |
|---|---|
| `GET/PUT /api/admin/settings` | `requireAdmin()` **only**. Secret rejected. |
| `GET /api/admin/owners` | `requireAdmin()` **only**. |
| `DELETE /api/admin/users/[id]` (new, §6) | `requireAdmin()` **only**. |
| `POST /api/admin/migrate-setlists` | `requireAdmin()` **or** `ADMIN_SECRET`. |
| `POST /api/admin/backfill-chart-overlays` | `requireAdmin()` **or** `ADMIN_SECRET`. |

The two migration endpoints keep the secret because they are one-shot chores run
from a terminal, sometimes when the UI is what is broken. Where the secret
survives, the compare becomes constant-time (`crypto.timingSafeEqual` over
equal-length buffers, with a length pre-check that does not early-return on
content).

`app/admin/page.tsx` loses `handleLogin` (`:37-80`) and the `secret` state.

### 3.3 Bootstrap — seeded migration, exact user id

**v1 was wrong.** It hung bootstrap off the existing
`POST /api/auth/activate-invites` call, and Codex correctly showed that path is
fire-and-forget in both directions: `app/sign-in/page.tsx:62-63` ignores the
response and redirects regardless, and
`app/api/auth/activate-invites/route.ts:14` ignores RPC errors. First-admin
creation there can fail silently and leave `/admin` permanently unreachable.

v1's "insert only while `admin_users` is empty" rule is also **deleted**. It was
race-prone across concurrent sign-ins and — worse — it *reopens* if the last
admin is ever removed, turning an env var back into a live grant path at exactly
the moment nobody is watching.

**v2 spec — no runtime bootstrap path at all:**

```sql
-- 013_admin_users.sql (continued)
INSERT INTO admin_users (user_id, note)
SELECT id, 'bootstrap: platform owner'
FROM auth.users
WHERE lower(email) = 'graham.edwards@gmail.com'
ON CONFLICT (user_id) DO NOTHING;
```

`ADMIN_BOOTSTRAP_EMAILS` is not built. There is no code path that grants admin
from configuration. After the seed, membership changes only through an
admin-authenticated action, which is audited (§3.6).

**★ RESOLVED — Graham, 2026-08-10: `graham.edwards@gmail.com`.**

That is the seeded platform owner and the **only** admin at bootstrap.
`graham@salonhq.co` (this repo's git identity) is **not** seeded. If it turns out
to be a separate account that also needs admin, it is granted through the normal
admin-authenticated path and audited (§3.6) — that is exactly why no runtime
bootstrap exists to fall back on.

Verify the account resolves before running the migration:

```sql
SELECT u.id, u.email, p.owner_slug
FROM auth.users u LEFT JOIN profiles p ON p.id = u.id
WHERE lower(u.email) = 'graham.edwards@gmail.com';
```

Two things this query also settles, both of which matter and neither of which I
can check from here (the local `SUPABASE_SERVICE_ROLE_KEY` returns 401):

- **Does the account have a `profiles` row?** If `owner_slug` is null, the first
  `/admin` visit will be intercepted by the profile-completeness redirect
  (`middleware.ts:74-92`) and bounce to `/claim` before the admin layout ever
  runs. Admin would appear broken for the one account that must not be. Claim a
  handle first, or the §3.4 gate needs to exempt `/admin` from that redirect.
- **Is it the `graham` handle in `supabase/seeds/seed_profiles.sql`?** That seed
  carries placeholder UUIDs, so it may point at a different account entirely.

If the migration's `SELECT` matches zero rows it inserts nothing **silently** —
the exact failure mode Codex flagged. Guard it with an exact count, so a typo
fails loudly rather than yielding an admin-less deployment:

```sql
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM admin_users;
  IF n <> 1 THEN
    RAISE EXCEPTION 'admin bootstrap expected exactly 1 admin, found %', n;
  END IF;
END $$;
```

Note [[feedback_neon_sql_editor_do_blocks]] — that guard is a `DO $$..$$` block.
It is fine via the Supabase CLI/migration runner but will break if pasted into an
editor that splits on `;`. Run this migration through the CLI, not by hand.

### 3.4 Gating `/admin` — server component, not middleware

Codex R1 blocker 2 said the design specified a DB-backed admin check in
middleware while `requireAdmin()` is route-handler-shaped, and that middleware
defaults to Edge. **The conclusion is right and the fix is bigger than a runtime
flag. The cited constraint is also stale for this repo** — worth stating so the
next reviewer doesn't re-derive it from the wrong docs.

This repo runs **Next 16.2.6**. Per the bundled docs (`AGENTS.md` requires
reading these rather than nextjs.org):

- `middleware` is **deprecated and renamed to `proxy`**
  (`01-app/02-guides/upgrading/version-16.md:625-627`).
- *"The `edge` runtime is **NOT** supported in `proxy`. The `proxy` runtime is
  `nodejs`, and it cannot be configured."* (`version-16.md:629`)
- And decisively, the Next 16 authentication guide
  (`01-app/02-guides/authentication.md:1031`): *"since Proxy runs on every route,
  including prefetched routes, it's important to only read the session from the
  cookie (optimistic checks), and **avoid database checks to prevent performance
  issues**."*

So the answer is not "pick a runtime for the admin lookup." It is **do not put
the admin lookup in middleware at all.**

**v2 spec:**

- **Authoritative gate:** new server component `app/admin/layout.tsx` calls
  `requireAdmin()` and, on failure, `notFound()` for a signed-in non-admin or
  `redirect('/sign-in?redirect=/admin')` for a signed-out visitor. `notFound()`
  renders the real 404 — no separate rewrite needed, and it does not confirm that
  `/admin` exists. `app/admin/page.tsx` stays a client component, rendered inside
  that layout.
- **`/admin` joins `PROFILE_CHECK_EXEMPT`** (`middleware.ts:19-21`). *Added in
  v3.1.* The profile-completeness redirect (`:74-92`) fires on every non-exempt
  path, so an admin without a `profiles` row would be bounced to `/claim` before
  the admin layout ever ran — admin unreachable for the one account that must
  never lose access. One line, and it removes a whole class of lockout
  independent of whether the seeded account happens to have claimed a handle.
  Note this is safe precisely because the layout gate (above) is authoritative:
  exempting a path from the *profile* redirect does not exempt it from the
  *admin* check.
- **Middleware keeps only optimistic checks:** session-cookie presence for
  `/dashboard`, `/library`, `/admin`. No `admin_users` query.
- Fix item (5) in the same pass: prefix matching instead of `===`, and carry the
  actual requested path instead of the hardcoded `redirect=/dashboard`
  (`middleware.ts:68`).

**Pre-existing debt, flagged not fixed:** `middleware.ts:74-92` already does a
`profiles` **database select on essentially every navigation**, plus up to three
`getUser()` calls (`:49, :64, :78`) — precisely what `authentication.md:1031`
warns against. And the repo is still on the deprecated `middleware` convention;
a codemod exists (`npx @next/codemod@canary middleware-to-proxy .`). Both are
real cleanups. **Neither is in this scope** — flagged so they read as known, not
missed.

### 3.5 Rate limiting

Move admin auth-attempt limiting to Redis (`REDIS_URL` exists in production),
same INCR+EXPIRE shape as `consumeTryitQuota`
(`app/api/agent/chat/route.ts:37-70`), keeping the in-memory `Map` as fallback.
Matters less once the secret is retired for the UI — brute force then targets
Supabase Auth — but the two migration endpoints still take a secret.

### 3.6 Audit — in scope (was optional in v1)

Codex R1: *"Audit should be in scope for the first real admin identity pass.
Otherwise the design removes the shared secret but still misses one of the main
reasons for doing identity."* Agreed; promoted.

```sql
-- 013_admin_users.sql (continued)
CREATE TABLE admin_audit (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text NOT NULL,          -- snapshot; survives actor deletion
  action      text NOT NULL,
  target      text,                   -- snapshot: target email / owner_slug
  meta        jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admin_audit ENABLE ROW LEVEL SECURITY;
-- No policies. service_role only.
```

**Snapshots are not redundant with `actor_id`** (Codex R2 high). With
`ON DELETE SET NULL`, deleting a former admin nulls their `actor_id` across the
whole audit trail — and an audit log that says *"someone deleted a user"* is not
an audit log. `actor_email` and a `target` snapshot are denormalized on purpose
so the record survives deletion of either party. Same reasoning applies to
`meta`: it carries the target's `owner_slug` and the deletion counts (§6.2), none
of which are recoverable afterwards.

Written on: settings change (key names only, **never values**), admin
grant/revoke, allowlist add/remove, **tester deletion** (§6). Read-only panel on
`/admin`, newest first.

---

## 4. Invite gate — the authenticated API surface, not just `/claim`

### 4.1 What v1 got wrong

v1 claimed that gating `POST /api/profiles` meant a refused tester "cannot reach
any show, dashboard, or library." **That was overclaimed.** Codex R1 blocker 1,
verified:

- `middleware.ts:99` excludes `api` from the matcher entirely, and
  `middleware.ts:75` additionally skips `/api/*` in the profile check. **No API
  route is ever touched by middleware.** The `/claim` redirect is a browser-
  navigation redirect only.
- Authenticated API routes authorize from `auth.users.id`, not from profile
  existence. `app/api/shows/route.ts:28` does `profile?.owner_slug || ''` — it
  **does not 401 a profileless user**.
- `activate_invites` (`001_initial_schema.sql:262-271`) links
  `show_collaborators` rows to any signed-in user whose **email matches**,
  regardless of allowlist. A refused tester who was previously invited to a show
  can therefore reach collaborator data through the API.

So v1 gated the front door and left the API open.

### 4.2 Where the gate can actually be enforced

`supabase.auth.signInWithOtp()` goes **browser → Supabase** directly
(`app/sign-in/page.tsx:34`); our server is not in that path, so app code cannot
prevent `auth.users` creation.

**v2 spec — defence in depth, all three layers:**

**(a) Application authorization gate — the enforceable core.**
New `lib/require-app-user.ts`:

```ts
export async function requireAppUser(): Promise<
  { ok: true; user: User; profile: Profile } | { ok: false; status: 401 | 403 }
>
```

Returns 403 when the signed-in user **has no `profiles` row**. Applied to the
13 data routes that currently do `getUser()` → 401:
`api/shows`, `api/shows/update`, `api/shows/delete`, `api/songs`,
`api/songs/update`, `api/songs/delete`, `api/charts/upload`, `api/charts/delete`,
`api/charts/convert`, `api/charts/calibration`, `api/charts/roadmap/save`,
`api/charts/roadmap/parse`, `api/charts/roadmap/[chartId]`.

"Has a profile" is the right predicate rather than "is allowlisted": existing
users predate the allowlist and must not be locked out, and profile creation is
already gated by the allowlist, so *no profile* ⇒ *never admitted*.

**Two routes are deliberately excluded** — both run *before* a profile exists:

- `POST /api/profiles` — the create path itself. Keeps its own allowlist check.
- `POST /api/auth/activate-invites` — see (b). **v2 listed this under
  `requireAppUser` and that was a blocking error**; the correction is below.

**(b) Invite activation — eligibility, not profile existence.**

*Fixed in v3. Codex R2 blocking, and it was right: v2 both required
`requireAppUser` on `activate-invites` **and** required that route to run for
brand-new testers. Those cannot both hold.* The route is called immediately after
OTP (`app/sign-in/page.tsx:63`), before `/claim` — so a legitimate, allowlisted,
invited tester would have had invite activation 403 on first sign-in, then claim
a profile, and find their collaborator rows **never linked**. Silent, permanent,
and it would have hit exactly the people we most want onboarding smoothly.

The predicate for this one route is **eligibility**:

> signed in **AND** ( has a profile **OR** `signup_mode = 'open'` **OR** email is
> on the allowlist )

which admits the new invited tester and still closes the §4.1 back-channel for a
refused one.

**Belt and braces: activation also runs after successful profile creation.**
`POST /api/profiles` calls the same activation logic on success, so a tester
whose first-sign-in activation failed for any reason — network, cold start, the
fire-and-forget client call at `app/sign-in/page.tsx:62-63` that ignores its own
response — still gets linked when they claim. Activation is already idempotent
(`activate_invites` matches unlinked rows by email, `001:262-271`), so running it
twice is safe. This removes the dependency on a client call that nobody checks.

**(c) Supabase-side block.** Either the **Before User Created** auth hook or
disabling signups in the Supabase dashboard for the UAT window. This is the only
layer that stops `auth.users` rows being created at all, and it lives outside
this repo. **Configuration task, not code** — but it is what makes (a) and (b)
belt-and-braces rather than the sole defence. Recorded here so it is not lost.

`POST /api/profiles` (`app/api/profiles/route.ts:13-68`) keeps the allowlist
check for profile creation, with the friendly `/claim` copy: *"ShowRunr is in
private testing. <email> isn't on the tester list — ask Graham to add you."*

**Accepted residue:** orphan `auth.users` rows for refused testers. They hold a
session, can call APIs, and get a 403 from every one. They are invisible in
`/admin`, which lists `profiles`. Acceptable for a UAT window; (c) is the real
fix.

### 4.3 Mode switch

`signup_mode` in the existing admin-config store — Redis `admin:signup_mode`,
env `SIGNUP_MODE` fallback, values `open` | `invite`, **default `open`**. Reuses
`getAdminConfig`/`setAdminConfig` (`lib/admin-config.ts:27-51`); add to the
allowlist at `app/api/admin/settings/route.ts:52` and the key list at
`lib/admin-config.ts:57`. **Mechanism EXISTS** — no new storage.

Inherited trap: `setAdminConfig` writes the `__DISABLED__` sentinel for an empty
value (`:50`) and `getAdminConfig` maps it back to `null` (`:32`). Write
`signup_mode` as an explicit literal, never `''`; the reader treats `null` as
`open`.

Note the interaction with §4.2(a): `requireAppUser` returns 403 for a
profileless user **regardless of mode**. That is intentional — a user with no
profile has nothing to authorize against — and it means flipping back to `open`
does not retroactively admit anyone who never claimed a handle.

---

## 5. Allowlist table

```sql
-- 014_signup_allowlist.sql
CREATE TABLE allowed_emails (
  email      text PRIMARY KEY CHECK (email = lower(btrim(email))),
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  note       text
);
ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;
-- No policies. service_role only.
```

The `CHECK` is Codex R1 non-blocking 2 — normalization enforced at the DB layer,
not only in app code. Application still normalizes on write and on compare;
the constraint makes a bypass impossible rather than unlikely.

Gmail dot/plus aliasing is deliberately **not** normalized — provider-specific
and surprising. Testers use the exact address they were invited at.

Admin UI: a `/admin` section to add, list, and remove, with the note field.
Removal does not revoke an existing profile — it only prevents future claims.
The UI must say so.

---

## 6. Delete a tester (NEW — Graham, 2026-08-10)

### 6.1 It does not work today, and would not work if written naively

`profiles` (`005:6`), `user_secrets` (`001:50`), and `songs` (`006:8`) are
`ON DELETE CASCADE`. **`shows.owner_id` (`001:14`) and `chart_library.owner_id`
(`003:18`) are not** — plain `references auth.users(id)`, no action clause,
so `NO ACTION`.

Therefore `auth.admin.deleteUser(id)` on any tester who has ever created a show
**fails with a foreign-key violation.** A naive implementation ships, works on an
empty test account, and fails on every real one.

`show_collaborators.user_id` (`001:37`) and `charts.uploaded_by` (`001:68`) are
also plain references — nullable, so they block deletion too until cleared.

### 6.2 Two ways forward

**(a) Add the missing cascades** in migration `015`:

```sql
ALTER TABLE shows DROP CONSTRAINT shows_owner_id_fkey,
  ADD CONSTRAINT shows_owner_id_fkey FOREIGN KEY (owner_id)
    REFERENCES auth.users(id) ON DELETE CASCADE;
-- likewise chart_library.owner_id
-- show_collaborators.user_id and charts.uploaded_by → ON DELETE SET NULL
```

**Every `auth.users` reference in the schema must be audited, including the ones
this design adds.** Codex R2 high: v2 repaired the *pre-existing* FKs and then
introduced three new unqualified references of its own — `admin_users.granted_by`,
`allowed_emails.invited_by`, `admin_audit.actor_id` — any of which would
re-break deletion the moment the target had ever granted admin, invited a tester,
or performed an audited action. All three are now `ON DELETE SET NULL` (§3.1,
§3.6, §5), with snapshot columns so the audit trail survives (§3.6).

Complete list after this design, as the state deletion must satisfy:

| Reference | Action |
|---|---|
| `profiles.id`, `songs.owner_id`, `user_secrets.user_id` | CASCADE *(already correct)* |
| `shows.owner_id`, `chart_library.owner_id` | CASCADE *(repaired here)* |
| `show_collaborators.user_id`, `charts.uploaded_by` | SET NULL *(repaired here)* |
| `admin_users.user_id` | CASCADE *(new)* |
| `admin_users.granted_by`, `allowed_emails.invited_by`, `admin_audit.actor_id` | SET NULL *(new)* |

A test that deletes a user who is simultaneously a show owner, a collaborator, an
inviter, an admin grantor, and an audit actor is the only way to know this list
is complete — test 16 in §8.

**(b) Explicit ordered deletion** in the route, inside one transaction.

**Recommendation: (a) for the FK repair, (b) for storage.** The cascades fix a
latent schema bug that will bite regardless of this feature, and they are the
only way to make deletion atomic. But **Supabase Storage objects are not in
Postgres FK graph** — chart files uploaded via `app/api/charts/upload` must be
removed explicitly, and a cascade will silently orphan them. So:

1. **Count** the user's shows, songs, chart_library rows, and storage objects
   **before** deleting anything, and hold the target's email + `owner_slug`.
2. Enumerate the user's storage objects, delete them, **recording how many
   actually succeeded** — not how many were attempted.
3. `auth.admin.deleteUser(id)` — cascades handle every table.
4. Audit row (§3.6) with actor, target email + slug snapshots, and the counts
   from step 1 plus the storage success count from step 2.

Codex R2 made hard delete conditional on *"storage deletion is count-audited"* —
step 2's distinction between attempted and succeeded is that condition. If the
two disagree, the audit row records both and the operation still reports success
for the account; a partial storage failure must be visible after the fact, since
by then it is the only remaining evidence.

Storage deletion is **not transactional with the DB delete**. If step 1 partially
succeeds and step 2 fails, files are gone and the account remains. Order chosen
deliberately: orphaned *account* is recoverable, orphaned *files* are invisible
and bill forever. Say this in the doc rather than pretending it is atomic.

### 6.3 Endpoint and UX

`DELETE /api/admin/users/[id]` — `requireAdmin()` only. Guards:

- **Cannot delete yourself.** Hard 400, checked before anything else.
- **Cannot delete another admin** unless their `admin_users` row is revoked
  first. Prevents a one-click lockout of the platform.
- Requires a confirmation body echoing the target's email — the same shape as a
  "type the name to confirm" dialog, enforced server-side rather than trusting
  the client.

UI: a `Delete` action per row in the existing owners table
(`app/admin/page.tsx:206-252`), opening a modal that names what will be destroyed
(*"N shows, N songs, N charts — permanently"*) and requires typing the email.

**This is irreversible and destroys another person's work.** It is the most
dangerous thing in this document. It should ship with the audit row (§3.6) and
not before.

---

## 7. `profiles` read scope

**Who actually depends on the public policy** — every `.from('profiles')` call:

| Call site | Client | Needs the public policy? |
|---|---|---|
| `middleware.ts:81` | user session, own row | No |
| `app/api/profiles/route.ts:42,52,81` | user session, own row | No |
| `app/api/shows/route.ts:28` | user session, own row | No |
| `app/api/admin/owners/route.ts:19` | **service role** | No |
| `app/api/shows/[owner]/[show]/route.ts:65` | **service role** (`:61`) | No |
| **`app/api/shows/route.ts:58`** | **user session, *other* users' rows** | **YES — the only one** |

```sql
-- 016_profiles_read_scope.sql
DROP POLICY "Public read" ON profiles;
CREATE POLICY "Self read" ON profiles FOR SELECT USING (auth.uid() = id);
```

and switch `app/api/shows/route.ts:54-62` to the service-role client for that one
collaborator-slug lookup. `collabOwnerIds` is already derived from the caller's
own collaborator rows, so it is a narrow, justified service-role use.

Also make the write policy explicit: `"Owner manage" ... FOR ALL USING
(auth.uid() = id)` has no `WITH CHECK`. Postgres falls back to `USING` for
`FOR ALL`, so it is safe today — but §3.1 shows what an implicit write policy on
this table costs the moment a column is added.

**Ordering:** the RLS change must ship in the **same deploy** as the
`app/api/shows/route.ts` edit, or the collaborator dashboard silently drops owner
slugs. Pinned by test 15 in §8.

---

## 8. Tests

Server:

1. `requireAdmin` → 401 signed out, 403 non-admin, ok for admin.
2. Retired endpoints reject a valid `ADMIN_SECRET` (the point of the change).
3. Migration endpoints accept **either** admin session or secret.
4. Constant-time compare rejects wrong-length and wrong-content.
5. **Bootstrap migration raises when the email matches no user** (§3.3 guard).
6. `signup_mode='invite'`: `POST /api/profiles` 403s non-allowlisted, succeeds
   allowlisted, case/whitespace-insensitive.
7. `signup_mode='open'` (and `null`) ignores the allowlist.
8. Allowlist removal does not affect an existing profile.
9. `allowed_emails` CHECK rejects `'A@B.com '` at the DB layer.

**Codex R1 blocker-1 regressions — the ones that matter most:**

10. A signed-in user with **no profile** gets 403 from `/api/shows`,
    `/api/songs`, `/api/charts/upload` called **directly**, bypassing any
    browser navigation.
11. `activate-invites` does **not** link collaborator rows for a
    non-allowlisted email when `signup_mode='invite'`.
12. A refused tester holding a valid session cannot read a show they were
    previously invited to.

**Codex R2 blocker — legitimate onboarding must not regress:**

12a. **An allowlisted, profileless invitee signs in, activation succeeds, they
     claim a handle, and the collaborated show appears on their dashboard.** The
     full happy path, end to end. This is the exact flow v2 would have broken.
12b. Activation run twice (once at sign-in, once after profile creation) links
     each collaborator row exactly once — idempotence, since §4.2(b) now calls it
     from both places.
12c. Activation succeeds for a profileless user when `signup_mode='open'`.

Middleware / gate:

13. `/admin` signed out → `/sign-in?redirect=/admin`; signed-in non-admin → 404.
13a. An admin **with no `profiles` row** reaches `/admin` and is **not** redirected
     to `/claim` (§3.4 exemption) — while a non-admin with no profile still is.
14. `/dashboard/anything` is gated (the `===` regression); redirect target
    reflects the requested path.

RLS:

15. Anon `select * from profiles` returns 0 rows; authenticated reads own row
    only; **collaborator dashboard still resolves owner slugs** (the §7 ordering
    risk).

Deletion:

16. **Deleting a user who is simultaneously a show owner, a collaborator on
    someone else's show, an `allowed_emails.invited_by`, an
    `admin_users.granted_by`, and an `admin_audit.actor_id` succeeds.** One test
    covering the whole §6.2 reference table — the only way to prove the list is
    complete rather than merely long.
17. Self-delete refused; admin-delete-admin refused; wrong confirmation email
    refused.
18. Storage objects are removed; the audit row records counts, and records
    **attempted vs succeeded** separately when a storage delete fails.
19. After deleting a former admin, their `admin_audit` rows survive with
    `actor_id` null and `actor_email` intact — the audit trail is not erased by
    the deletion it recorded.

Target: **~22 new tests.** Delta reported on the build PR.

---

## 9. Migration `004` — resolved

**It never existed in this repo.** Verified:

- `git log --all --diff-filter=A -- 'supabase/migrations/004*'` returns nothing —
  no such file was ever committed on any branch.
- Zero references to a `feedback` table in `supabase/`, `docs/`, or any `.ts`/
  `.tsx` file.

`project_showbible` memory recorded a "004 feedback" migration; that note is
wrong, or describes something applied directly in the Supabase dashboard and
never captured here. Either way there is nothing to migrate and nothing to
recover. (A live-schema confirmation was attempted and could not be completed —
the `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` returns 401, so it appears stale
or rotated. Worth refreshing locally, separately.)

**Resolution, per Graham:** treat `004` as closed. The numbering simply skips it.
This design claims `013` onward.

---

## 10. Not built here

- No read-only impersonation / "view as tester" to help debug a tester's show.
  Deletion (§6) is in; assistance is not. I expect this to be wanted next.
- No search/pagination on the owners list. `listUsers({ page: 1, perPage: 1000 })`
  (`app/api/admin/owners/route.ts:46-49`) silently truncates at 1000 and renders
  a blank email for #1001. Fine at UAT scale, a landmine later.
- No feedback-capture surface (§9 — there never was one).
- `plan`/billing columns from `docs/design-payments.md:144` remain unbuilt.
- The `middleware` → `proxy` migration and the per-navigation `profiles` query
  (§3.4) — real debt, deliberately out of scope.

---

## 10a. Codex R2 — disposition

| Finding | Disposition |
|---|---|
| **Blocking** — `activate-invites` caught in the profile gate | **Accepted; this was a self-contradiction in v2.** §4.2(a) put the route behind `requireAppUser` while §4.2(b) required it to run for brand-new testers. Both could not hold, and the failure was silent and permanent: an allowlisted invitee's collaborator rows would never link. Now gated on **eligibility** (profile OR open-mode OR allowlisted), **and** re-run after profile creation so it no longer depends on a fire-and-forget client call. Tests 12a–12c. |
| **High** — FK holes in the tables this design adds | **Accepted.** `admin_users.granted_by`, `allowed_emails.invited_by`, `admin_audit.actor_id` → `ON DELETE SET NULL`; audit gains `actor_email` and target snapshots so the trail survives. Sharp catch: v2 repaired the pre-existing FKs and then introduced three new ones with the same defect. §6.2 now carries the complete reference table, and test 16 exercises a user occupying every role at once. |
| Hard delete OK **if** FK holes closed and storage count-audited | Both conditions met — §6.2 step 2 distinguishes attempted from succeeded, test 18 asserts it. |
| Seed both accounts if both should be admin; no runtime bootstrap | **Accepted** (§3.3) — wider `IN` clause, guard asserts the expected count. |

## 11. Open questions for Codex R3

1. **§4.2(b)** is the new material and deserves the attack. The eligibility
   predicate is *profile OR open-mode OR allowlisted*. Is there a sequence —
   allowlist removed between OTP and claim, mode flipped mid-session, an invite
   issued to an address that later gets removed — where that admits someone it
   shouldn't, or strands someone it should admit?
2. §4.2 — running activation from two call sites relies on `activate_invites`
   being idempotent (`001:262-271` matches unlinked rows by email). Test 12b
   pins it, but is the RPC genuinely safe under concurrent invocation, given
   sign-in and claim can overlap?
3. §6.3 — still open from R2 and unresolved: **soft delete** (`disabled_at`) for
   the UAT window instead of hard? Reversible, at the cost of a state every query
   must respect. You accepted hard delete conditionally; I'd still like the
   argument if you think reversibility is worth more during UAT specifically.
4. §3.4 — server-component `layout.tsx` gate plus optimistic middleware. Any
   route into `/admin` that bypasses the layout? Still the security-critical
   claim, and untouched by R2.
