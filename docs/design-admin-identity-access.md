# Design — Admin identity, invite gate, and profiles read scope

Status: **DESIGN — pre-Codex, not built**
Version: v1.0
Scope: admin authn/authz, signup gating, `profiles` RLS
Driver: handing ShowRunr to outside UAT testers

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

Consequences, each independently worth fixing:

| # | Fact | Why it matters at UAT |
|---|---|---|
| 1 | No admin *identity* | Every admin action is anonymous. Cannot tell who changed a setting. No revoke short of rotating the secret for everyone. |
| 2 | `===` string compare | Timing-attackable. Minor next to (1) but free to fix. |
| 3 | `/admin` page has **no server gate** | `middleware.ts:63-71` gates only `/dashboard` and `/library`. `authenticated` is React state (`app/admin/page.tsx:22`) flipped after a 200 from `/api/admin/owners`. The shell renders for anyone; only the APIs are gated. Not a breach — but the door is visible and unlocked-looking. |
| 4 | Rate limit is a process-local `Map` (`lib/admin-rate-limit.ts:5`) | Resets on cold start, not shared across serverless instances. Weak brute-force protection on a single shared secret. |
| 5 | `pathname === '/dashboard'` | Exact equality. Any future `/dashboard/*` sub-route is unauthenticated by default. |
| 6 | Sign-in **is** sign-up | `signInWithOtp` (`app/sign-in/page.tsx:34`) — any email that receives a code gets an `auth.users` row. No invite, no domain limit, no approval. |
| 7 | `CREATE POLICY "Public read" ON profiles FOR SELECT USING (true)` (`005:13`) | Every user's `id` (their `auth.users` UUID), `owner_slug`, `display_name`, and `created_at` is enumerable by anyone holding the public anon key. |
| 8 | Owner list is read-only | `/admin` shows handle/name/email/shows/joined (`app/admin/page.tsx:206-252`). No action exists to disable, delete, or assist a tester. Deleting one means the Supabase dashboard. |

(3) also has a self-promotion hazard waiting for anyone who adds a role column
naively — see §3.

---

## 2. Decisions taken

Ratified by Graham, 2026-08-10:

> **Real admin identity on your account.** Checked against the Supabase session.
> `/admin` becomes a signed-in page, middleware-gated. Retire the shared secret
> for UI; keep it for migration endpoints.

> **Invite/allowlist gate for UAT.** Only emails you've added can complete
> sign-in.

Full user management (delete/impersonate/search) was *not* selected. §7 records
what that leaves undone.

---

## 3. Admin identity — a separate table, not a column on `profiles`

**Do not add `profiles.is_admin`.** `005_owner_namespacing.sql:14` is:

```sql
CREATE POLICY "Owner manage" ON profiles FOR ALL USING (auth.uid() = id);
```

`FOR ALL` with no column restriction means any authenticated user can `UPDATE`
their own `profiles` row. Add `is_admin` to that table and **every user can grant
themselves admin with one anon-key request.** Postgres RLS has no column-level
grant inside a policy; you would have to narrow the policy or add a trigger, and
both are easy to get wrong later.

**Spec — new table, migration `013_admin_users.sql`:**

```sql
CREATE TABLE admin_users (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES auth.users(id),
  note       text
);
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
-- No policies. service_role only, per the tryit_quota precedent (001:88-89).
```

RLS on with zero policies = no anon/authenticated access at all. That is the
existing pattern for `tryit_quota` (`001_initial_schema.sql:88-89`) and
`setlist_entries` (`006_songs.sql:55-60`), so it is idiomatic here, not novel.

Admin checks happen **in route code against the service-role client**, exactly as
admin reads already do (`app/api/admin/owners/route.ts:15`). No `is_admin()` SQL
helper and no RLS policy changes are needed, because no admin data is read
through the user's own client.

**New `lib/admin-auth.ts`:**

```ts
export async function requireAdmin(): Promise<
  { ok: true; user: User } | { ok: false; status: 401 | 403 }
>
```

Session via `getSupabaseServer()` → `getUser()`; membership via service-role
`admin_users` lookup. 401 when signed out, 403 when signed in and not an admin.

### Bootstrap

