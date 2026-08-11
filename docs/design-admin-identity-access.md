# Design — Admin identity, invite gate, tester deletion, and profiles read scope

Status: **DESIGN — Codex R6 folded. Design-complete; no R7 planned (Graham).**
Version: **v9.0** (v1 = pre-Codex, v2 = R1, v3 = R2, v3.1 = platform owner,
v4 = R3, v5 = R4, v6 = Graham ruling, v7 = R5, v8 = invariant registry)
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

**v4 changelog:**

| Change | Source |
|---|---|
| **§6.2.1 NEW — the audit row now comes BEFORE the destruction.** v3 wrote it after `deleteUser`, so the storage-gone/account-remains path it named itself produced no audit row at all. Two-phase `attempted` → `succeeded`/`failed`. | Codex R3 **high** |
| §3.6 — `admin_audit` gains `status` + `ended_at`, defaulted so single-phase call sites are unchanged | follows from §6.2.1 |
| **§4.2.1 NEW — `activate_invites` still compares raw emails** against a normalized allowlist. Migration `016` *(renumbered to `017` in v5)*: backfill + canonical CHECK + normalized comparison. | Codex R3 medium |
| §8 — tests 12d–12f (canonicalization) and 20–24 (failed-delete auditing). ~22 → ~30. | Codex R3 |
| §3.4 `app/admin/layout.tsx` boundary confirmed; hard delete confirmed for UAT given failed-attempt auditing | Codex R3 answers |

**v5 changelog:**

| Change | Source |
|---|---|
| **Duplicate migration `016`** — §4.2.1 and §7 both claimed it. Mine → `017`, plus **§0.1 NEW**, an allocation table for `013`–`017` so the next addition can't collide. | Codex R4 **high** |
| §4.2.1 step 2 — canonicalizing **trigger AND `CHECK`**, not either/or. Ergonomics and enforcement were not the trade I thought. | Codex R4 answer |
| §8 — tests 12e-i (trigger normalizes), 12e-ii (CHECK still rejects with the trigger dropped). ~30 → ~33. | Codex R4 answer |

**v6 changelog** — Graham ruled the standing concurrency question, 2026-08-11:

| Change | Source |
|---|---|
| **§4.2.2 NEW — no locking.** A single UPDATE at READ COMMITTED re-evaluates its predicate after a lock wait, so a concurrent duplicate updates zero rows. Idempotence falls out of the statement's shape. | Graham ruling |
| **★ §4.2.2 — the `DROP FUNCTION` grant-reset trap.** `001:273` revokes EXECUTE from `authenticated`; `CREATE OR REPLACE` preserves that, `DROP` + `CREATE` does not. Changing the return type *requires* a DROP — so the obvious next improvement to this function would silently expose a `security definer` row-ownership primitive. `017` stays `CREATE OR REPLACE`. | found while answering |
| **§4.2.3 NEW — the activation route reports success it never verified.** It discards the RPC error and returns `activated: true` unconditionally; the client ignores the response too. Fixed at the app layer. | found while answering |
| §8 — tests 12g (route 500s on RPC error), 12h (concurrent activation is a no-op), 12i (`authenticated` still cannot EXECUTE after `017`). ~33 → ~36. | Graham ruling |
| Return-count improvement and the `handleVerifyOtp` spinner bug → **backlog, with reasons recorded** | Graham ruling |

**v7 changelog:**

| Change | Source |
|---|---|
| **§4.2.4 NEW — activation must run BEFORE the profile insert.** v6 ran it after, so an activation failure left a profile with unlinked invites and the retry hit `409 Profile already exists`. Worse than it reads: `/claim` renders "Already claimed" and never shows the form, so route-level idempotence would fix an endpoint nobody can reach. | Codex R5 **high** |
| §4.2.4 — `/admin` **"Re-link invites"** action, audited. The window is open in production now, and the ordering fix only protects future claims. | follows from the finding |
| §4.2.1 step 3 — `017` **re-issues** the revoke rather than relying on `CREATE OR REPLACE` preserving it. Preservation keeps a good state *and* a bad one; live grant drift is invisible to the repo. | Codex R5 medium |
| §8 — tests 12i-a (drift converged) and 12j–12n (ordering, retry, `409` branch, admin recovery). ~36 → ~43. | Codex R5 |

**v8 changelog** — process change, not a review round:

| Change | Source |
|---|---|
| **§0.2 NEW — the nine invariants this design establishes**, with the rule that every addition is walked against them before a version ships. Both of this doc's self-inflicted findings were additions violating a rule stated elsewhere in it. | Graham, 2026-08-11 |
| §6.3 — the delete-confirmation email comparison is **canonical**. Found by walking §0.2 against the existing text, not by review. | invariant 6 |

**v9 changelog** — final round:

| Change | Source |
|---|---|
| §0.1 — the `017` row now lists the **function replace + revoke**. §0.1 had drifted from §4.2.1, which is the exact failure it exists to prevent; invariant 8 tightened to "the row lists everything the file does". | Codex R6 **medium** |
| **§4.2.5 NEW — "links done, no profile" grants DB-level collaborator access.** v7 called it harmless without checking. Accepted as residue with the exposed set stated precisely; the refused tester is closed by §4.2(b), not by `requireAppUser`. | Codex R6 **medium** |
| **§4.2(a) corrected — `requireAppUser` is an app-layer gate, not an authorization boundary.** The browser holds the anon key; RLS decides. Same overclaim as R1 blocker 1, made one layer deeper. | follows from §4.2.5 |
| §0.2 — **invariant 10**: RLS is the boundary, app-layer gates are not | follows from §4.2.5 |
| §8 — tests 12o (non-eligible user blocked **at RLS**, via direct PostgREST) and 12p (residue is real and bounded). ~43 → ~45. | Codex R6 |

