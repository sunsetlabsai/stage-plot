# Design — one backend: retire Redis, consolidate on Supabase

Status: **APPROVED AND MERGED to `main` at `dc56c8e` (PR #150, 2026-08-24) after
Codex R1–R8. IN BUILD — chunk 0 shipped; build against this text.**
*(Superseded status: "PRE-CODEX, do not build". Corrected the moment building
started — a status line that still forbids the work in progress is the same
class of stale claim as §2.1's three unexecuted supersessions, and this document
does not get to exempt itself from its own subject.)*
Version: **v1.9** (**v1.9 = ★ the ROLES MODEL, ruled 2026-08-25: collaborators are
VIEW ONLY and the `editor` role is DELETED (new §3.3c); **conductor == owner for
now**, delegate deferred to backlog as session state rather than a role;
BYOA is owner-only in practice, so §4.1's "every user, owner or collaborator" is
corrected; the §8.1 spike is RESCOPED to owner-count cardinality; and two
previously unrecorded facts about the live system are written down — link-viewing
is a service-role bypass rather than RLS, and collaborator membership buys
discoverability rather than access. **v1.9 folded THREE Codex R1 findings on its
own first draft: (a) the chart RLS policies it called "live" died with `drop table
charts` in migration 003 — a "live today" claim verified against the migration
that CREATED a table rather than the latest one that touched it; (b) the role
inventory missed 3 sites (`is_show_collaborator`'s body, the dashboard list
select, the `(role)` badge); (c) `/api/shows/update` is PUT, not POST**) (v1 =
pre-Codex, v1.1 = Codex R1–R8 on #150, v1.2 = RBAC shelved +
Q5 reversed, **v1.3 = Codex R1 on #152: Q5 reversal propagated to the paired doc,
`ADMIN_SECRET` retirement specified for all four consumers (§3.3b)**, **v1.4 = Codex R2 residual: per-route reject AND accept cases for all four**, **v1.5 = ⛔ §3 `admin_config` RULED OUT 2026-08-25 — marker only**, **v1.6 = Codex R4 High: §9 chunk-1 tests were still an obsolete contract; rewritten, plus a blast-radius index**, **v1.7 = ⛔ THE RULED-OUT CONTENT IS DELETED, not marked**, **v1.8 = fold Codex R5: the chunk-5 completion check was an unscoped repo-wide `grep` that could never pass (§6.3, §9); and two claims that this one-file PR amends other files — the paired doc (§3.2, §7, §9) and `design-owner-onboarding.md`, which was listed as "corrected" at v1.3 and never was (§10)**)

**★ EDITING RULE, ruled by Graham 2026-08-25: ruled-out content is DELETED, not
marked.** v1.5/v1.6 retained the dead `admin_config` design "for its reasoning,"
which left ~140 lines of table schema and Vault wiring still readable as
instructions — red herrings in the one document meant to eliminate them.
**Reasoning lives in git.** Pre-deletion text:
`git show d5fe1a8:docs/design-single-backend.md`.

Scope:

- `lib/agent-key.ts` — Redis → Supabase (quota, chunk 2) + Vault (BYOA, chunk 3)
- `lib/admin-config.ts` — **Redis client stripped, chunk 1. Resolves from
  `process.env` alone.** No Supabase table, no Vault secret.
- **NO new `admin_config` table, and no `profiles` change.** Chunk 1 ships **no
  migration** (§3). Vault is still required by chunk 3 for `user_secrets`.
- `user_secrets` wired for per-account BYOA; `tryit_quota` wired for quota
- ~~`app/api/show`~~ — **deleted, chunk 0 shipped** (PR #151, `c24ef4f`)
- **`/admin` RE-AUTHED, not deleted** (§8 Q5, reversed) — `ADMIN_SECRET` →
  super-admin session-email check. **Platform config stays here.**
- **all FOUR `ADMIN_SECRET` route consumers re-authed** (§3.3b, new at v1.3) —
  `settings`, `owners`, `migrate-setlists`, `backfill-chart-overlays`
- new **`/dashboard/settings`** — **owner-scoped only**, v1 content is the
  owner's own agent API key (§4)

**Two surfaces, two principals, no overlap.** `/admin` is global and
super-admin-only; `/dashboard/settings` is the signed-in owner's own account.
Nothing global appears on the tenant page.

**All five open questions were ruled by Graham on 2026-08-24 (§8). Nothing in
this document is waiting on him**; the only unresolved item is the §8.1 spike,
which gates chunk 3's implementation choice, not the design.

**Lands together with `docs/design-ai-key-availability.md` v11+**, by Graham's
ruling 2026-08-24. That document carries §13 (unify key resolution) and a §14
tombstone whose forward references point at *this* file; neither may merge
alone.

---

## 0. Invariants this design establishes

1. **One backend.** After this, Supabase is the only persistence dependency.
   The `redis` package is removed from `package.json`.
2. **A key is never readable back.** No route, policy or UI path returns a
   stored BYOA key to any client, ever. Masked display only.
3. **Nothing claims to be replaced until its replacement has a caller.** The
   defect this whole document exists to correct is three supersessions that were
   designed, migrated and never wired (§2). A migration is not a migration until
   something calls it.
4. **Behavioural changes are stated, not absorbed.** Where Supabase behaves
   differently from Redis — and in one place it does — the difference is named
   and ruled on rather than discovered later (§5.3).

---

## 1. The decision, and whose argument settled it

**Graham ruled 2026-08-24: one backend, Supabase. Retire Redis.**

The reliability argument I initially offered was wrong and is recorded here so
it is not revived: *"fewer vendors is more reliable"* does not hold. Shows,
charts, auth and songs are already 100% Supabase, so **Supabase is already a
single point of failure for the core product.** Removing Redis does not
eliminate a SPOF — it concentrates everything onto the one that already exists.
Redis today is the only thing providing partial degradation.

**Graham's argument, which is the one that decides it:**

> *"AI is purely a 'construction' mode NOT the 'show' mode. So, having AI without
> show (i.e., when supabase is 'down') buys us nothing of consequence."*

Partial degradation is only worth paying for if the surviving mode is usable.
Nobody builds a stage plot while the app cannot serve shows. **The escape hatch
protects a mode that is already unavailable when it triggers**, so its value is
approximately zero — and it was the only real argument for a second vendor.

Two supporting facts, neither decisive alone:

- **The premise Redis was chosen under is gone.** `design-kv-admin-settings.md`
  opens *"ShowRunr currently has zero server-side persistence"* and argues **"Why
  Redis over Postgres"** from it. That was true on 2026-05-20. Supabase landed
  **2026-05-25**.
- **Vendor churn, twice.** `@vercel/kv` (Upstash REST) was sunset by Vercel in
  Dec 2024, forcing the PR #20 rewrite onto `redis` (node-redis) + Marketplace
  Redis Cloud. As of 2026-08-24 that offering appears to have changed again, and
  the store is unreachable in production.

---

## 2. What is actually in Redis — measured 2026-08-24

**Every negative below states the search that establishes it.** All were re-run
repo-wide across `app/`, `lib/`, `components/` and `tests/` on 2026-08-24; none
is scoped to production code only unless it says so.

| Key | Supabase equivalent | Status |
|---|---|---|
| `show:{slug}` | `shows` + `/api/shows/[owner]/[show]` | ✅ replaced — **the Redis route has ZERO callers and was never deleted.** *Scope: `grep -rn "api/show"` repo-wide excluding `node_modules`/`.next`/`docs`, plus a check that `next.config` declares no rewrites; the only hits are the route's own comments.* |
| `quota:{ip}` | `tryit_quota` + `increment_tryit()` (`001_initial_schema.sql:82`, `:234`) | ⚠ **built, migrated, ZERO callers.** Code still uses Redis. **Not a drop-in — see §5.2.** *Scope: `grep -rn "increment_tryit\|tryit_quota"` across `app/ lib/ components/ tests/`; every hit is in `docs/` or the migration itself.* |
| `admin:*` (3 keys) | **none** | ❗ the only genuinely Redis-only workload. *Scope: `grep -rn "admin_config\|app_config"` across `supabase/migrations/` returns nothing; the migration table list is `profiles, shows, show_collaborators, user_secrets, charts, chart_library, chart_calibration, songs, setlist_entries, tryit_quota`.* |
| — | `user_secrets.claude_api_key` (`:49`) | ⚠ table exists, **zero application code.** *Scope: `grep -rn "user_secrets"` across `app/ lib/ components/ tests/` returns nothing; all hits are in `docs/` and `supabase/migrations/`.* |

**⇒ The whole justification for the second vendor is three admin config keys** —
`google_client_id`, `google_client_secret`, `claude_tryit_key` — and every one of
their **reads** already falls back to an env var in `readAdminConfig`.

**And as of 2026-08-25 the write path does not need a store either.** Drive
retirement (PR #153) deletes the first two keys outright — 6 shows, 0 using
Drive. The third already resolves through the `CLAUDE_TRYIT_KEY` env fallback.
**Three keys became one, and one key does not justify a table**, let alone a
second vendor. Graham accepted the consequence explicitly: the try-it key is
changed via Vercel env + redeploy, not through a UI. See §3.

### 2.1 ★ The pattern this document exists to end

Three separate supersessions were **designed, documented, migrated, and never
connected**, with both halves left live:

1. `/api/show` — superseded by Supabase one day after it shipped;
   `design-supabase-backend.md:45` lists it in a replacement table and `:779`
   says *"replaces `GET /api/show`"*. Still in the tree.
2. `tryit_quota` + `increment_tryit()` — in the initial schema since May, never
   called.
3. `user_secrets` — flagged as dead in `design-ai-key-availability.md:189`
   (*"zero references in any `.ts`/`.tsx`"*), still dead.

**~~A fourth, found while writing this document (§4.2): `user_secrets`' RLS
policies were specified and never created.~~ RETRACTED at v1.1 — they WERE
created (`001_initial_schema.sql:149`, `:153`). The claim came from a
same-line `grep` that could not match a multi-line `create policy`, whose empty
result was then reported as proof of absence.** The correct state and the
ruling that replaces it are in §4.2. *Recorded rather than deleted: a retracted
finding in a document about undetected drift is itself worth seeing.*

**★ And a fifth, which contains the other four.** `design-supabase-backend.md`'s
own header reads **`Replaces: Redis (slugs, admin config, try-it quota)`** — the
*entire* retirement this document specifies was designed in **May 2026** and
partially executed. Shows, charts, auth and songs shipped; the three Redis
namespaces did not. That header claim has therefore been **true on paper and
false in production for fifteen months**, and its status line still reads
*"awaiting build approval"* for work that has been live for over a year.

**⇒ This document is not proposing a new direction. It is executing a decision
already taken, and its real contribution is finishing rather than deciding.**
The design work that matters here is §4 (BYOA under multi-tenant, genuinely new)
and §5.2/§5.3 (the two places the "already built" replacement turns out not to
be a drop-in). *(v1 also listed §3.3 admin RBAC as genuinely new. It was
**shelved** on 2026-08-24 — §3.3a — once the three-tier model made clear that
super-admin is a single principal and not a tenant concern. **v1.7: the
remaining work there is now ZERO new tables.** v1.6 said "one new table, not a
role system"; that table was `admin_config`, ruled out 2026-08-25. What remains
is an auth-boundary change and no schema at all.)*

**★ The Redis retirement is now the FIFTH instance of this pattern.** Measured
2026-08-25: `redis@^5.12.1` still in `package.json:25`, two live imports
(`lib/admin-config.ts:1`, `lib/agent-key.ts:2`). Design PRs #150/#152/#153
removed **zero** lines of Redis code; chunk 0 (#151) deleted a route that already
had zero callers. **The remedy is not more design — it is chunks 1 and 2, which
delete both imports and let the dependency go.**

**This is why invariant 3 exists.** Every chunk in §7 ships its caller in the
same PR as its schema. No chunk may land a table that nothing reads.

---

## 3. Admin config → environment variables. NO TABLE.

**RULED by Graham 2026-08-25. There is no `admin_config` table and chunk 1 ships
no migration.** `readAdminConfig` resolves from `process.env` alone.

**Why the table collapsed.** Its whole payload was three keys —
`google_client_id`, `google_client_secret`, `claude_tryit_key`. Drive retirement
(PR #153) deletes the first two. The third already rides the `CLAUDE_TRYIT_KEY`
env fallback. **A migration would have existed to hold one value that does not
need it.** Its write surface was a single caller, `PUT /api/admin/settings`
(`route.ts:61`).

**The accepted consequence:** the try-it key changes via Vercel env + redeploy,
not through a UI. *"try-it key IS just an admin function so as vercel env is
fine."* This reverses the 2026-08-24 "rotating a key should not require a
redeploy" rationale, which was argued for three keys and paying customers — not
for one key and one operator.

**What chunk 1 DOES ship:** the `/admin` re-auth across all four routes and the
`ADMIN_SECRET` retirement (§3.3a, §3.3b), plus stripping the Redis client out of
`lib/admin-config.ts`. Those are an auth-boundary change and a dependency
removal — neither depends on where config lives.

> **Deleted at v1.7:** the `admin_config` table design, its `create table`
> schema, the `updated_by` attribution rationale, and the 2026-08-24 "a table,
> not env vars" ruling it rested on. All recoverable at
> `git show d5fe1a8:docs/design-single-backend.md` §3–§3.1.

### 3.2 `readAdminConfig` collapses to env-only — a BEHAVIOURAL change, not a rename

**⛔ REWRITTEN at v1.7.** v1.6's index flagged this section as *"behaviourally
changed, NOT yet marked in place"* and left it saying the opposite. With no
table, there is no store, so the whole v1.1–v1.3 argument about *renaming* the
`source` discriminant to `'store'` is moot. **The union does not get renamed —
it loses a member.**

```ts
export type ConfigRead =
  | { status: 'ok'; value: string; source: 'env' }
  | { status: 'none' }
```

**Four states collapse to two.** `'store'` is unreachable because nothing stores
anything. `error` is unreachable because **an environment variable cannot be
unreachable** — `process.env` is a synchronous in-process read with no failure
mode. Today's shape is `source: 'redis' | 'env'` at `lib/admin-config.ts:33`.

**Ruling: narrow the type; do not keep `'store'` as a reserved member.** An
unreachable union member is the same class of trap as the `__DISABLED__`
sentinel this section deletes — a state the type says is possible, that no code
can produce, that a future reader writes a branch for. If a store ever returns,
adding the member back is one line.

**Cost, measured.** No production code branches on `source` — in `app/` and
`lib/` it appears only in its own type definition and the two `return`s that
populate it (`lib/admin-config.ts:33`, `:59`, `:74`). Four callers
(`agent/chat`, `charts/convert`, `charts/roadmap/parse`,
`admin/backfill-chart-overlays`) branch only on `status` and are unaffected.
It **is** asserted in tests: `tests/agent-key.test.ts:78` expects
`source: 'redis'` and must change (`:88`, `:119` expect `'env'`, unaffected).

**⚠ CROSS-FILE CONSEQUENCE — new at v1.7, and the index never listed it.**
`design-ai-key-availability.md` is already on `main` at v11.1 specifying
`source: 'store' | 'env'` (`:359`, `:907`). **That document now specifies a
state that can never occur.** It is the paired doc, it landed with #150, and
nothing in the v1.5/v1.6 marker passes touched it.

> **Sequencing:** the paired-doc amendment lands with the **chunk-1 build PR**,
> where `ConfigRead` actually changes in code and a test can prove the two
> documents agree. Amending a spec here, with the code three chunks away and
> nothing to pin it, is how `'store'` got into that file in the first place.
> **Recorded here so it cannot be lost**; §7 and §9 carry it as an explicit
> chunk-1 deliverable.
>
> *(v1.8 correction: this previously justified the deferral with "#152 is one
> file." **False** — #152 also amends `design-ai-key-availability.md`, at v1.3,
> for the Q5 reversal. The sequencing is right; that reason for it was not.)*

**The `__DISABLED__` sentinel is DELETED**, and now for a simpler reason than
v1.6 gave. It existed because Redis has no way to express "explicitly off" other
than a magic value, and it caused a real production trap: a field cleared in the
`/admin` UI suppressed the `CLAUDE_TRYIT_KEY` env fallback entirely. **There is
no longer any write path that could set it** — not "off is the absence of a
row," which presumed the table. It dies with the Redis client.

### 3.3a ★ The tier model — RBAC is SHELVED. Three tiers, one admin.

**Starting state, measured:** there is **no admin or role column anywhere in the
schema** — `profiles` is `id, owner_slug, display_name, created_at`
(`005_owner_namespacing.sql:5-10`); the only `role` columns are
`show_collaborators.role check in ('editor','viewer')` and chart instrument
roles. `/admin` authenticates today with the shared bearer secret `ADMIN_SECRET`
(`lib/admin-rate-limit.ts:44-49`), entirely outside Supabase auth.

*(This paragraph records the state measured on 2026-08-24 and stays accurate as
history. **`show_collaborators.role` is DELETED by §3.3c** — do not read it here
as a current-state claim.)*

*(§3.3 — the deleted `profiles.is_platform_admin` analysis — is at the SHA above.
This section keeps the number `3.3a`: it is cited 6× below and once cross-file at
`design-ai-key-availability.md:917`, already on `main`.)*

**Graham clarified the model 2026-08-24, and it dissolves the question rather
than answering it:**

| Tier | Who | Scope | Mechanism |
|---|---|---|---|
| **Platform super-admin** | Graham, and only Graham | The platform itself: try-it key, Google OAuth secrets | **Env var identity check.** No column, no role, no migration |
| **Owner** (tenant) | Anyone who claims a slug | Their own shows, library, and **their own BYOA key** | Existing `profiles` + `auth.uid() = user_id`. Unchanged |
| **Collaborator** | A bandmate invited by an owner | One show, **VIEW ONLY** | `show_collaborators` membership. **No role.** See §3.3c |
| **Anyone with the link** | No account required | Views any show by `owner/show` slug pair | The route, **not RLS**. See §3.3c |

> *"if admin = me … and is the super-admin for the platform itself, and NOT
> related to owner (i.e., a tenant) or a user/collaborator (i.e., a bandmate
> invited w/ view access by an owner), then we can shelve this item for now
> leaving me as the ONLY admin. When/if we need an additional admin or admins,
> we can enhance."*

**⇒ `profiles.is_platform_admin` is NOT built. There is no migration to
`profiles` in this chunk.** Admin identity is a server-side comparison of the
authenticated session's email against an env var. One principal, no role system.

**The identity, ruled 2026-08-24:**

| Env var | Value | Notes |
|---|---|---|
| `PLATFORM_ADMIN_EMAIL` | **`graham@sunsetlabs.ai`** | The super-admin. Not a tenant; holds no shows or library. |

**Also ruled, and it matters for testing:** **`Graham.Edwards@gmail.com` is a
separate OWNER account** and is where the real show and library assets live —
including the 341 imported lyric PDFs. It **stays**, untouched. Signing in as the
super-admin therefore shows the platform surface and **no library**, because the
content belongs to a different principal. That is the model working, not a bug.
(`graham@salonhq.co` is disposable — *"don't care if we nuke"* it.)

**Comparison rules, normative — a sloppy check here is an auth bypass:**

1. Read the email from **`supabase.auth.getUser()` server-side**, never from a
   client-supplied value and never from a JWT claim decoded in the browser.
2. Compare **case-insensitively**, both sides trimmed. Graham wrote the owner
   address as `Graham.Edwards@gmail.com`; a case-sensitive `===` against a
   lowercased session email fails open or closed depending on which side drifts,
   and neither failure is acceptable.
3. **Fail CLOSED when `PLATFORM_ADMIN_EMAIL` is unset or empty.** An unset
   variable must never mean "everyone is admin" — the same class of trap as the
   `__DISABLED__` sentinel this design deletes (§3.2).
4. The check is enforced **in the route**, not by hiding UI. Hiding a section is
   presentation; the route is the control.

**Why an env var is the RIGHT mechanism here and not a shortcut:** the two
things have opposite change rates. **Keys rotate often** — which is exactly why
§3 puts config in a table rather than env vars. **Who is an admin changes
almost never.** Paying a redeploy to add an admin is correct; paying one to
rotate a key is not. Splitting them that way is coherent, not lazy.

**★ WHY OWNER-AS-ADMIN WAS NOT AVAILABLE**, recorded so it is not re-proposed:
**"owner" is not a privileged tier — it is what every user becomes.**
`POST /api/profiles` (`app/api/profiles/route.ts:12`) gates only on slug format
and reserved words, and sign-in is `supabase.auth.signInWithOtp({ email })` —
open email OTP, no allowlist. The invite mechanism only links a signed-in user
to pending `show_collaborators` rows; it does not gate signup. **PR #123, which
designs an invite gate, is still OPEN and was never built.** So owner-as-admin
would put the platform's Anthropic key and Google OAuth secret one self-serve
signup away from any address on the internet.

**What owners get, unchanged by this chunk:** their own library (already works,
owner-scoped) and their own agent API key (§4 — `user_secrets`, per account,
with the storage choice of §4.5). Nothing here restricts a tenant.

**When a second admin is needed**, `profiles.is_platform_admin` becomes a small
additive migration with a real reason behind it. The design above is retained
for that day rather than deleted.

**`ADMIN_SECRET` retires; `/admin` does NOT.** The shared bearer secret is
replaced by the session-email check on the same route (§8 Q5, reversed).

### 3.3b ★ `ADMIN_SECRET` retirement — every consumer, ruled

**Added at v1.3 (Codex R1 on PR #152, High).** v1.2 said `ADMIN_SECRET` retires
while discussing only `/api/admin/settings`. **`ADMIN_SECRET` has four route
consumers, not one** — measured, not recalled:

```
$ grep -rn "authenticate(request)" app lib
app/api/admin/settings/route.ts:11              (GET)
app/api/admin/settings/route.ts:33              (PUT)
app/api/admin/owners/route.ts:11
app/api/admin/backfill-chart-overlays/route.ts:113
app/api/admin/migrate-setlists/route.ts:24
```

Retiring the env var without ruling on all four leaves three routes calling
`authenticate()`, which returns `false` the moment `ADMIN_SECRET` is unset
(`lib/admin-rate-limit.ts:45-46`) — they would fail closed, which is safe, but
they would be **silently dead**, which is the §2.1 pattern again.

**RULING: all four are re-authed with the identical super-admin email check.**
One boundary, one implementation, no per-route variation. Deleting the two
one-shot ops routes is defensible but is **not** this chunk — a dead route is
cheaper to carry than a second auth path is to reason about.

| Route | Ruling | Note |
|---|---|---|
| `admin/settings` GET+PUT | **re-auth** | the `/admin` page's own backend |
| `admin/owners` | **re-auth** | see the degradation note below |
| `admin/migrate-setlists` | **re-auth** | one-shot ops tool; deletion is separate work |
| `admin/backfill-chart-overlays` | **re-auth** | one-shot ops tool; deletion is separate work |

**The check is normative and identical in all four:** server-side
`supabase.auth.getUser()`; require a non-empty user email **and** a non-empty
`PLATFORM_ADMIN_EMAIL`; trim and lowercase both; compare; fail closed on any
missing input; enforce **before** any service-role work. Never a client-supplied
email, never a browser-decoded JWT, never `getSession()`, never UI hiding.

**⚠ One designed behaviour dies with `ADMIN_SECRET`, deliberately.**
`design-owner-onboarding.md:61` specifies that `/api/admin/owners` validates the
secret *independently of KV*, so that when settings 503s on an unreachable store
the owner list still renders. **That rationale retires with Redis.** Both routes
now read the same Postgres: if it is unreachable neither can serve, so there is
no partial-availability case left to preserve. The split was a workaround for
two stores, not a requirement. Recorded here because deleting a degradation path
silently is how the next reader concludes it was never wanted.

---

### 3.3c ★★ Collaborators are VIEW ONLY — the `editor` role is DELETED

**Ruled by Graham 2026-08-25.** §3.3a's collaborator row previously read
*"`editor` or `viewer` … Existing `show_collaborators.role`. Unchanged"*. That is
now wrong in both halves: the role is deleted, and the schema does change.

> *"Collaborators are the band members or sound engineers who 'view' the show
> details. They don't create or modify show details. … I don't see a need at the
> moment for a role for collaborators. And they're definitely NOT owners, i.e.,
> owner != collaborator. Though indeed an owner could collaborate in someone
> else's (some other owner's) show."*

**Why, in his words:** *"The original thinking was that collaborators could
upload their charts but this seems like a bad idea and of little value given they
can email or share charts for the owner to upload. And if they want to use it to
'create' their own charts, they can become an owner."* The upgrade path costs
nothing — `POST /api/profiles` gates only on slug format (§3.3a above), so
becoming an owner is self-serve.

**⚠ This is a PRIVILEGE REMOVAL, not a cleanup.** `editor` is live today, **in
three layers — schema, RLS, and application code.** Enumerated in full, because
the failure mode this document exists to end (§2.1) is a change that lands in one
layer and is called done:

| Layer | Site | What it does with `role` |
|---|---|---|
| Schema | `001_initial_schema.sql:39` | `role text not null check (role in ('editor','viewer'))` |
| RLS | `002_fix_rls_recursion.sql:39` `"Editor update"` | **UPDATE `shows`.** The ONLY surviving `'editor'` grant — see the correction below |
| RLS helper | `002_fix_rls_recursion.sql:15` | `is_show_collaborator(p_show_id uuid, p_role text default null)` — the function **body reads `role`**. Dropping the column breaks it, and BOTH policies that call it |
| **Code** | `app/api/shows/update/route.ts:61` | `if (!collab \|\| collab.role !== 'editor') → 403`. **A service-role route** (`getSupabaseAdmin()`), so RLS is bypassed and **this check IS the control** |
| **Code** | `app/[owner]/[show]/page.tsx:521` | `if (collab?.role === 'editor') isEditorFlag = true` → drives `setIsEditor`, gating edit affordances |
| **Code** | `app/api/shows/route.ts:45, :74` | Dashboard list **selects and returns** `role` |
| **Code** | `app/dashboard/page.tsx:16, :290` | Types it (`role?: string`) and **renders it as a visible badge** — `(editor)` / `(viewer)` next to the show |

**⛔ CORRECTION, Codex R1 on this PR — the first draft of this table was STALE and
listed four chart policies that no longer exist.** `002_fix_rls_recursion.sql:53-64`
does create `"Chart insert/update/delete"` with `is_show_collaborator(show_id,
'editor')` — but **`003_chart_library.sql:13` does `drop table charts`**, and
dropping a table drops its policies with it. The replacement, `chart_library`, was
created **owner-only from the start** (`003:58-68`, all three write policies are
`auth.uid() = owner_id`). **There is no editor grant on charts and has not been
since migration 003.** A chunk-6 migration following the first draft literally
would have targeted a table that does not exist.

★ This is the §2.1 defect committed inside the document that exists to end it: the
inventory was built by reading 001 and 002 and **never checking whether a later
migration superseded them.** The rule that would have caught it — *state the
search that establishes a negative* (§2) — applies to positives too. **Any claim
that a policy is "live today" must be verified against the LATEST migration that
touches its table, not the one that created it.**

**★ The application layer matters most, and a migration-only reading misses it.**
`PUT /api/shows/update` authorizes through the *service role*, not RLS — so
dropping the RLS grant alone does **not** close that path. If the migration drops
`role` while the route still reads `collab.role`, the comparison evaluates against
`undefined` and returns 403 for every collaborator: the *correct* outcome by
accident, on dead code asserting a concept that no longer exists. **All four code
sites are chunk 6, not follow-up.**

**Measured before ruling, 2026-08-25:** `select role, count(*) … from
show_collaborators group by role` returned **NO ROWS** — the table is *entirely
empty*, not merely free of editors. **Zero users lose access; no data migration
is required.** Re-measure before the migration runs; this claim is a measurement
with a date on it, not a standing fact.

**Migration shape** (build chunk, not this PR). `role` is `NOT NULL` with a check
constraint, so a narrowed constraint would be rejected by any surviving `'editor'`
row — convert first, then narrow, even though the count is currently zero:

1. **Code first, schema last** — the reverse order leaves a window where live
   routes read a column that no longer exists.
   - `app/api/shows/update/route.ts:61` — the whole `if (show.owner_id !==
     user.id)` block collapses to a 403. A non-owner cannot update a show.
   - `app/[owner]/[show]/page.tsx:521` — the collaborator lookup goes away and
     `isEditorFlag` derives from ownership alone. **Check whether `isEditor`
     survives as a distinct flag at all** — if it becomes `=== isOwner`
     everywhere, collapse the two rather than leaving a synonym.
   - `app/api/shows/route.ts:45, :74` — drop `role` from the select and from the
     returned object.
   - `app/dashboard/page.tsx:16, :290` — drop the field from the type and the
     `(role)` badge from the render. **The badge is the user-visible part of this
     change**: collaborators currently see `(viewer)` next to shared shows. With
     one legal value it conveys nothing, so it goes rather than becoming a
     constant label.
2. `update show_collaborators set role = 'viewer' where role = 'editor';`
   (Currently a no-op — the table is empty — but the migration must not *assume*
   that; see the measurement note above.)
3. **Drop `"Editor update"` on `shows`** (`002:39`). It is the **only** surviving
   `'editor'` grant. *(The chart policies died with `drop table charts` in 003 —
   see the correction above. There is nothing to recreate.)*
4. **Then fix `is_show_collaborator` — and ORDER MATTERS.** Its body reads `role`
   (`002:15`), so the column cannot be dropped while it stands. Postgres will not
   let the function be dropped while a policy depends on it either, so:
   **drop the dependent policies first → then replace the function → then drop the
   column.** `p_role` should be removed from the signature rather than left as an
   ignored parameter; a parameter that silently does nothing is the next reader's
   trap. Note this is a **signature change**, so `create or replace` is not enough
   — `drop function is_show_collaborator(uuid, text)` and recreate as `(uuid)`.
   **`"Collaborator read"` on `shows` calls it and must be recreated against the
   new signature in the same migration.**
5. Then **drop `role` entirely.** *(The alternative — narrowing the check to
   `('viewer')` — is rejected: a `NOT NULL` column with one legal value carries no
   information, and leaving it invites a future `'editor'` to be re-added by
   someone reading the constraint as a menu.)*

**Tests this chunk must ship** (§0 invariant 3 — nothing is settled without
something exercising it):
- A collaborator **cannot** update a show via **`PUT /api/shows/update`** → 403.
  *(The method is `PUT`, not `POST` — `app/api/shows/update/route.ts:21`. Named
  because a test written against the wrong verb passes for the wrong reason:
  the route 405s and the assertion still sees "not 200".)*
- An **owner** still can → 200. **This is the counterexample test**: a migration
  that over-deletes — dropping `"Collaborator read"` without recreating it, or
  breaking the helper — passes the first test and fails this one. Without it,
  over-deletion reads as success.
- A collaborator can still **READ** a show they were invited to, and it still
  appears on their dashboard. *(§3.3c's whole point is that membership survives as
  discoverability. A migration that removes the role by removing the membership
  would pass every other test here.)*
- An owner can still insert/update/delete rows in **`chart_library`** (not
  `charts` — it does not exist).
- The show UI exposes no edit affordance to a collaborator.

**★ Two facts about the current system that this document has never recorded.**
Both were verified 2026-08-25 by reading the code, and both change what the
tier table above means.

**(1) Link-viewing is real, and it comes from a SERVICE-ROLE BYPASS — not RLS.**
`app/api/shows/[owner]/[show]/route.ts:50` is commented *"anonymous show
resolution by owner + slug (no auth required)"* and reads through
`getSupabaseAdmin()`, which bypasses row-level security entirely. There is **no
anon SELECT policy on `shows`** — `"Owner read own shows"` (`001:96`) and
`"Collaborator read"` (`001:100`) both require an `auth.uid()`, and both are
therefore **dead on the public path**.

> **⛔ NORMATIVE CONSEQUENCE.** If private or unlisted shows are ever wanted,
> **RLS will not deliver them — that route will.** Anyone who reads the `shows`
> policies as the access-control model will draw the wrong conclusion. Any future
> privacy work starts at
> `app/api/shows/[owner]/[show]/route.ts`, not at a migration.

**(2) Collaborator membership buys DISCOVERABILITY, not access.** Because
link-viewing is already public, a `show_collaborators` row grants no read
capability the link did not already grant. What it grants is placement:
`app/api/shows/route.ts:42` lists *"shows I collaborate on"* separately from
*"shows I own"*, so an invited show appears on the collaborator's dashboard.

**That IS the feature, and it is the whole answer to "why keep the table at
all".** Stated here because it is non-obvious from the schema — a reader who
assumes membership is an access grant will conclude the table is redundant with
the public route and propose deleting it.

**Owner ≠ collaborator, but the sets overlap.** An owner may hold a
`show_collaborators` row on another owner's show; `show_collaborators.user_id`
references `auth.users` with no owner exclusion, so this already works and needs
no change. "Owner" is a property of a *show*, not a badge on a *person*.

**⚠ TWO OTHER DESIGN DOCS ASSUME `editor` EXISTS. Enumerated, NOT edited here.**
This PR deliberately does not touch them — §10's rule is that one document does
not silently amend another, and v1.8's changelog records that exact defect. They
are listed so the ruling does not have to be rediscovered later:

**⛔ The first draft of this table listed TWO documents. A repo-wide sweep found
SIX.** Recorded as a process note, not just a correction: the first pass grepped
`editor` and eyeballed the hits; the complete pass grepped the *concept* — `editors
`, `an editor`, `show editor` — across all of `docs/`. **Enumerating by keyword
found less than enumerating by claim.**

| Document | What it assumes | Disposition |
|---|---|---|
| `design-conductor-ux-polish.md:93-97, 140-141` | A **deliberate owner-vs-editor asymmetry** for BPM-in-show: *"editors keep per-show `key`/`lead`, but song-level tempo stays owner-only"* | **✅ AMENDED IN THIS PR.** The asymmetry collapses; the `isOwner` gate itself was already correct. See below |
| `design-supabase-backend.md:262, 352, 912` | The most direct contradiction: *"Editor has full show update access, same as owner minus collaborator management and deletion … editors are trusted collaborators (bandmates, sound engineers), not restricted guests. RLS is correct as-is."* | **⚠ STALE, but already subordinated** — it carries a `⚠ PARTIALLY BUILT — read design-single-backend.md first` banner and a §10 supersession notice. **Not edited here.** Its tier table is now wrong in substance and should be corrected when that doc is next opened |
| `design-song-library.md:40` | *"All collaborators (editor + viewer): Read-only … If an editor needs a song that doesn't exist, they ask the owner"* | **⚠ SUBSTANCE IS ALREADY CORRECT** — it says collaborators are read-only, which is exactly the new model. Only the `(editor + viewer)` enumeration is stale. **One-line fix, deferred** — no behavioural claim changes |
| `uat-readiness-gaps.md:195, 244` | Two gap scenarios framed on editors: *"locks an editor out of saving anything"*, *"Two editors at soundcheck: last write wins"* | **⚠ AFFECTED — the second may DISSOLVE.** Concurrent-editor write contention cannot occur if only the owner writes. **Not edited here** (a gaps list is not a spec), but gap 244 should be re-evaluated rather than carried forward |
| `design-alpha-ready.md:164, 389` | *"an editor's collision check would search the wrong namespace"* | **✅ CHECKED, UNAFFECTED.** It resolves `owner_id` from the show row precisely so it does not depend on who is editing |
| `design-roadmap-key-resolution.md:302` | *"an editor action on the chart itself … a builder-editor concern"* | **✅ CHECKED, FALSE POSITIVE.** "Editor" here means the chart-editing **UI**, not the collaborator role. Listed so the next sweep does not re-flag it |

**⇒ Only `design-conductor-ux-polish.md` is amended in this PR.** The first draft
deferred even that on §10 grounds. That was wrong: §10's rule exists so a document
is not *silently* amended, and the defect v1.8 records is an amendment **claimed
but never made**. Shipping v1.9 while knowingly leaving a contradicting document
would be the §2.1 pattern again.

**The other three affected documents are deliberately NOT edited**, and the line
is drawn on **blast radius, not effort**: the conductor doc's asymmetry is
reasoning that a builder would *act on*, so a stale version misdirects work.
`design-supabase-backend.md` is already banner-flagged and superseded;
`design-song-library.md`'s substance is already right; `uat-readiness-gaps.md` is
a findings list, not a spec. **Each is named above with its disposition so this
is a scoping decision on record rather than an omission.** They are Graham's call
whether to fold into chunk 6 or leave until those documents are next opened.

**The conductor ruling itself, Graham 2026-08-25:**

> *"we either just make that a realtime delegate or we just for now 'presume'
> it's the 'owner.' The conductor, to some degree, will own the show anyway. Just
> nice to be able to say 'hey, here you go, you lead/direct this song or set' but
> not required."*

**⇒ RULED: conductor == owner, for now.** No new principal, no column, nothing
added to the tier table in §3.3a.

**★ The delegate idea is BACKLOG, and the distinction is load-bearing.** "Hand
this song to someone to lead" is **session state — transient, per-song — not a
permission tier.** If it is ever built, it is built as ephemeral realtime
delegation layered over an existing owner relationship. **Building it as a stored
`role` column would recreate the exact `editor` mistake this section deletes.**
Recorded here so the next reader does not reach for the obvious schema.

## 4. BYOA → `user_secrets` — the §14 re-spec

### 4.1 Why it moved off `localStorage`

The removed §14 specified `localStorage`, explicitly *"no settings framework, no
schema, no persistence layer"*. That is a **per-browser** key. Graham ruled
2026-08-24 that ShowRunr is **multi-tenant SaaS**, where a key must follow the
**account** — new device, cleared cookies, second band member, and the key is
gone. For a commercial product that is a support burden, not a v1 shortcut.

**No RBAC is required for this and none should be added.** `user_secrets.user_id`
is the primary key referencing `auth.users`; the entire authorization rule is
`auth.uid() = user_id`. A BYOA key is not attached to a show, so it is not
show-scoped and no collaborator check belongs in this path.

**★ BYOA is OWNER-ONLY in practice — corrected at v1.9.** This section previously
ended *"Every user, owner or collaborator, has exactly one key that is theirs."*
**That is wrong**, and the reason matters more than the correction:

- **Not because collaborators are restricted.** Adding an "is an owner" test to
  `auth.uid() = user_id` would be exactly the RBAC this section forbids — and
  worse, "is an owner" is *derived* (it changes as shows are created and deleted),
  so it is not a stable predicate to authorize against.
- **But because collaborators have no AI surface to spend a key on.** §3.3c
  ruled them **view only**. AI is construction-mode, and construction is what
  owners do. A view-only principal has nothing to call Anthropic *for*.

**⇒ The authorization rule is UNCHANGED — still `auth.uid() = user_id`, still no
role check.** What changes is the expected *population*: rows in `user_secrets`
track the number of **owners**, not the number of users. Nothing needs to
enforce that; it falls out of who has a reason to set a key.

**This is the load-bearing input to the §8.1 spike** — it moves the cardinality
question by an order of magnitude. See §8.1.

### 4.2 `user_secrets`' actual RLS state — and why the write policies must GO

**⚠ Corrected at v1.1 (Codex High). The v1 text of this section asserted the two
write policies "were never created" and that the table had "no policies at all".
That was FALSE.** Both exist — `001_initial_schema.sql:149` (`"User write own
secrets"`, insert) and `:153` (`"User update own secrets"`, update). The claim
came from a `grep` that required `user_secrets` and `policy` on the **same
line**, which a multi-line `create policy … on user_secrets …` can never
satisfy; the empty result was then reported as proof of absence. **The
conclusion §4.6 drew from it — that write-only is enforced by a zero-policy
database — was therefore also false.**

**The actual state, verified multi-line:**

| Operation | Policy | Effect on an authenticated browser client |
|---|---|---|
| `select` | **none** | **denied** — cannot read any key, including its own |
| `insert` | `auth.uid() = user_id` | **allowed** |
| `update` | `auth.uid() = user_id` | **allowed** |
| `delete` | **none** | **denied** |

**The write-only property SURVIVES, for a different reason than v1 claimed.** It
comes from the **absence of a SELECT policy**, not from an absence of all
policies. A user can write their key and can never read it back. `service_role`
bypasses RLS and does the server-side read.

**Ruling: DROP both write policies. Writes go through a server route.** The
reason is not the retired premise — it is forced by two facts:

1. **§8.1 puts the key in Supabase Vault.** An authenticated browser client
   cannot create a Vault secret; only the server can. So a client-side insert
   path cannot produce the encrypted representation the design requires.
2. **There is no DELETE policy**, so §4.6's mandatory **Remove** action cannot
   work client-side either.

⇒ Writes must be server-side regardless. Leaving the insert/update policies in
place preserves a **second, unused write path** that could store a plaintext key
directly into a column the rest of the design assumes holds a `vault_secret_id`.
That is a live foot-gun, not harmless dead weight.

**This document supersedes `design-supabase-backend.md`'s `user_secrets` policy
block** — not because the policies were never built, but because the Vault
decision retires them.

### 4.3 The three §14 rulings, carried forward

**Condensed restatements — not verbatim text** (Codex Low; v1 said "restated
verbatim", and these are summaries). Each preserves the ruling and its reason,
which is what must not be lost. **The full original wording is at
`a624650:docs/design-ai-key-availability.md` and remains the reference** where
exact phrasing matters.

1. **The overlay is settled spec**, and the reason is data loss: navigating away
   from the show page destroys restored composer text, because **no product path
   reads the prompt cache back.** `page.tsx:47` imports only `rememberPrompt`,
   and `readPrompts`' sole production use is **internal de-duplication inside
   `rememberPrompt`** (`lib/prompt-cache.ts:78`); it is also exercised
   throughout `tests/prompt-cache.test.ts`. A plain link would cause the exact
   data loss §5.2a exists to prevent. *(Codex R7 Medium: earlier wording said
   `readPrompts` "has zero callers" — false as written, and inherited unchecked
   from the section this one restates. The ruling's basis is unaffected.)*
2. **§5 states 5, 6 and 7 keep their condition, copy and `canSend` behaviour.**
   Only the inline key input becomes an affordance opening the overlay. Current
   mechanisms: `canSendMessage({ availability, streaming, hasPendingTools })` at
   `page.tsx:5528`, `availability.showKeyField && !apiKey` at `:5529`, both via
   `lib/agent-availability`.
3. **BYOA extends to every AI surface**, reversed from try-it-only on the grounds
   that one entry surface dissolves the stale-second-input objection.

### 4.4 ★★ The escape hatch — resolved, not inherited

The removed §14.6 argued BYOA's reliability value is that `resolveKeyMode`
returns **before touching any store** (`agent-key.ts:189-198`), pinned by
`expect(redis.getCalls).toBe(0)`. **Moving BYOA server-side breaks that
property**, and with Redis retired one Supabase outage takes shows, charts,
auth, try-it and BYOA down together.

**Ruling: accept it, on Graham's construction-vs-show argument (§1).** A BYOA key
that still resolves while the app cannot load a show buys nothing. The escape
hatch was worth its complexity when it protected against *one* vendor failing;
it is not worth it when the surviving capability is unusable.

**What must change, and this is the part that would otherwise rot:**
`tests/agent-key.test.ts`'s `expect(redis.getCalls).toBe(0)` pins a property —
*BYOA resolves without external I/O* — whose **justification** dies here even
though the assertion still passes. It must be renamed and its comment rewritten
to state the surviving reason (**a BYOA request must not be slowed by, or
coupled to, config infrastructure it does not need**) rather than the retired
one. An assertion whose stated reason is false is worse than no assertion —
a later reader deletes it as obsolete.

### 4.5 ★ Storage is the USER's choice, not ours

Storing a third party's API credential makes ShowRunr a **custodian**. That is a
posture change, not a feature detail.

**The settings surface offers two options, and the user picks:**

| | Stored | Follows the account | Custodial risk |
|---|---|---|---|
| **Remember on this device** | `localStorage` (today's `lib/byoa-key-storage`) | no | none — we hold nothing |
| **Save to my account** | `user_secrets`, service-role only | yes | ours |

This puts the decision with the person whose key it is, and means keys are held
only for users who explicitly asked. `lib/byoa-key-storage` is **not deleted** —
it becomes one of two backends behind one UI.

### 4.6 Security requirements — normative

1. **Write-only.** No route, policy or UI path returns a stored key. Display is
   masked (`sk-ant-…4f2a`) with **Replace** and **Remove** only. **Enforced at
   the database by the absence of a SELECT policy on `user_secrets`**
   (§4.2) — so even a browser client holding a valid session cannot read its own
   key back. *(v1 attributed this to a "zero-policy state"; that was wrong. The
   guarantee holds, but it comes from the missing SELECT policy specifically.)*
2. **Never in a JWT or `user_metadata`** — `user_metadata` is user-editable and
   can ride in auth token claims (`design-supabase-backend.md:141`).
3. **Never logged.** Explicit scrubbing on every error path that can carry a
   request body or header. **A key in a Vercel log or an error trace is a far
   likelier leak than a database breach**, and it is the one that gets forgotten.
4. **Cascade on account delete** — already present via
   `references auth.users(id) on delete cascade`.
5. **Consent at the point of entry.** Plain language stating what is stored, who
   can read it, and how to remove it, plus a privacy-policy line. Table stakes
   for a commercial product.
6. **Blast radius, stated so the risk is calibrated:** an Anthropic key is
   revocable by its owner and scoped to their own billing. That is not a reason
   for laxity; it is context for proportionate controls.
7. **Encrypted at rest via Supabase Vault** (§8.1). `user_secrets` stores a
   `vault_secret_id`, never the key. **Not** pgsodium, and **not** Transparent
   Column Encryption — the vendor recommends against both. Gated on the §8.1
   scale spike.

---

## 5. Quota → `tryit_quota`

### 5.1 What exists

`increment_tryit(p_ip_hash text, p_limit integer, p_window_days integer)` —
`001_initial_schema.sql:234`. Atomic via `insert … on conflict do update`,
`security definer`, and `revoke execute … from public, anon, authenticated` so
only the service role may call it. **Zero callers** — *scope: `grep -rn
"increment_tryit\|tryit_quota"` across `app/ lib/ components/ tests/`; every hit
is in `docs/` or the migration that defines it.*

**Privacy improvement, free:** the parameter is `p_ip_hash`. Redis stores the
**raw IP** in `quota:{ip}`. **Nothing hashes IPs today** — *scope: `grep -rn
"createHash\|sha256\|bcrypt\|hashIp\|ip_hash"` across `app/ lib/ tests/`; the
only hashing in the repo is sha256 of PDF bytes for chart versioning
(`lib/chart-calibration.ts:1167`), and every `getClientIp`/`getIp` consumer
passes the address through unmodified.* Migrating removes raw IPs
from persistence.

### 5.2 ★ It is NOT a drop-in — the peek path does not exist

**Correcting an overstatement made while investigating this on 2026-08-24:**
`increment_tryit()` was described as already-built and merely unwired. It is
built, but it is **incomplete for the current contract.**

`resolveKeyMode` requires `quota(ip, consume)` with **`consume: false`** — a
tab-open must not cost a free message, which `design-ai-key-availability.md` §4
makes a hard requirement and chunk 1 implemented as a flag rather than a sibling
function. **The deployed function only increments.** There is no peek.

⇒ A companion `peek_tryit(p_ip_hash text, p_window_days integer) returns integer`
is required, with the **same window-expiry logic**, in the same migration. It
must not be open-coded as a `select` in the route: the window-reset rule would
then exist in two places and drift, which is the defect §4 of the key-availability
doc argues against generally.

### 5.3 ★★ The window semantics CHANGE — this is a behavioural difference, not a port

| | Redis (today) | Postgres (`increment_tryit`) |
|---|---|---|
| Mechanism | `expire(key, 30d)` called on **every** `incr` | `window_start` reset only once the window has elapsed |
| Semantics | **Sliding** — 30 days from *last* message | **Fixed** — 30 days from *first* message in the window |

**Consequence:** a user sending one message every 29 days never resets under
Redis, and resets every 30 days under Postgres.

**Recommendation: take the fixed window.** It is what "50 messages per 30 days"
actually means, and the sliding behaviour was an artifact of TTL being the only
expiry Redis offers, not a decision anyone made. **But it is a real change in
what users get and it must not be smuggled in as a port.**
**✅ RULED by Graham 2026-08-24: fixed is fine.**

### 5.4 `fallbackQuota` stays

The in-memory `Map` (`agent-key.ts:88`) remains as the degradation path when the
database is unreachable. Its known weakness is unchanged and acceptable: it is
per-process, so it does not enforce globally across serverless instances. It is
a safety valve, not an accounting system.

---

## 6. Deletions

1. **`app/api/show/route.ts`** — zero callers, verified by whole-repo sweep and
   by confirming no rewrites in `next.config`. Superseded 2026-05-25. Its
   `show:{slug}` data is **not migrated**: nothing reads it, the keys carried a
   90-day TTL, and the store is currently unreachable. **✅ RULED by Graham
   2026-08-24: old slug URLs are not a concern.** No migration, no redirect.
2. **`lib/admin-config.ts`'s Redis client** and the `__DISABLED__` sentinel.
3. **`redis` from `package.json`** (`"redis": "^5.12.1"`, `package.json:25`) —
   **the last PRODUCTION RUNTIME import goes with CHUNK 2.**

   **The completion check is an AST import scan over production source, NOT a
   grep.** Extend `importSpecifiers()` (`tests/redis-retirement.test.ts:82`) from
   its current `app/api/` scope (`:20`, `:228`) to **`app/`, `lib/`,
   `components/`** and assert zero specifier equal to `redis` or starting
   `redis/`. Keep the walker's positive control (`:342`) so an empty result
   cannot come from an empty file list.

   > **⛔ CORRECTED at v1.7 (Codex R5).** This said the check was
   > `grep -rn "from 'redis'"` returning nothing. **That is false repo-wide and
   > would never pass**: `tests/redis-retirement.test.ts:240` deliberately
   > contains Redis import strings as scanner fixtures, and `docs/` contains the
   > phrase in prose — including this line. A raw grep cannot distinguish a
   > runtime import from a fixture, a comment, or a sentence about imports.
   > **Scope and mechanism both matter: production source only, parsed not
   > matched** — which is what chunk 0's five review rounds already concluded.

   > **⛔ CORRECTED at v1.7 — this said "chunk 3". That was a measurement error,
   > wrong when written, independent of the `admin_config` ruling.** The
   > production imports are exactly two:
   >
   > | File | Redis used for | Removed by |
   > |---|---|---|
   > | `lib/admin-config.ts:1` | the config store | **chunk 1** |
   > | `lib/agent-key.ts:2` | `quota()` only (`:113-144`) | **chunk 2** (§5) |
   >
   > **Chunk 3 (BYOA) touches no Redis at all** — `agent-key.ts`'s only
   > `createClient` is the quota client; `resolveKeyMode` names Redis solely in
   > comments and the `expect(redis.getCalls).toBe(0)` assertion (§4.4).
4. **`REDIS_URL`** from Vercel, and the Marketplace store itself, **last** and
   only on Graham's word — that is an infrastructure action, not a code change.

---

## 7. Build order

Each chunk ships its **caller** with its schema (invariant 3). No chunk lands a
table nothing reads.

| # | Chunk | Ships | Independent? |
|---|---|---|---|
| 0 | **Delete `/api/show`** | route deletion + a test asserting no `redis` import remains in `app/api/` | yes — pure removal, no dependency |
| 1 | **`/admin` re-auth** (§3, §3.3a, §3.3b) | **NO MIGRATION.** `/admin` RE-AUTHED across all four routes from `ADMIN_SECRET` to the super-admin email check; `ADMIN_SECRET` retired; **Redis stripped from `lib/admin-config.ts`**, leaving env-only resolution; **`ConfigRead` narrowed to `source: 'env'` (§3.2); the paired doc's `'store'` spec amended in that same BUILD PR — not in #152** | yes — but **sequenced AFTER Drive retirement** (PR #153 §6.1) |
| 2 | **Quota** (§5) | `peek_tryit` migration, `quota()` rewritten onto both functions, IP hashing, **fixed window**. **Removes the last `redis` import** (`lib/agent-key.ts:2`, §6.3) | yes — all inputs ruled |
| 3 | **BYOA storage** (§4) | `user_secrets` server routes, the two-way storage choice, masked display, **and the `/dashboard/settings` surface itself** | **independent** — see the note below |
| 4 | **Settings overlay** (§4.3) | the §14 UI: overlay, §5 states 5–7 affordance, tests 21–24 restated | depends on chunk 3 |
| 5 | **Remove `redis`** | dependency removal, `REDIS_URL` retirement | depends on **0–2** |
| 6 | **Collaborator view-only** (§3.3c) | **Code first**: 4 sites (`shows/update` guard, show-page `isEditor`, dashboard list select + `(role)` badge). **Then migration**: convert any `'editor'` row, drop `"Editor update"`, drop→recreate `is_show_collaborator` without `p_role` (recreating `"Collaborator read"` with it), then drop `role`. Plus the counterexample tests in §3.3c | **independent** — touches no Redis and no `user_secrets` |

**⛔ Two dependency corrections at v1.7.** (1) **Chunk 3 no longer depends on
chunk 1** — revised chunk 1 does not create `/dashboard/settings`; it re-auths
`/admin`, a different route for a different principal (§8 Q5). Chunk 3 creates
that surface itself and may ship in any order. (2) **Chunk 5 depends on 0–2, not
0–3** — per §6.3, chunk 3 touches no Redis.

**§13 of `design-ai-key-availability.md` is independent of every chunk here** and
may ship before, during or after — it resolves through `readAdminConfig`'s
**STATUS contract**, which §3.2 preserves. *(The three statuses survive. What
changes is the `source` union, and per §3.2 that amendment lands with chunk 1 in
both documents at once.)*

---

## 8. Questions — ALL FIVE RULED by Graham, 2026-08-24

- **Q1 — Admin RBAC (§3.3a). RULED 2026-08-24, then SUPERSEDED the same day.**
  First ruled "add `profiles.is_platform_admin`"; then **shelved entirely** once
  Graham clarified the three-tier model — **super-admin is one person and is not
  a tenant concern at all**. No role column, no migration. See §3.3a.
- **Q2 — Quota window (§5.3). RULED: fixed is fine.** The sliding→fixed change is
  accepted deliberately, not ported silently.
- **Q3 — Old slug URLs (§6.1). RULED: not a concern.** Chunk 0 deletes
  `/api/show` without a migration or a redirect.
- **Q4 — Encryption at rest for stored secrets. RULED: research it and
  recommend.** Done — see §8.1, which is now normative, not a question.
- **Q5 — Does `/admin` survive as its own surface? RULED TWICE. Final: YES, IT
  SURVIVES.**

  **First ruling (earlier on 2026-08-24): no** — platform admin becomes a gated
  section of `/dashboard/settings`, reasoning *"i think part of dashboard/settings
  not its own surface, since it's tenant not 'master' level surface in the
  commercial multi-tenant world."*

  **Reversed the same day, once the three-tier model was stated (§3.3a).** That
  first ruling and the model contradict each other: it placed platform config on
  the tenant settings page *because* it read as tenant-level, but super-admin is
  explicitly **not** a tenant concern. Graham's reversal:

  > *"yeah, i think we don't want super admin on that sub-page. keep it where it
  > is."*

  **⇒ `/admin` is NOT deleted.** It stays as its own surface and is **re-authed**
  from the shared `ADMIN_SECRET` to the super-admin session-email check (§3.3a).
  `ADMIN_SECRET` still retires; the route does not.

  **★ This resolves the two-blast-radii hazard rather than mitigating it.** The
  earlier design put a **per-user** control (BYOA key, affects one person) and a
  **global** control (`claude_tryit_key`, affects every tenant) on one page, and
  leaned on visual distinction to stop someone editing a global value believing
  it was theirs. Separate surfaces means that confusion is not possible:

  | Surface | Principal | Scope of every control on it |
  |---|---|---|
  | `/admin` | super-admin only | **global** — the platform |
  | `/dashboard/settings` | the signed-in owner | **their own account** |

  **`/dashboard/settings` is therefore owner-scoped ONLY**, and its v1 content is
  the owner's own agent API key (§4) — confirmed by Graham: *"the key edit for
  owner probably needs to be on settings page, yes?"* Yes. That is where it goes,
  and nothing global joins it.

### 8.1 ★ Encryption at rest — researched 2026-08-24, VERIFIED against vendor docs

**Ruling: use Supabase Vault for the BYOA key (chunk 3). Do NOT use pgsodium or
Transparent Column Encryption.**

**⛔ REVISED at v1.7.** This read *"for BOTH `admin_config.value` and the BYOA
key"* — v1.6's index flagged it half-obsolete and never marked it. **The
`admin_config` half is deleted: there is no table and no column to encrypt.**
The BYOA half stands unchanged and is the whole of this ruling now.

**What was verified, with the vendor's own words:**

| Finding | Source |
|---|---|
| **pgsodium is pending deprecation.** *"Supabase does not recommend the usage of pgsodium as it will be deprecated. Use Supabase Vault instead."* | [pgsodium docs](https://supabase.com/docs/guides/database/extensions/pgsodium) |
| **Transparent Column Encryption is explicitly not recommended:** *"we do not recommend using either on the Supabase platform due to their high level of operational complexity and misconfiguration risk."* Also removed from the table editor; SQL-only. | [pgsodium docs](https://supabase.com/docs/guides/database/extensions/pgsodium), [Discussion #18849](https://github.com/orgs/supabase/discussions/18849) |
| **Vault survives the deprecation.** Its internal implementation shifts off pgsodium; **the interface and API stay unchanged.** | [Discussion #27109](https://github.com/orgs/supabase/discussions/27109) |
| **Vault's encryption key lives OUTSIDE the database**, in Supabase's backend — so a database dump does not yield the key. Secrets are AEAD-encrypted via libsodium and decrypted on the fly through the `vault.decrypted_secrets` view, staying encrypted in **backups and replication streams**. | [Vault docs](https://supabase.com/docs/guides/database/vault) |

**Storage shape:** `user_secrets` stores a `vault_secret_id uuid` rather than the
key itself. Nothing in that table is a credential. *(v1.7: "likewise
`admin_config`" deleted — no such table.)*

**★ The honest limit, stated because the whole point of Q4 was not to overclaim:
Vault does NOT protect against a compromised `service_role` key.** Our server
must decrypt the key in order to call Anthropic, so whatever credential performs
that read can, if leaked, yield plaintext. The docs do not claim otherwise; they
say only *"protect access to this view with the appropriate SQL privilege
settings at all times."*

**What it therefore does and does not buy:**

- **Protects against:** database dumps and backups, replication streams, a
  leaked database password without the root key, and read access to the raw
  table — all real, all common.
- **Does not protect against:** a leaked `service_role` key used through the
  application's own read path. That threat is addressed by §4.6's controls
  (never logged, never in a JWT, write-only) and by §4.5 — **a user who chooses
  "remember on this device" has no server-side exposure at all**, which remains
  the single strongest privacy control available here.

**⚠ One uncertainty that must be spiked before chunk 3 commits to this:** Vault's
documented design centre is a *small number of app-level secrets*. The docs state
no limit, but "no documented limit" is not "verified to scale". A spike must
confirm per-account secrets behave under realistic row counts before chunk 3
builds on it.

**⚠⚠ v1.7 — the spike carries MORE weight than it looks.** The deleted sentence
(*"`admin_config` has no such doubt — three named secrets is exactly Vault's
design centre"*) was the reassuring half: one Vault use inside the documented
envelope, one outside it. **With `admin_config` gone, the only remaining use of
Vault in this design is the per-account case.** If the spike fails, **nothing
here uses Vault at all** and chunk 3 needs a different encryption-at-rest answer
— with pgsodium and TCE already ruled out above, that is a genuinely open
question, not a fallback.

**★★ RESCOPED at v1.9 — the bar is much lower than v1.7 assumed.** v1.7 framed
this as *"one row per user, **unbounded***". §4.1 now establishes that BYOA is
**owner-only in practice** — collaborators are view-only (§3.3c) and have no AI
surface to spend a key on. So the row count tracks **owners, not users**:

| | v1.7 framing | v1.9, corrected |
|---|---|---|
| Population | Every signed-in user, unbounded | Owners — those who create shows |
| Order of magnitude | Speculative, no ceiling | **6 shows exist today** (§2, measured); hundreds is a generous ceiling |
| Question the spike answers | *"Is Vault safe outside its documented envelope?"* | *"Is Vault fine at hundreds of secrets?"* |

**Hundreds of secrets is arguably INSIDE documented usage**, so the likely
outcome flips from "this may not work" to "confirm it works and move on." **Run
the spike anyway** — the cost is low, the claim is currently unmeasured, and
§0's invariant 3 is that nothing is declared settled without something exercising
it. But scope it to owner-count cardinality; a spike sized for unbounded per-user
rows would be measuring a population this design does not create.

**Spike definition, normative:** provision N `vault.secrets` rows for N synthetic
accounts at N ∈ {100, 1000}; measure single-secret read latency through
`vault.decrypted_secrets` at each N; record any ceiling, quota or error the
platform returns. **Pass** = read latency stays flat enough to sit in a request
path and no limit is hit at 1000. **Fail** = any hard limit below 1000, or read
latency that scales with row count. Report the measured numbers, not a verdict.

---

## 9. Tests

**Chunk 0:** route deleted; a source-level assertion that no file under
`app/api/` imports `redis` *(mirrors test 20's shape in the key-availability
doc)*.

**Chunk 1** *(rewritten v1.6 after Codex R4 caught the obsolete contract; the
struck-through original was deleted at v1.7 — `git show
d5fe1a8:docs/design-single-backend.md` §9)*:

1. **`readAdminConfig` resolves from `process.env` alone.** `ok`/`env` when the
   variable is set and non-empty; `none` when it is not. **`'store'` and `error`
   are both unreachable** — there is no store, and an env var cannot be
   "unreachable." Per §3.2, `ConfigRead` collapses from four states to two and
   the type is **narrowed to `source: 'env'`**; that is a behavioural change, not
   a simplification of wording.
   **Also in this chunk:** the paired doc's `source: 'store' | 'env'` spec
   (`design-ai-key-availability.md:359`, `:907`) is amended **in the chunk-1
   build PR, alongside this code change — NOT in #152**, which touches one file.
   A test pins that the two documents describe one union.
2. **`__DISABLED__` is gone with the Redis client**, so the trap it caused cannot
   recur. The regression test for it goes too — **there is no longer a write path
   that could set it.** Deleting a test whose subject no longer exists is correct;
   leaving it would assert against a code path that cannot be reached.
3. **The four-route auth cases below** — unchanged by any of this. They are the
   substance of chunk 1's test surface now.

**⇒ Chunk 1's test surface is the auth boundary, not config resolution.** One
resolution case (env set / env unset) plus the eight auth cases below.

**★ Added at v1.4 (Codex R2 on #152, residual implementation risk).** A test
covering only `settings` would leave the other three re-authed routes unproven
while reading as complete — §3.3b re-auths **four** routes. **Every one of the
four gets its own rejection case:**

*(v1.7: this paragraph appeared twice — a v1.4/v1.6 artifact where the amended
copy was inserted above the original instead of replacing it. Duplicate deleted.)*

| Route | Must reject |
|---|---|
| `admin/settings` GET **and** PUT | both verbs, separately — v1.2's `authenticate()` is called twice (`route.ts:11`, `:33`) and one guard could be dropped without the other failing |
| `admin/owners` | — |
| `admin/migrate-setlists` | — |
| `admin/backfill-chart-overlays` | — |

Each case asserts rejection for: **no session**, **a session whose email does not
match `PLATFORM_ADMIN_EMAIL`**, and **an unset or empty `PLATFORM_ADMIN_EMAIL`**
(the fail-closed rule of §3.3b — an unset variable must not authorise everyone).
A case that only tests "no session" would pass against an implementation that
compares nothing.

**And the reason these are not optional:** `authenticate()` returns `false` the
moment `ADMIN_SECRET` is unset (`lib/admin-rate-limit.ts:45-46`). A route whose
re-auth is forgotten therefore **fails closed and looks fine** — no error, no
alarm, just a permanently 401ing admin tool. Only a positive test that the
correct identity is ACCEPTED distinguishes "re-authed" from "silently dead," so
each route also needs the matching accept case.

**Chunk 2:** `increment_tryit` is atomic under concurrent calls; `peek_tryit`
does **not** increment; both agree on window expiry at the boundary; a raw IP
never reaches the database.

**Chunk 3:** no route returns a stored key under any input; a key saved to the
account is readable by the server and not by an authenticated browser client;
"remember on this device" writes **nothing** server-side; account deletion
cascades.

**Chunk 4:** tests 21–24 from `a624650`, restated against whichever storage the
user chose.

**Chunk 5 — the completion gate** *(added v1.7; §9 previously stopped at chunk 4
and the check lived only in §6.3, so the one test that proves the whole job is
done was absent from the test spec)*: extend `importSpecifiers()`
(`tests/redis-retirement.test.ts:82`) from `app/api/` to **`app/`, `lib/`,
`components/`** and assert **no production module imports `redis` or `redis/*`**.
Keep the existing positive control (`:342`) so an empty offender list cannot come
from an empty file list. **Parsed, not grepped, and scoped to production source**
— `tests/` legitimately contains `redis` import strings as scanner fixtures
(`:240`), and `docs/` contains the phrase in prose (§6.3).

**Delta measured on both refs immediately before each PR body is written, never
quoted from notes** (`feedback_report_test_delta`).

---

## 10. Documents this supersedes

**⛔ CORRECTED at v1.7 — this said "All three are corrected in this PR." Two
were; one never was.** Measured 2026-08-25:

| Doc | Supersession notice | Corrected where |
|---|---|---|
| `design-kv-admin-settings.md` | ✅ present | **#150** (`dc56c8e`) |
| `design-supabase-backend.md` | ✅ present | **#150** (`dc56c8e`) |
| **`design-owner-onboarding.md`** | ❌ **ABSENT** | **nowhere — still uncorrected** |

`design-owner-onboarding.md` was added to this list at **v1.3, inside #152 — a
one-file PR that could not have corrected it.** Found, listed, never fixed. **It
still specifies `/api/admin/owners` as `ADMIN_SECRET`-gated** (`:55`, `:61`,
`:82`).

**⇒ Its notice lands with the chunk-1 build PR**, where `/api/admin/owners` is
actually re-authed — the same PR as the paired-doc amendment (§3.2, §9).

(Supersession notices only; full rewrites are separate work.)

1. **`design-kv-admin-settings.md`** — its *"Why Redis over Postgres"* rationale
   and its **instance-per-customer hosting model** ("Model C") are both dead.
   Graham ruled multi-tenant SaaS 2026-08-24, and the code already agreed:
   `app/api/profiles/route.ts:12` is `POST /api/profiles — claim owner slug
   (onboarding)` — self-serve owners on one deployment.
   **Also dead: its auth model.** `:130` makes `ADMIN_SECRET` *"the root of
   trust… never stored in KV — it stays in `process.env`."* §3.3b retires it
   outright; the root of trust becomes the Supabase session plus
   `PLATFORM_ADMIN_EMAIL`. `:213`/`:219` still specify `Authorization: Bearer
   {ADMIN_SECRET}` as the route contract.
2. **`design-owner-onboarding.md`** — `:55`, `:61` and `:82` specify
   `/api/admin/owners` as `ADMIN_SECRET`-gated, with the KV-independent
   validation whose rationale §3.3b retires. Its *"Registered Owners"* section
   and the `/admin` surface it hangs on are **unaffected** — only the gate
   changes.
3. **`design-supabase-backend.md`** — its `user_secrets` policy block specifies
   two write policies that **were** created (`001_initial_schema.sql:149`,
   `:153`) and are now **dropped** by §4.2, because Vault requires server-side
   writes and no DELETE policy exists for the Remove action. *(v1 of this
   document claimed they were never created. Retracted — see §4.2.)* Its
   replacement table at `:45` is correct but was never executed for
   `/api/show`; chunk 0 executes it.

**Leaving these uncorrected is precisely the failure this document exists to
end** (§2.1). A superseded document that still reads as current is how
`/api/show` survived fifteen months after its replacement shipped.
