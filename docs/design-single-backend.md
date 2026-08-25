# Design — one backend: retire Redis, consolidate on Supabase

Status: **APPROVED AND MERGED to `main` at `dc56c8e` (PR #150, 2026-08-24) after
Codex R1–R8. IN BUILD — chunk 0 shipped; build against this text.**
*(Superseded status: "PRE-CODEX, do not build". Corrected the moment building
started — a status line that still forbids the work in progress is the same
class of stale claim as §2.1's three unexecuted supersessions, and this document
does not get to exempt itself from its own subject.)*
Version: **v1.3** (v1 = pre-Codex, v1.1 = Codex R1–R8 on #150, v1.2 = RBAC shelved +
Q5 reversed, **v1.3 = Codex R1 on #152: Q5 reversal propagated to the paired doc,
`ADMIN_SECRET` retirement specified for all four consumers (§3.3b)**)
Scope:

- `lib/admin-config.ts`, `lib/agent-key.ts` — Redis → Supabase + Vault
- new **`admin_config`** table; **no `profiles` change** (RBAC shelved, §3.3a)
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
their **reads** already falls back to an env var in `readAdminConfig`. Only the
**write** path genuinely requires a store.

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
super-admin is a single principal and not a tenant concern. The remaining work
there is one new table, not a role system.)*

**This is why invariant 3 exists.** Every chunk in §7 ships its caller in the
same PR as its schema. No chunk may land a table that nothing reads.

---

## 3. Admin config → a Supabase table

**Ruled by Graham 2026-08-24: a table, not env vars.**

Env vars were the cheaper option and would have deleted the most code, since
under multi-tenant SaaS he is the only operator. He ruled for the table; the
operative reason is that rotating a key should not require a redeploy, which
matters more as soon as there are paying customers.

### 3.1 Schema

```sql
create table admin_config (
  key text primary key,
  vault_secret_id uuid not null,   -- §8.1: the VALUE lives in Supabase Vault.
                                   -- This table holds no credential.
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id)
);

alter table admin_config enable row level security;
-- No policies. Service-role access only, matching tryit_quota's pattern
-- (001_initial_schema.sql:89). Admin config is operator data; no browser
-- client may read or write it under any role.
```

`updated_by` exists because a shared secret has no attribution and §3.3 removes
it. It is nullable so the bootstrap migration can seed rows with no actor.

### 3.2 `readAdminConfig` keeps its STATUS contract; the source discriminant is renamed

**⚠ Corrected at v1.1 (Codex High). v1 claimed the interface was preserved
"exactly" and that §13 therefore needed no changes, while simultaneously
changing `source` from `'redis'` to `'db'` — and the paired document still
specifies `source: 'redis' | 'env'` (`design-ai-key-availability.md:356`) and an
admin state of `'redis' | 'env' | 'none' | 'error'` (`:905`). Two
landing-together documents cannot give contradictory targets for one API.**

```ts
export type ConfigRead =
  | { status: 'ok'; value: string; source: 'store' | 'env' }
  | { status: 'none' }
  | { status: 'error'; reason: string }
```

**The discriminant becomes `'store'`, not `'db'` and not `'redis'` — it names a
ROLE, not a vendor.** That is the same correction test 16 already carries in the
paired document: pin the property, not the product. A field called `'redis'`
would have to change again the next time the store does.

**Cost of the rename: four sites, no branching.** **No production code branches
on `source`** — in `app/` and `lib/` it appears only in its own type definition
and the two `return` statements that populate it (`lib/admin-config.ts:33`,
`:59`, `:74`).

**It IS asserted in tests**, and the rename must update them:
`tests/agent-key.test.ts:78` expects `source: 'redis'` (`:88` and `:119` expect
`'env'` and are unaffected). *(Codex R6 Medium: v1.1 said "produced and never
consumed", scoping a search to `app lib` and stating the result as a claim about
the whole codebase — the same unsupported-negative shape as the R5 High. The
claim is true of production callers and was never true of the suite.)*

**What genuinely survives, and is the real compatibility claim:** the three
statuses, their meanings, and the ordering subtlety — *a store failure with a
valid env fallback is still `ok`/`env`, never `error`*. Four callers
(`agent/chat`, `charts/convert`, `charts/roadmap/parse`,
`admin/backfill-chart-overlays`) branch only on `status` and are unaffected.

**⇒ §13 requires ONE change, not zero: the discriminant rename.** Stating it as
zero was the overclaim. The paired document is updated in the same commit so the
two cannot diverge, and §6's admin-state display there is corrected for the
rename.