## 0.1 Migrations this design claims

*(New in v5 — Codex R4 high. v4 allocated `016` in **two** sections, §4.2.1 and
§7. With this repo's numbered convention that is a live implementation hazard:
two files, one version, one of them silently masking or colliding with the
other. The doc had grown migrations section by section with no single place to
see what was taken — so the fix is the table, not just the renumber.)*

Repo currently ends at `012_song_bpm.sql`; `004` never existed (§9).

| Migration | Section | Contents |
|---|---|---|
| `013_admin_users.sql` | §3.1, §3.3, §3.6 | `admin_users`, `admin_audit` (incl. `status` + `ended_at`), bootstrap seed |
| `014_signup_allowlist.sql` | §5 | `allowed_emails` + canonical `CHECK` |
| `015_fk_cascades.sql` | §6.2 | the FK repair — every `auth.users` reference in the table at §6.2 |
| `016_profiles_read_scope.sql` | §7 | drop `"Public read"`, add `"Self read"` |
| `017_normalize_collaborator_email.sql` | §4.2.1 | backfill + canonicalizing trigger + `CHECK` on `show_collaborators`; **`CREATE OR REPLACE FUNCTION activate_invites` (normalized comparison, `security definer` carried forward) + explicit `REVOKE EXECUTE ... FROM public, anon, authenticated`** |

**Any new migration added to this document takes the next free number here and
is added to this table in the same edit.**

*The `017` row was stale in v7 and Codex R6 caught it: the security-critical
function replace and revoke had been added to §4.2.1 without updating this table.
**§0.1 drifted from a section, which is the exact failure §0.1 exists to
prevent.** Invariant 8 now reads explicitly as "the row lists everything the
file does," not just "the file has a number" — a table that records only the
name of a migration is a table nobody needs to keep accurate.*

The only hard ordering constraints are *within* files — `017`'s backfill must
precede its own `CHECK` (§4.2.1), and `013`'s table creation precedes its seed.
Across files they are independent, so the numbering is sequence, not dependency.
One deploy-level constraint sits outside the numbering: `016` must ship in the
**same deploy** as the `app/api/shows/route.ts` service-role switch (§7), or the
collaborator dashboard breaks between them.

---

## 0.2 Invariants this design establishes

*(New in v8. Two of this document's findings — R2's FK holes and R5's activation
ordering — were **additions of mine that violated a rule stated elsewhere in this
same document.** Re-reading the doc doesn't catch that, because new material
reads correctly in isolation; the defect only appears when it is checked
**against** the rule. This section makes the rules addressable so they can be
checked rather than remembered.)*

1. **Every `auth.users` reference has an explicit `ON DELETE` action** — including
   the ones this design itself adds. (§6.2)
2. **No destructive operation runs unaudited, and the audit row precedes the
   destruction.** No audit ⇒ no destruction. (§6.2.1)
3. **Eligibility — not profile existence — gates invite activation.** (§4.2b)
4. **No reachable state has a tester holding a profile with unlinked invite
   rows.** (§4.2.4)
5. **Every failure path leaves a state the tester or an admin can recover
   from.** An error return is not a fix if it strands the caller. (§4.2.4)
6. **Emails are canonical (`lower(btrim())`) at rest and at every comparison.**
   (§4.2.1, §5)
7. **Admin identity lives in a service-role-only table**, never as a column on a
   row its subject can write. (§3.1)
8. **Every migration takes the next free number from §0.1**, and that row lists
   **everything the file does** — not just its name. (R6 caught §0.1 itself
   drifting from §4.2.1.)
9. **A function replacement carries its `security definer` and re-issues its
   grants.** Preservation is not enforcement. (§4.2.1, §4.2.2)
10. **RLS is the authorization boundary; app-layer gates are not.** The browser
    holds the anon key and can reach PostgREST directly, so any claim that a
    route check "keeps someone out" must be justified at the RLS layer or
    restated. (§4.2a, §4.2.5)

**The rule: every addition to this document is checked against all ten before a
version is pushed** — not by re-reading the doc, but by walking this list against
the diff. Adding an invariant here is part of adding the section that establishes
it.

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
  status      text NOT NULL DEFAULT 'succeeded'
              CHECK (status IN ('attempted', 'succeeded', 'failed')),
  meta        jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz             -- set when a two-phase action resolves
);
ALTER TABLE admin_audit ENABLE ROW LEVEL SECURITY;
-- No policies. service_role only.
```

**`status` is new in v4 (Codex R3 high).** Most audited actions are a single
non-destructive write and land as `succeeded` in one insert — the default keeps
those call sites unchanged. **Destructive actions are two-phase**: an
`attempted` row *before* the destruction, resolved to `succeeded` or `failed`
after (§6.2). Without it, the audit trail records only the operations that
worked, which is precisely backwards — a failed destructive operation is the one
you most need a record of, because it is the one that leaves inconsistent state
behind. `/admin`'s audit panel must render `attempted` and `failed` rows
distinctly, not filter them out.

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

**But `requireAppUser` is an app-layer gate, not an authorization boundary**
*(corrected in v9 — Codex R6)*. The browser holds
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (`lib/supabase-browser.ts:9`) and can call
PostgREST directly, where **RLS** decides — and the collaborator policies
authorize on `user_id` alone, with no reference to `profiles` (§4.2.5). So this
list narrows the app surface and nothing more. **The thing that actually keeps a
refused tester out is §4.2(b)'s eligibility gate on activation**, because a user
with no linked `show_collaborators` rows has nothing for RLS to grant. Stated
here because v1 made exactly this overclaim about `POST /api/profiles` (R1
blocker 1) and I fixed it one layer too shallow.

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

**But eligibility is not the only thing that has to match — the email does too.**
See §4.2.1; the v3 fix admits the right person and can still link nothing.

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

### 4.2.1 Activation still compares raw emails (new in v4)

**Codex R3 medium, verified.** The eligibility fix in §4.2(b) is correct and
insufficient. The allowlist path canonicalizes to `lower(btrim(email))` (§5,
enforced by a DB `CHECK`), but the RPC that actually does the linking does not:

```sql
-- 001_initial_schema.sql:261
where email = p_email
  and user_id is null;