Chicken-and-egg: the first admin cannot be granted through an admin-gated UI.

**Spec:** env `ADMIN_BOOTSTRAP_EMAILS` (comma-separated). On successful sign-in
(the existing `POST /api/auth/activate-invites` call at `app/sign-in/page.tsx:63`
is the natural hook), if the signed-in email matches **and `admin_users` is
empty**, insert the row.

The "and `admin_users` is empty" clause is the important half. Without it, the
env var is a permanent live grant path and admin membership has two sources of
truth forever. With it, the env var is a one-shot bootstrap that becomes inert
the moment a real admin exists, and the table is authoritative from then on.

Open: this needs Graham's ShowRunr account email. The `profiles` seed
(`supabase/seeds/seed_profiles.sql`) references handles `graham` and `fernando`
with placeholder UUIDs, so I cannot infer it — and the reported AI-key symptom
came from `graham.edwards@gmail.com` while this session's git identity is
`graham@salonhq.co`. **Both may exist as separate accounts.** Confirm which is
the real owner account before seeding.

### Retiring the shared secret

| Endpoint | After |
|---|---|
| `GET/PUT /api/admin/settings` | `requireAdmin()` **only**. Secret no longer accepted. |
| `GET /api/admin/owners` | `requireAdmin()` **only**. |
| `POST /api/admin/migrate-setlists` | `requireAdmin()` **or** `ADMIN_SECRET`. |
| `POST /api/admin/backfill-chart-overlays` | `requireAdmin()` **or** `ADMIN_SECRET`. |

The two migration endpoints keep the secret because they are one-shot chores run
from a terminal, sometimes when the UI is exactly what is broken. Where the
secret survives, the compare becomes constant-time
(`crypto.timingSafeEqual` over equal-length buffers, with a length pre-check that
does not early-return on content).

`app/admin/page.tsx` loses `handleLogin` (`:37-80`) and the `secret` state
entirely; it renders for a signed-in admin and is gated before it ever loads.

### Middleware

```ts
if (pathname === '/admin' || pathname.startsWith('/admin/')) {
  // signed out → /sign-in?redirect=/admin
  // signed in, not admin → rewrite to 404 (not 403)
}
```

404 rather than 403: a 403 confirms `/admin` exists and that the account is
known-but-unprivileged. Cheap, so take it.

Fix (5) in the same pass — `/dashboard` and `/library` become prefix matches, and
the redirect carries the *actual* target instead of the hardcoded
`redirect=/dashboard` at `middleware.ts:68`.

**Cost, stated honestly:** middleware already calls `getUser()` up to three times
(`:49, :64, :78`) plus a `profiles` select on nearly every navigation. The admin
check adds one more query, but only on `/admin` paths. Consolidating the repeated
`getUser()` calls into one is an obvious adjacent win and is **not** in this
scope — flagged so it isn't mistaken for an oversight.

### Rate limiting

Move admin auth-attempt limiting to Redis (`REDIS_URL` exists in production),
same INCR+EXPIRE shape as `consumeTryitQuota` (`app/api/agent/chat/route.ts:37-70`),
keeping the in-memory `Map` as fallback. Once the secret is retired for the UI,
brute force is against Supabase Auth rather than our string, so this matters less
than it does today — but the two migration endpoints still take a secret.

### Audit

`admin_audit(id, actor_id, action, target, meta jsonb, at)` — same RLS-on/no-
policies shape. Written on: settings change, admin grant/revoke, allowlist
add/remove. This is the capability a shared secret can never provide, and it is
~30 lines. Recommended in scope; call it if you disagree.

---

## 4. Invite gate

### Where it can actually be enforced

`supabase.auth.signInWithOtp()` goes **from the browser straight to Supabase**
(`app/sign-in/page.tsx:34`). Our server is not in that path. We therefore cannot
block `auth.users` creation in application code. Three options:

| Option | Blocks account creation | Cost |
|---|---|---|
| (a) Supabase **Before User Created** auth hook | Yes — correct layer | Supabase-side config, deploy path outside this repo |
| (b) Gate `POST /api/profiles` | No — gates *app access* | Pure app code, reversible today |
| (c) Disable signups in Supabase, create users by hand | Yes | Manual toil per tester |