**⚠ Corrected at v1.3 (Codex R1 on PR #152, High).** The sentence above
previously also said that display was corrected for *"the `/admin` deletion
ruled in §8 Q5."* **Q5 was reversed the same day it was ruled** — `/admin`
survives (§8 Q5, §3.3a). The admin-state display is **not relocated**; it stays
on the surface that already renders it, and only the discriminant it reads
changes. *(This is the exact failure mode §2.1 names: an amendment propagated to
the sections that argue the ruling, and missed the sentence that merely cites
it.)*

**The `__DISABLED__` sentinel is DELETED.** It exists because Redis has no way to
express "explicitly off" other than a magic value, and it caused a real
production trap: a field cleared in the `/admin` UI suppressed the
`CLAUDE_TRYIT_KEY` env fallback entirely. In Postgres, "off" is **the absence of
a row**, and clearing the field is `delete from admin_config where key = $1`.
One fewer concept and one fewer trap.

### 3.3 Admin RBAC — the original analysis, SUPERSEDED by §3.3a

**Raised by Graham 2026-08-24.** `/admin` authenticates with a **shared bearer
secret** — `ADMIN_SECRET`, `lib/admin-rate-limit.ts:44-49` — entirely outside
Supabase auth. **There is no admin or role column anywhere in the schema:**
`profiles` is `id, owner_slug, display_name, created_at`
(`005_owner_namespacing.sql:5-10`), and the only `role` columns are
`show_collaborators.role check in ('editor','viewer')` and chart instrument
roles.

Moving admin config into Supabase forces a choice that did not previously exist:

| Option | Cost | Fit |
|---|---|---|
| Keep the shared secret; table reached via `service_role` | ~zero | A shared password. No attribution, no per-person revocation. Adequate for one operator, poor for a commercial product with a team |
| **`profiles.is_platform_admin`** + policy | migration + bootstrap seeding | Multi-tenant-correct, auditable, revocable per person |

~~**Recommendation: the flag.**~~ ~~**✅ RULED 2026-08-24: add the flag.**~~

### 3.3a ★★ SUPERSEDED 2026-08-24 — RBAC is SHELVED. Three tiers, one admin.

**Graham clarified the model, and it dissolves the question rather than
answering it:**

| Tier | Who | Scope | Mechanism |
|---|---|---|---|
| **Platform super-admin** | Graham, and only Graham | The platform itself: try-it key, Google OAuth secrets | **Env var identity check.** No column, no role, no migration |
| **Owner** (tenant) | Anyone who claims a slug | Their own shows, library, and **their own BYOA key** | Existing `profiles` + `auth.uid() = user_id`. Unchanged |
| **Collaborator** | A bandmate invited by an owner | One show, `editor` or `viewer` | Existing `show_collaborators.role`. Unchanged |

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

## 4. BYOA → `user_secrets` — the §14 re-spec

### 4.1 Why it moved off `localStorage`

The removed §14 specified `localStorage`, explicitly *"no settings framework, no
schema, no persistence layer"*. That is a **per-browser** key. Graham ruled
2026-08-24 that ShowRunr is **multi-tenant SaaS**, where a key must follow the
**account** — new device, cleared cookies, second band member, and the key is
gone. For a commercial product that is a support burden, not a v1 shortcut.

**No RBAC is required for this and none should be added.** `user_secrets.user_id`
is the primary key referencing `auth.users`; the entire authorization rule is
`auth.uid() = user_id`. Collaborator roles are **show-scoped**, and a BYOA key is
not attached to a show — so owner-vs-collaborator does not apply. Every user,
owner or collaborator, has exactly one key that is theirs.

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
3. **`redis` from `package.json`** (`"redis": "^5.12.1"`) — the last import goes
   with chunk 3. **This is the check that proves the whole job is done:**
   `grep -rn "from 'redis'"` returning nothing.
4. **`REDIS_URL`** from Vercel, and the Marketplace store itself, **last** and
   only on Graham's word — that is an infrastructure action, not a code change.

---

## 7. Build order

Each chunk ships its **caller** with its schema (invariant 3). No chunk lands a
table nothing reads.

| # | Chunk | Ships | Independent? |
|---|---|---|---|
| 0 | **Delete `/api/show`** | route deletion + a test asserting no `redis` import remains in `app/api/` | yes — pure removal, no dependency |
| 1 | **`admin_config` + Vault** (§3, §8.1) | ONE migration (`admin_config` only — **no `profiles` change**, §3.3a), `readAdminConfig` swap onto Vault, **`/admin` RE-AUTHED** from `ADMIN_SECRET` to the super-admin email check, `ADMIN_SECRET` retired | yes — all inputs ruled |
| 2 | **Quota** (§5) | `peek_tryit` migration, `quota()` rewritten onto both functions, IP hashing, **fixed window** | yes — all inputs ruled |
| 3 | **BYOA storage** (§4) | `user_secrets` server routes, the two-way storage choice, masked display | depends on chunk 1 for `/dashboard/settings` scaffolding only |
| 4 | **Settings overlay** (§4.3) | the §14 UI: overlay, §5 states 5–7 affordance, tests 21–24 restated | depends on chunk 3 |
| 5 | **Remove `redis`** | dependency removal, `REDIS_URL` retirement | depends on 0–3 |

**§13 of `design-ai-key-availability.md` is independent of every chunk here** and
may ship before, during or after — it resolves through `readAdminConfig`'s
**STATUS contract**, which §3.2 preserves.

*(v1.3: this read "which §3.2 preserves exactly" — contradicting §3.2's own v1.1
correction two hundred lines above it, where "preserved exactly" was retracted as
the overclaim. §3.2 makes exactly one interface change, the `source` discriminant
rename, and it is carried in both documents and in `tests/agent-key.test.ts:78`.)*

---

## 8. Questions — ALL FIVE RULED by Graham, 2026-08-24

- **Q1 — Admin RBAC (§3.3). RULED 2026-08-24, then SUPERSEDED the same day.**
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

**Ruling: use Supabase Vault for BOTH `admin_config.value` and the BYOA key.
Do NOT use pgsodium or Transparent Column Encryption.**

**What was verified, with the vendor's own words:**

| Finding | Source |
|---|---|
| **pgsodium is pending deprecation.** *"Supabase does not recommend the usage of pgsodium as it will be deprecated. Use Supabase Vault instead."* | [pgsodium docs](https://supabase.com/docs/guides/database/extensions/pgsodium) |
| **Transparent Column Encryption is explicitly not recommended:** *"we do not recommend using either on the Supabase platform due to their high level of operational complexity and misconfiguration risk."* Also removed from the table editor; SQL-only. | [pgsodium docs](https://supabase.com/docs/guides/database/extensions/pgsodium), [Discussion #18849](https://github.com/orgs/supabase/discussions/18849) |
| **Vault survives the deprecation.** Its internal implementation shifts off pgsodium; **the interface and API stay unchanged.** | [Discussion #27109](https://github.com/orgs/supabase/discussions/27109) |
| **Vault's encryption key lives OUTSIDE the database**, in Supabase's backend — so a database dump does not yield the key. Secrets are AEAD-encrypted via libsodium and decrypted on the fly through the `vault.decrypted_secrets` view, staying encrypted in **backups and replication streams**. | [Vault docs](https://supabase.com/docs/guides/database/vault) |

**Storage shape:** `user_secrets` stores a `vault_secret_id uuid` rather than the
key itself; likewise `admin_config`. Nothing in either table is a credential.

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
documented design centre is a *small number of app-level secrets*. Using it for
**one row per user, unbounded**, is beyond the documented examples. The docs
state no limit, but "no documented limit" is not "verified to scale". A spike
must confirm per-user secrets behave under realistic row counts before chunk 3
builds on it. **`admin_config` has no such doubt — three named secrets is exactly
Vault's design centre.**

---

## 9. Tests

**Chunk 0:** route deleted; a source-level assertion that no file under
`app/api/` imports `redis` *(mirrors test 20's shape in the key-availability
doc)*.

**Chunk 1:** `readAdminConfig` returns `ok`/**`store`** from a row, `ok`/`env` from the
env fallback when the row is absent, `none` when neither, `error` only when the
database is unreachable **and** no env fallback exists. **A deleted row must
allow the env fallback** — the regression test for the retired `__DISABLED__`
trap. Non-admin identity is refused by `admin_config` routes.

**Chunk 2:** `increment_tryit` is atomic under concurrent calls; `peek_tryit`
does **not** increment; both agree on window expiry at the boundary; a raw IP
never reaches the database.

**Chunk 3:** no route returns a stored key under any input; a key saved to the
account is readable by the server and not by an authenticated browser client;
"remember on this device" writes **nothing** server-side; account deletion
cascades.

**Chunk 4:** tests 21–24 from `a624650`, restated against whichever storage the
user chose.

**Delta measured on both refs immediately before each PR body is written, never
quoted from notes** (`feedback_report_test_delta`).

---

## 10. Documents this supersedes

All three are corrected **in this PR** (supersession notices only; full rewrites
are separate work). *(v1.3: "Both" — the list was two. `design-owner-onboarding.md`
was found by the §3.3b sweep, not by review of this section.)*

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