```

So an invitee can pass every gate this design adds — allowlisted, eligible,
signed in — and still have **zero collaborator rows linked**, because
`show_collaborators.email` holds `'Test@Example.com '` and `p_email` is
`'test@example.com'`. Same silent, permanent orphaning as the R2 blocker, one
comparison further down. The gate lets them in and the link never happens.

**The asymmetry matters for where to fix it.** `p_email` comes from
`auth.users.email`, which GoTrue already stores lowercased — so the drift is
essentially all on the *stored invite* side. And that side has **no application
write path at all**: `show_collaborators` is only ever read in this repo
(4 call sites, all `select`), so every invite row is hand-inserted in the
Supabase console. Hand-typed is exactly where casing and trailing spaces come
from, and there is no app layer that could have normalized them.

**Spec — migration `017_normalize_collaborator_email.sql`:**

*(v5: was `016`, which §7 had already claimed. See the allocation table in §0.1
— that collision is exactly what it now exists to prevent.)*

1. **Backfill:** `UPDATE show_collaborators SET email = lower(btrim(email))
   WHERE email <> lower(btrim(email));`. Run before the constraint, or the
   constraint cannot validate. Note the `unique(show_id, email)` at `001:42`:
   if two rows on one show differ only by case, the update collides — dedupe
   first, keeping the row with a non-null `user_id`, else the earliest
   `invited_at`. Unlikely at UAT scale; a migration that fails loudly on it is
   correct, one that silently drops a row is not.
2. **Normalize on write, then constrain — both, not either** (Codex R4 answer,
   and it is better than the choice I posed):

   ```sql
   CREATE FUNCTION canonicalize_collaborator_email() RETURNS trigger AS $$
   begin
     new.email := lower(btrim(new.email));
     return new;
   end;
   $$ LANGUAGE plpgsql;

   CREATE TRIGGER show_collaborators_canonical_email
     BEFORE INSERT OR UPDATE ON show_collaborators
     FOR EACH ROW EXECUTE FUNCTION canonicalize_collaborator_email();

   ALTER TABLE show_collaborators ADD CONSTRAINT
     show_collaborators_email_canonical CHECK (email = lower(btrim(email)));
   ```

   I had framed this as trigger **or** CHECK and asked which. Codex's answer —
   *"trigger + CHECK, not either/or"* — dissolves the trade I thought I was
   making. The trigger makes routine console entry just work, which is the
   ergonomics half; the CHECK still enforces the invariant **if the trigger is
   ever dropped, disabled, or bypassed**, which is the correctness half. Neither
   substitutes for the other, and the cost of both is one function and one
   constraint.

   The remaining hazard is the migration's own ordering: with the trigger in
   place the CHECK can never fire on normal writes, so **the constraint is only
   validated against the backfilled table at migration time** (step 1). If step 1
   is skipped, `ADD CONSTRAINT` fails loudly on the existing rows — which is the
   correct outcome, and test 12e pins it.

   Note the trigger fires on `UPDATE` too, so `activate_invites`' own writes
   (`set user_id = ..., accepted_at = ...`) pass through it harmlessly — it
   rewrites `email` to a value it already equals.
3. **Normalize the comparison anyway — via `CREATE OR REPLACE`, never
   `DROP` + `CREATE`.** `CREATE OR REPLACE FUNCTION activate_invites` with
   `where lower(btrim(email)) = lower(btrim(p_email))`. Belt and braces — the
   CHECK makes the left side canonical, this makes the RPC correct even against
   rows that predate it or arrive by some path we haven't thought of.

   The replacement must carry `security definer` and `language plpgsql` forward
   verbatim (`001:263-271`) — dropping `security definer` would leave the update
   subject to RLS and silently link nothing, which is the same failure this
   fixes wearing a different hat.

   **`CREATE OR REPLACE` is load-bearing, not stylistic — see §4.2.2.**

   **And re-issue the revoke anyway, immediately after the replace** *(new in v6
   — Codex R5 medium)*:

   ```sql
   REVOKE EXECUTE ON FUNCTION activate_invites(uuid, text)
     FROM public, anon, authenticated;
   ```

   Codex's point is exact and I had missed it: `CREATE OR REPLACE` **preserves**
   the grant state, which preserves a *good* state — and equally preserves a
   **bad** one. `001:273`'s revoke is what the schema says; it is not necessarily
   what the live database has, since anyone can `GRANT` from the Supabase SQL
   editor and nothing in the repo would show it. Preservation is not enforcement.

   Re-issuing costs one idempotent statement, converges live drift, and — the
   part I value most — **puts the security requirement inside the migration that
   touches the function**, where the next person to edit it will see it. §4.2.2's
   trap is documented in prose; this makes it executable. The row-count/DROP
   change stays deferred either way.

The index consequence is worth a line: the `unique(show_id, email)` index still
serves the lookup, because after step 2 the stored side is canonical and
`lower(btrim(email))` on it is a no-op — but the RPC's expression form will not
use that index. At UAT row counts this is irrelevant; naming it here so nobody
"optimizes" step 3 away later without knowing why it exists.

### 4.2.2 Concurrency, and the grant trap behind it — Graham ruled 2026-08-11

Standing question across R3/R4/R5: activation now runs from two call sites and
relies on `activate_invites` being idempotent. Is the RPC safe under
**concurrent** invocation? **Resolved: yes, and no locking is added.**

**The overlap window is nearly nonexistent.** `handleVerifyOtp` *awaits* the
activate-invites fetch before `router.push(redirect)`
(`app/sign-in/page.tsx:63-65`), so call site A has finished before `/claim`
renders, and call site B (`POST /api/profiles`) cannot fire until a human has
typed a handle. The realistic double-fire is **the same call site twice** — a
double-clicked claim button, or two tabs — not the two racing each other.

**And that case is already safe, for a structural reason worth recording.** The
RPC is a single UPDATE at READ COMMITTED (`001:264-269`). Two concurrent
executions: T2 finds row R matching `user_id is null` in its snapshot, blocks on
T1's row lock, then **re-evaluates the WHERE clause against the committed new
row version** — `user_id` is no longer null, so R is skipped. The duplicate
updates zero rows. Idempotence is not a property we add; it falls out of the
statement's shape. Two corollaries: `accepted_at` is never clobbered on re-run
(the row stops matching), and first-writer-wins means no interleaving yields a
wrong `user_id`.

Adding an advisory lock would be ceremony around a guarantee Postgres already
gives — and Neon's pooled connections don't support advisory locks anyway
([[feedback_neon_migrations]]), so it would have to be row-level, serializing
the onboarding path to defend against a race that cannot occur.

**★ The trap this analysis uncovered.** `001:273` is:

```sql
revoke execute on function activate_invites from public, anon, authenticated;
```

That revoke is the only thing stopping a `security definer` function — one that
links collaborator rows to **any** `user_id` you hand it — from being callable by
every signed-in user through PostgREST.

> **`CREATE OR REPLACE` preserves grants. `DROP FUNCTION` + `CREATE` resets them
> to the default, EXECUTE to PUBLIC.**

Step 3 as specified only changes the function *body*, so `CREATE OR REPLACE`
works and the revoke survives. But Postgres **requires** a DROP to change a
function's **return type** — and `returns void` → `returns integer` is the
obvious next improvement to this function (see below). Anyone making that change
without re-issuing the revoke opens a privilege escalation in the function whose
entire job is assigning ownership of invite rows. Recorded here because the trap
is invisible at the call site and the fix looks like an improvement.

This is the third instance in this document of a repair introducing the defect
class it was repairing (R2's FK holes, R4's duplicate `016`, now this).

**Graham's ruling (2026-08-11): keep `017` to the WHERE clause, fix the lie in
the route instead.** Scope stays `CREATE OR REPLACE`, no return-type change, zero
new privilege surface.

*Refined by Codex R5:* `017` also **re-issues** the revoke rather than relying on
preservation — see §4.2.1 step 3. That does not widen the ruling's scope (still
no DROP, still no signature change); it converges any live grant drift and puts
the requirement in the file that touches the function.

### 4.2.3 The activation route reports success it did not verify

Independent of the SQL, and in scope as an app-layer fix:

```ts
// app/api/auth/activate-invites/route.ts:14-19
await admin.rpc('activate_invites', { ... });   // error discarded
return Response.json({ activated: true });      // unconditional
```

The RPC's error is never read, so the route returns `200 { activated: true }`
when activation **errored**. Combined with the client ignoring the response
(`sign-in/page.tsx:63`), a total failure of invite activation is invisible on
both ends — which is how the R2 blocker would have stayed hidden in production
even after being fixed.

**Spec:** destructure and check `{ error }`; on error return `500` and log. The
`POST /api/profiles` call site (§4.2's belt-and-braces re-run) does the same —
**but see §4.2.4, because where that call sits in the route decides whether the
tester can ever recover.** No row count, no return-type change, no DROP.
Test 12g.

### 4.2.4 Activation must run BEFORE the profile insert (new in v6)

**Codex R5 high, and my own §4.2.3 fix is what made it reachable.** v5 said
activation runs *after* successful profile creation. Trace the failure:

1. `POST /api/profiles` inserts the profile. **Committed.**
2. Activation runs and fails.
3. §4.2.3 says return `500`.
4. The tester retries — and `app/api/profiles/route.ts:41-49` checks for an
   existing profile **first** and returns `409 Profile already exists` before
   any post-create work.

Result: a tester with a profile, unlinked collaborator rows, and **no path back
through the route.** Silent and permanent, which is the exact class of the R2
blocker — reintroduced by the error handling I added one section earlier. Before
§4.2.3 the route swallowed the error and returned `201`; the state was equally
broken but at least not presented as a retryable failure.

**It is worse than the route makes it look, and this decides the fix.** Codex
offered two options — make the route idempotent for the same user, *or* run
activation before the insert. Only the second one actually helps, because the
tester never reaches the `409` branch:

- `/claim` is in `PROFILE_CHECK_EXEMPT` (`middleware.ts:20`), so a profiled user
  *can* load the page —
- but `app/claim/page.tsx:21-38` fetches `GET /api/profiles` on mount, and on
  `200` sets `alreadyClaimed` and renders the **"Already claimed"** panel
  (`:88-95`). The form never renders. There is nothing to re-submit.

So route-level idempotence would fix an endpoint nobody can reach. The ordering
fix is the real one.

**Spec — `POST /api/profiles`, in order:**

1. authn (`:15-19`)
2. slug validation (`:21-38`)
3. eligibility check — allowlist / `signup_mode` (§4.2)
4. **activation** — idempotent, and §4.2(b) already established that *eligibility*,
   not profile existence, is its predicate. On error: `500`, **before any
   profile row exists.**
5. profile insert (`:51-59`)
6. `201`

Every failure is now recoverable by retrying the claim form:

| Failure | State | Recovery |
|---|---|---|
| activation fails | no profile, no links | retry: form still renders (no profile), activation re-runs |
| activation ok, insert fails | links done, no profile | retry: activation no-ops (idempotent), insert retried |
| handle taken (`23505`) | links done, no profile | tester picks another handle; links already correct |

### 4.2.5 "Links done, no profile" grants DB access — accepted residue, stated

*v7 called this state "harmless" in one line. **Codex R6 was right to refuse
that**, and chasing it corrected something bigger than the state itself.*

`lib/supabase-browser.ts:9` ships `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the browser,
so any signed-in user can call PostgREST directly, bypassing every Next.js route.
And the collaborator policies authorize on `user_id` **alone**:

```sql
-- 001:100  "Collaborator read" on shows
using (exists (select 1 from show_collaborators
               where show_id = shows.id and user_id = auth.uid()))
```

Same shape at `001:118` (**`"Editor update"` — a write**, not just a read) and
`001:158` (`"Chart read"`). **No policy anywhere mentions `profiles`.**

**So §4.2(a)'s `requireAppUser` is an app-layer gate, not an authorization
boundary — and I have now made that overclaim twice.** R1 blocker 1 was v1
asserting that gating `POST /api/profiles` meant a refused tester "cannot reach
any show"; I fixed the *API* layer and never checked the layer below it. The
correction belongs in §4.2(a) itself: **RLS is the boundary. `requireAppUser`
narrows the app surface; it cannot narrow PostgREST.**

**The residue, precisely.** Who can hold links without a profile?

| Who | Links? | Verdict |
|---|---|---|
| Eligible invitee, hasn't claimed yet | yes | **Intended.** They read the show they were invited to. This is the normal pre-claim state, not an edge case — activation deliberately precedes `/claim` (§4.2b, the R2 blocker fix) |
| Eligible invitee whose handle insert failed | yes | Same state as above, reached differently. §4.2.4's ordering did not create it |
| **Refused tester** (invite mode, not allowlisted) | **no** | Eligibility gate blocks activation, so no rows are ever linked — §4.2(b) is what closes this, and it closes it at the only layer that matters |