**Spec: (b) for v1**, with (a) named as the correct long-term fix.

It works because of an existing mechanism: `middleware.ts:74-92` redirects any
signed-in user *without* a `profiles` row to `/claim`. A non-allowlisted user can
receive an OTP and hold a session, but cannot create a profile, and therefore
cannot reach any show, dashboard, or library — they land on `/claim` and see a
clear message. **Mechanism EXISTS**; the gate is one check inside
`POST /api/profiles` (`app/api/profiles/route.ts:13-68`).

Accepted downside, stated so it isn't a surprise: stray `auth.users` rows
accumulate for people who tried and were refused. They have no app access, but
they exist and are invisible in `/admin` (which lists `profiles`, not
`auth.users`). Acceptable for a UAT window; it is the main argument for (a).

### Mode switch, not a hard flag

Fail-closed on an empty allowlist would lock everyone out the moment it deploys —
including Graham, if his profile predates it. (Existing profiles are unaffected
by the gate, which only runs on *creation*, but that is a fact to verify rather
than assume under pressure.)

**Spec:** `signup_mode` in the existing admin-config store — Redis
`admin:signup_mode`, env `SIGNUP_MODE` fallback, values `open` | `invite`,
**default `open`**. Reuses `getAdminConfig`/`setAdminConfig`
(`lib/admin-config.ts:27-51`) and just needs adding to the allowlist at
`app/api/admin/settings/route.ts:52` and to the key list at
`lib/admin-config.ts:57`. **Mechanism EXISTS** — no new storage.

Note the trap inherited from that store: `setAdminConfig` writes the
`__DISABLED__` sentinel for an empty value (`:50`) and `getAdminConfig` maps it
back to `null` (`:32`). `signup_mode` must therefore be written as an explicit
literal, never as `''`, and the reader must treat `null` as `open`.

### Allowlist table

```sql
-- 014_signup_allowlist.sql
CREATE TABLE allowed_emails (
  email      text PRIMARY KEY,        -- stored lowercased+trimmed
  invited_by uuid REFERENCES auth.users(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  note       text
);
ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;
-- No policies. service_role only.
```

Normalize on write **and** on compare (`lower(trim(email))`). Gmail dot/plus
aliasing is deliberately **not** normalized — it is provider-specific and
surprising. Testers get told to use the exact address they were invited at.

Admin UI: a section on `/admin` — add an email, list, remove, with the note
field. Removal does not revoke an existing profile; it only prevents future
claims. Say so in the UI.

`/claim` refusal copy must be human, not a 403 blob: *"ShowRunr is in private
testing. <email> isn't on the tester list — ask Graham to add you."*

---

## 5. `profiles` read scope

`005_owner_namespacing.sql:13` makes the whole table anon-readable.

**Who actually depends on it** — every `.from('profiles')` in the codebase:

| Call site | Client | Needs the public policy? |
|---|---|---|
| `middleware.ts:81` | user session, own row | No — `auth.uid() = id` covers it |
| `app/api/profiles/route.ts:42,52,81` | user session, own row | No |
| `app/api/shows/route.ts:28` | user session, own row | No |
| `app/api/admin/owners/route.ts:19` | **service role** | No — bypasses RLS |
| `app/api/shows/[owner]/[show]/route.ts:65` | **service role** (`:61`) | No — anonymous show resolution already bypasses RLS |
| **`app/api/shows/route.ts:58`** | **user session, *other* users' rows** (`collabOwnerIds`) | **YES — the only true dependency** |

So the public policy exists to serve exactly one query: resolving the owner slugs
of people who have shared a show *with you*, for the dashboard.

**Spec:**

```sql
-- 015_profiles_read_scope.sql
DROP POLICY "Public read" ON profiles;
CREATE POLICY "Self read" ON profiles
  FOR SELECT USING (auth.uid() = id);
```

and switch `app/api/shows/route.ts:54-62` to the service-role client for that one
collaborator-slug lookup. It is a slug/display-name lookup for owners the caller
demonstrably collaborates with — `collabOwnerIds` is already derived from the
caller's own collaborator rows — so it is a narrow, justified service-role use,
consistent with how the rest of the app resolves cross-user data.