**Accepted as residue**, because the exposed set is exactly the people we intend
to have access, reaching the show they were explicitly invited to. What was wrong
was calling it harmless without checking — the reasoning had never been done, and
"harmless" was an assumption wearing the clothes of a conclusion.

**Test 12o** pins the boundary rather than the residue: a **non-eligible** user
who was previously invited gets **no linked rows**, and therefore a direct
PostgREST read of that show with the anon key returns **zero rows**. That is the
assertion that matters, and it exercises RLS directly rather than through a route
— because a route test would prove nothing about the layer the finding is about.

**Deliberately not done:** adding `and exists (select 1 from profiles where id =
auth.uid())` to the three collaborator policies. It would make the app and DB
layers agree, but it would also break legitimate pre-claim access, which §4.2(b)
exists to guarantee. Recorded as the option, with the reason it was declined, so
it isn't rediscovered as an obvious tightening.

**Also keep the `409` branch honest.** Re-run activation there before returning,
as cheap defence for the two-tab case and for anyone stranded by *today's* code.
It is two lines and it is not the load-bearing fix.

**Recovery for the already-stranded.** The window is open in production right
now: sign-in activation swallows its error (§4.2.3), so a tester whose
activation failed has unlinked rows and no self-service path — the ordering fix
protects future claims, not past ones. `/admin` gains a per-owner **"Re-link
invites"** action calling the same idempotent RPC, audited via §3.6 like every
other admin action. Small, in scope for a document that already builds per-user
admin actions (§6.3), and it is the only operational lever for a failure the
tester cannot see and cannot report precisely.

**This is the fourth instance in this document of a repair introducing the
defect class it repaired** — R2's FK holes, R4's duplicate `016`, R5's grant
trap, now this. The pattern is specific enough to act on: *after adding an error
path, ask what state the system is in when it fires, and whether the user can
get out of it.* An error return is not a fix if it strands the caller.

**Deliberately deferred to backlog, with the reason recorded so it isn't
rediscovered as a good idea:**

- `activate_invites` returning the affected row count would let callers log
  *"linked N invites"* and make idempotence assertable on the return value
  rather than on table state. It is a genuine improvement and it is **not worth
  the DROP** above during a UAT window. If it is ever done, the migration must
  re-issue the `revoke` and ship a fail-closed test asserting `authenticated`
  cannot EXECUTE it.
- `handleVerifyOtp` (`sign-in/page.tsx:62-65`) has no `try`/`catch`: if the
  activation fetch throws, `setLoading(false)` and `router.push` are both
  skipped, leaving the tester on a spinner with no error. Real bug, unrelated to
  identity — belongs in the UAT-polish batch, not this PR.

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

**(a) Add the missing cascades** in migration `015_fk_cascades.sql` (§0.1):

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
2. **Write the `attempted` audit row** (§3.6) — actor, target snapshots, and the
   step-1 counts — and keep its `id`. **If this insert fails, abort here and
   destroy nothing.** No audit, no destruction.
3. Enumerate the user's storage objects, delete them, **recording how many
   actually succeeded** — not how many were attempted.
4. `auth.admin.deleteUser(id)` — cascades handle every table.
5. **In a `finally`**, resolve the audit row: `UPDATE admin_audit SET status =
   'succeeded' | 'failed', ended_at = now(), meta = meta || {storage_attempted,
   storage_deleted, error}` for the id from step 2. This runs on the failure path
   too — that is the entire point.

### 6.2.1 Why the audit row comes first (new in v4)

**Codex R3 high, and it exposed a hole I had described and then not closed.** v3
wrote the audit row as step 4, *after* the DB deletion — so the failure mode v3
itself named two paragraphs later (storage gone, account remains) produced
**no audit row at all**. The one outcome where the record is the only surviving
evidence was the one outcome that recorded nothing. I documented the risk and
then ordered the steps as if I hadn't.

Three properties this ordering buys:

- **Nothing destructive happens unaudited.** Step 2 is a precondition, not a
  postscript. An operator can always answer "did anyone try to delete this
  account?" — including when the answer is "yes, and it broke."
- **Partial storage loss is attributable.** `storage_attempted` vs
  `storage_deleted` land in `meta` on both the success and failure paths. Codex
  R2's condition for hard delete was *"storage deletion is count-audited"*; with
  the write ordered last that condition silently didn't hold on the path that
  needed it. Now it does.
- **`attempted` rows that never resolve are themselves a signal.** A row left at
  `attempted` means the route died between step 3 and step 5 — process kill,
  timeout, deploy mid-request. That is a state worth being able to see, and it
  is only visible because the row exists before the work.

Codex's R3 answer — *"hard delete is still acceptable for UAT if failed attempts
are audited, not only successful deletes"* — is exactly this, and it is now the
gating condition on §6.3 shipping.

Storage deletion is still **not transactional with the DB delete**. If step 3
partially succeeds and step 4 fails, files are gone and the account remains
(**and the audit row says so**, at `failed` with both counts — which is the
change from v3, where this path was invisible). Order chosen deliberately:
orphaned *account* is recoverable, orphaned *files* are invisible and bill
forever. Say this in the doc rather than pretending it is atomic.