Also tighten the write side while we are in there: `"Owner manage" ... FOR ALL
USING (auth.uid() = id)` has no `WITH CHECK`. Postgres falls back to `USING` for
`FOR ALL`, so it is safe today, but it is implicit, and §3 shows what an implicit
write policy on this table costs the moment a column is added. Make it explicit.

**Ordering matters.** These migrations must land in this order and the RLS change
must ship *with* the `app/api/shows/route.ts` edit in the same deploy, or the
collaborator dashboard silently drops owner slugs. Flagged as the single riskiest
step in this document.

---

## 6. Tests

Server (vitest, node):

1. `requireAdmin` → 401 signed out, 403 signed in non-admin, ok for admin.
2. Retired endpoints reject a valid `ADMIN_SECRET` (regression guard — the whole
   point is that the secret no longer opens them).
3. Migration endpoints accept **either** an admin session or the secret.
4. Constant-time compare rejects wrong-length and wrong-content secrets.
5. Bootstrap inserts on first matching sign-in; **does not insert when
   `admin_users` is non-empty**; does not insert on a non-matching email.
6. `signup_mode = 'invite'`: `POST /api/profiles` 403s a non-allowlisted email,
   succeeds for an allowlisted one, and is case/whitespace-insensitive.
7. `signup_mode = 'open'` (and `null`) ignores the allowlist entirely.
8. Allowlist removal does not affect an existing profile.

Middleware:

9. `/admin` signed out → `/sign-in?redirect=/admin`.
10. `/admin` signed in non-admin → 404, not 403.
11. `/dashboard/anything` is gated (the `===` regression).
12. Redirect target reflects the requested path, not a hardcoded `/dashboard`.

RLS (SQL, run against a local branch):

13. Anon `select * from profiles` returns 0 rows.
14. Authenticated user reads own row only.
15. Collaborator dashboard still resolves owner slugs after the policy change —
    the §5 ordering risk, pinned by a test.

Target: **~15 new tests.** Delta reported on the build PR.

---

## 7. Not built here

Graham selected admin *identity*, not full user management. Still missing after
this lands, and worth a decision before testers arrive:

- **No way to delete a tester account** from the UI. Still a Supabase dashboard
  trip. This is the one I expect to be wanted within a week of UAT starting.
- No way to view a tester's show to help them debug — no read-only impersonation.
- No search/pagination on the owners list. `listUsers({ page: 1, perPage: 1000 })`
  (`app/api/admin/owners/route.ts:46-49`) silently truncates at 1000 and owner
  #1001 renders a blank email. Not urgent at UAT scale; a landmine later.
- No feedback capture surface at all — there is no feedback table or route in the
  repo, despite `004` being absent from the migration sequence and
  `project_showbible` memory recording a "004 feedback" migration. **The
  migration sequence skips 004** (`001,002,003,005,...,012`). Whatever that was,
  it is not in this repo. Worth resolving before adding `013`.
- `plan`/billing columns from `docs/design-payments.md:144` remain unbuilt.

---

## 8. Open questions for Codex

1. §3 — is a separate `admin_users` table the right call over a narrowed
   `profiles` policy plus a column? I argue yes on the self-promotion hazard
   alone, but it does add a table for a single boolean.
2. §3 — is "bootstrap only while `admin_users` is empty" too clever? It makes the
   env var's behavior depend on DB state, which is surprising if you are reading
   only the config. The alternative is a seeded migration requiring a known UUID.
3. §4 — is option (b) (gate at profile creation, not account creation) acceptable
   for a private UAT, given it leaves orphan `auth.users` rows that are invisible
   in `/admin`? Or should we do (a) properly now?
4. §5 — is routing the collaborator-slug lookup through the service role a
   reasonable trade to close a world-readable table, or does it push one more
   authorization decision from RLS into TypeScript? Note `lib/supabase-admin.ts:3-5`
   already carries a comment claiming service role is used **only** for anonymous
   lookups, quota, and invites — which is **already false** (~15 cookie-bound
   routes use it). This change makes it more false. The comment should be
   corrected either way.
5. §3 audit — in scope, or a separate pass?
6. §7 — should tester deletion ship *with* the invite gate rather than after? The
   two are the same workflow from Graham's side: add a tester, remove a tester.