*(v3 also misnumbered this paragraph's own steps — it said "step 1 partially
succeeds and step 2 fails" when it meant the storage and account steps. Fixed.)*

### 6.3 Endpoint and UX

`DELETE /api/admin/users/[id]` — `requireAdmin()` only. Guards:

- **Cannot delete yourself.** Hard 400, checked before anything else.
- **Cannot delete another admin** unless their `admin_users` row is revoked
  first. Prevents a one-click lockout of the platform.
- Requires a confirmation body echoing the target's email — the same shape as a
  "type the name to confirm" dialog, enforced server-side rather than trusting
  the client. **The comparison is canonical** (`lower(btrim())` on both sides),
  per invariant 6. *Found in v8 by walking §0.2 against the existing doc, not by
  review:* this is an email compared against another email, and every other such
  comparison in the design was canonicalized while this one was not. The failure
  is safe-direction — a case mismatch refuses a legitimate delete rather than
  permitting a wrong one — but it would read as "the delete button is broken."

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

**Codex R3 medium — email canonicalization (§4.2.1):**

12d. **A collaborator row invited as `' Test@Example.COM '` links to a user whose
     `auth.users.email` is `test@example.com`.** The case Codex named, and the
     one 12a would not have caught, because 12a uses a clean address on both
     sides. Run it against the post-migration RPC.
12e. The `017` backfill normalizes a mixed-case row, and `ADD CONSTRAINT`
     **fails loudly** if run against un-backfilled rows — the migration's
     internal ordering asserted, not assumed.
12e-i. **Trigger:** inserting `' Test@Example.COM '` into `show_collaborators`
     **succeeds and stores `test@example.com`**. Routine console entry just
     works (Codex R4 answer).
12e-ii. **CHECK survives trigger removal:** with the trigger dropped, the same
     insert is **rejected**. This is the half that would silently rot if only
     the trigger existed, and the reason both ship — asserting the trigger's
     effect alone would pass with no constraint at all.

**§4.2.2 / §4.2.3 — concurrency and the honest route (new in v6):**

12g. **The route returns 500 when the RPC errors**, not `200 { activated: true }`.
     Mock the RPC to fail. Today's code passes *no* assertion here because it
     never reads the error — this is the regression guard for a failure that is
     currently invisible on both client and server.
12h. **Concurrent activation is a no-op, not a conflict.** Two overlapping
     `activate_invites` calls for the same user link each collaborator row
     **exactly once**, and `accepted_at` retains the **first** call's timestamp.
     Pins the READ COMMITTED behavior §4.2.2 relies on, so that if anyone later
     rewrites the single UPDATE into a read-then-write, the test fails rather
     than the reasoning silently expiring.
12i. **`authenticated` cannot EXECUTE `activate_invites`** after `017` runs.
     `017` both preserves the grant state (`CREATE OR REPLACE`) **and re-issues
     the revoke**, so this asserts the end state regardless of which mechanism
     delivered it — and fails loudly if the migration is ever rewritten as
     `DROP` + `CREATE` with the revoke dropped (§4.2.2).
12i-a. **Grant drift is converged, not merely preserved** (Codex R5 medium).
     `GRANT EXECUTE ... TO authenticated` *before* running `017`, then run it:
     the grant is gone afterwards. This is the case `CREATE OR REPLACE` alone
     would silently carry forward, and the reason the explicit revoke earns its
     line.

**§4.2.4 — activation ordering (new in v6, Codex R5 high):**

12j. **Activation failure leaves no profile behind.** With the RPC mocked to
     fail, `POST /api/profiles` returns 500 **and `profiles` has no row** for
     that user — the ordering assertion, and the whole finding in one test.
12k. **The retry succeeds.** After 12j, a second `POST /api/profiles` with the
     RPC healthy creates the profile *and* links the collaborator rows. Pins
     that the tester is not stranded — which is what the R5 finding was actually
     about, more than the ordering itself.
12l. Activation succeeds, **insert** fails (`23505`, handle taken): the
     collaborator rows are still linked, and a retry with a different handle
     succeeds without double-linking.
12m. The `409 Profile already exists` branch re-runs activation before
     returning. Defence for the two-tab case; asserted so it is not dropped as
     dead code by someone who notices `/claim` rarely reaches it.
12n. **`/admin` "Re-link invites"** links a stranded user's rows and writes an
     `admin_audit` row (§3.6). The recovery lever for testers already broken by
     today's swallowed error.
12o. **The boundary is RLS, not the route** (Codex R6, §4.2.5). A non-eligible
     user who was previously invited gets **no linked rows**, and a **direct
     PostgREST read with the anon key** — not a route call — returns **zero
     rows** for that show. Must exercise RLS directly; a route-level test proves
     nothing about the layer this finding is about.
12p. The **eligible, profileless** invitee **can** read the show they were
     invited to via the same direct path. Asserts the accepted residue is real
     and bounded, so nobody later "fixes" it and silently breaks pre-claim
     access (§4.2b).
12f. The backfill's collision path: two rows on one show differing only by case
     dedupe to the one with a non-null `user_id`, and the migration **fails
     loudly** rather than dropping a row if that rule is ambiguous.

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

**Codex R3 high — failed deletes must be audited (§6.2.1):**

20. **`auth.admin.deleteUser` throws after storage deletion has run: an
    `admin_audit` row exists with `status='failed'`, both storage counts, and
    the error.** The v3 ordering produced *no row at all* here — this is the
    regression guard for the whole finding, and it must assert on the row's
    presence and status, not merely that the endpoint returned an error.
21. The `attempted` row is written **before** any storage call: with the storage
    client mocked to throw on first use, the audit row still exists. Ordering
    asserted directly, since it is the entire fix.
22. **If the `attempted` insert fails, nothing is destroyed** — storage delete
    and `deleteUser` are never called, and the endpoint 500s. "No audit, no
    destruction" as an assertion rather than a sentence.
23. A successful delete leaves exactly **one** audit row, resolved to
    `succeeded` with `ended_at` set — the two-phase write must not double-log.
24. Non-destructive audited actions (settings change, allowlist add) still write
    a single `succeeded` row via the column default — the §3.6 change must not
    force every existing call site into two phases.

Target: **~45 new tests** (v3 said ~22; 12d–12f and 20–24 added in v4, 12e-i/ii
in v5, 12g–12i in v6, 12i-a and 12j–12n in v7, 12o–12p in v9). Delta reported on
the build PR.

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
| Hard delete OK **if** FK holes closed and storage count-audited | Both conditions met — §6.2 step 3 distinguishes attempted from succeeded, test 18 asserts it. *(v4: R3 showed the count-audit didn't actually hold on the failure path, because the audit write came last. §6.2.1.)* |
| Seed both accounts if both should be admin; no runtime bootstrap | **Accepted** (§3.3) — wider `IN` clause, guard asserts the expected count. |

## 10b. Codex R3 — disposition

| Finding | Disposition |
|---|---|
| **High** — failed hard-deletes can be unaudited after destructive storage work | **Accepted, and it is the sharpest kind of miss: v3 named this exact failure mode in prose and then ordered the steps as if it hadn't.** The audit row was step 4, after `deleteUser` — so the one path where the record is the only surviving evidence produced no record. New **§6.2.1**: `attempted` row written *before* any destruction (abort if that insert fails), resolved to `succeeded`/`failed` in a `finally` with `storage_attempted`/`storage_deleted`/`error`. §3.6 gains `status` + `ended_at`, defaulting so non-destructive call sites are unchanged. Tests 20–24. |
| **Medium** — activation is still exact-email against a normalized allowlist | **Accepted.** New **§4.2.1**. The R2 eligibility fix admits the right invitee and then links nothing when the hand-typed invite row differs by case or whitespace — same silent orphaning, one comparison further down. Migration `016` — **renumbered `017` in v5, see §0.1** — backfill, canonical `CHECK` matching `allowed_emails`, and a normalized comparison in `activate_invites`. Worth noting the aggravating factor: `show_collaborators` has **no app write path at all** (4 read call sites, zero inserts), so every invite is hand-typed in the console — the least normalized source possible. Tests 12d–12f. |
| Hard delete acceptable for UAT **if failed attempts are audited** | Condition now met by §6.2.1 and gating on §6.3 shipping — that is the point of the two-phase row. |
| `app/admin/layout.tsx` is the right App Router boundary; API routes stay on `requireAdmin` | Confirmed — §3.4 and §3.2 unchanged. **Q4 closed.** |

Nothing declined. Three rounds, three docs, and Codex has found something real in
every one. Both R3 findings here are the same shape as R2's blocker: a rule
stated correctly in one place and violated by the mechanism in another. The
running lesson in [[project_showrunr_uat_readiness]] needs sharpening — it is not
only *"check whether a later section makes an earlier requirement
unsatisfiable"*, it is **"check whether the ordering of my own steps satisfies
the risk I just described."** §6.2 described the orphaned-files window and then
ordered the audit write outside it.

## 10c. Codex R4 — disposition

| Finding | Disposition |
|---|---|
| **High** — duplicate migration version `016` | **Accepted.** §4.2.1's new migration and §7's `profiles` read-scope change both claimed `016`. Mine renumbers to **`017`**. But the renumber alone would leave the next section to make the same mistake, so v5 adds **§0.1: an allocation table** covering `013`–`017` with section, contents, and the rule that any new migration takes the next free number *in the same edit*. The doc had grown migrations section by section with nowhere to see what was taken — that was the actual defect, and it is the fourth time in this document a fact was true locally and unenforced globally. |
| Use **trigger + CHECK**, not either/or | **Accepted, and it is a better answer than the question I asked.** I posed it as a trade — ergonomics (trigger) versus enforcement (CHECK) — and it isn't one. §4.2.1 step 2 now ships a `BEFORE INSERT OR UPDATE` canonicalizing trigger *and* the `CHECK`: routine console entry just works, and the invariant still holds if the trigger is dropped or bypassed. Test **12e-ii** drops the trigger and asserts the CHECK still rejects, since testing the trigger's effect alone would pass with no constraint at all. |

Nothing declined, in any round. Four rounds, three docs, and Codex has found
something real in every single one.

## 10d. Codex R5 — disposition

| Finding | Disposition |
|---|---|
| **High** — profile created, activation fails, retry can never activate | **Accepted, and it is my §4.2.3 that made it reachable.** Adding a `500` on activation error turned a silently-broken state into a *retryable-looking* one that the route then refuses at `:41-49`. New **§4.2.4** moves activation **before** the insert, so no failure leaves a profile without links. Of your two options I took only the ordering one, because the other doesn't help: `/claim` fetches `GET /api/profiles` on mount and renders **"Already claimed"** (`app/claim/page.tsx:21-38, 88-95`) — the form never appears, so route-level idempotence would fix an endpoint the tester cannot reach. I kept the `409`-branch re-run anyway as cheap defence (test 12m), and added an `/admin` **"Re-link invites"** action, because the ordering fix protects future claims and the window is **open in production right now**. Tests 12j–12n. |
| **Medium** — `017` should re-issue the revoke, not merely preserve it | **Accepted, and the distinction is the point.** `CREATE OR REPLACE` preserves the grant state — which preserves a *bad* one just as faithfully as a good one, and live drift from the Supabase SQL editor is invisible to the repo. Preservation is not enforcement. `017` now re-issues `REVOKE EXECUTE ... FROM public, anon, authenticated` explicitly: idempotent, converges drift, and puts the security requirement in the file that touches the function rather than only in §4.2.2's prose. Test 12i-a grants EXECUTE first and asserts `017` removes it. |

Nothing declined, in six rounds. **This round's high finding is the fourth time
in this document that a repair has introduced the defect class it repaired** —
R2's FK holes, R4's duplicate `016`, R5's grant trap, now R5's ordering. That is
specific enough to be a rule rather than an observation, and §4.2.4 states it:
*after adding an error path, ask what state the system is in when it fires, and
whether the user can get out of it. An error return is not a fix if it strands
the caller.*

## 11. Decisions for Graham before build

**Design review is closed at R6.** These are not review questions — several sat
across three or four rounds as "open questions for Codex" when they were always
direction calls, which is a large part of why this document took six rounds.
Each carries a **default**, so silence ships the default and none of them blocks
the build.

| # | Decision | Default if you say nothing |
|---|---|---|
| 1 | §6.2.1 makes `admin_audit` a hard dependency of deletion — no audit, no delete. Break-glass path? | **Ship as specified.** Right failure direction for an irreversible op; a break-glass path is the thing that gets used at 2am and skips the record |
| 2 | §0.1's allocation table is enforced by attention, which failed twice (v4's duplicate `016`, v9's stale row). CI check on migration filename uniqueness/contiguity? | **Skip for now.** Ten lines of CI, but at `012` the table plus invariant 8 is proportionate. Revisit if it drifts a third time |
| 3 | Should `/admin` **surface** stranded testers (collaborator rows with `user_id IS NULL` whose email matches a profile), rather than relying on someone remembering to press "Re-link invites"? | **Do it.** ~20 lines, and it converts a lever nobody will think to pull into something visible. The failure is invisible to the tester by construction |
| 4 | §6.3 — **soft delete** (`disabled_at`) for the UAT window instead of hard? Four rounds of conditional acceptance | **Ship hard delete.** Every condition is met and §6.2.1 records failures. But this is the one I'd most understand you reversing |
| 5 | The eligibility predicate under **sequences** — allowlist removed between OTP and claim, mode flipped mid-session. Three rounds confirmed the shape, none probed the race; §4.2.4 moved activation earlier, changing the window | **Ship, and treat the first chunk's tests as where this gets probed.** It is a build-time question now, not a design one |

Item 3 is the only one I'd actively push for; the rest are fine as they stand.
