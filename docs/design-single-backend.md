# Design — one backend: retire Redis, consolidate on Supabase

Status: **PRE-CODEX. Do not build to this text until it has been reviewed and
Graham has given the go.**
Version: **v1**
Scope: `lib/admin-config.ts`, `lib/agent-key.ts`, `app/api/admin/settings`,
`app/api/show` (deletion), `user_secrets`, `tryit_quota`, a new `admin_config`
table, and a new `/dashboard/settings` surface.

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

| Key | Supabase equivalent | Status |
|---|---|---|
| `show:{slug}` | `shows` + `/api/shows/[owner]/[show]` | ✅ replaced — **the Redis route has ZERO callers and was never deleted** |
| `quota:{ip}` | `tryit_quota` + `increment_tryit()` (`001_initial_schema.sql:82`, `:234`) | ⚠ **built, migrated, ZERO callers.** Code still uses Redis. **Not a drop-in — see §5.2** |
| `admin:*` (3 keys) | **none** | ❗ the only genuinely Redis-only workload |
| — | `user_secrets.claude_api_key` (`:49`) | ⚠ table exists, **zero application code** |

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

**A fourth, found while writing this document (§4.2):** `user_secrets`' RLS
policies were specified and never created.

**★ And a fifth, which contains the other four.** `design-supabase-backend.md`'s
own header reads **`Replaces: Redis (slugs, admin config, try-it quota)`** — the
*entire* retirement this document specifies was designed in **May 2026** and
partially executed. Shows, charts, auth and songs shipped; the three Redis
namespaces did not. That header claim has therefore been **true on paper and
false in production for fifteen months**, and its status line still reads
*"awaiting build approval"* for work that has been live for over a year.

**⇒ This document is not proposing a new direction. It is executing a decision
already taken, and its real contribution is finishing rather than deciding.**
The design work that matters here is §3.3 (admin RBAC, genuinely new), §4
(BYOA under multi-tenant, genuinely new), and §5.2/§5.3 (the two places the
"already built" replacement turns out not to be a drop-in).

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
  value text not null,
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

### 3.2 `readAdminConfig` keeps its interface exactly

This is the load-bearing compatibility claim, and it is why **§13 of
`design-ai-key-availability.md` needs no changes**:

```ts
export type ConfigRead =
  | { status: 'ok'; value: string; source: 'db' | 'env' }
  | { status: 'none' }
  | { status: 'error'; reason: string }
```

Only the `source` discriminant changes (`'redis'` → `'db'`). The three statuses,
their meanings, and the ordering subtlety — *a store failure with a valid env
fallback is still `ok`/`env`, never `error`* — all survive verbatim. Four
callers (`agent/chat`, `charts/convert`, `charts/roadmap/parse`,
`admin/backfill-chart-overlays`) are unaffected.

**The `__DISABLED__` sentinel is DELETED.** It exists because Redis has no way to
express "explicitly off" other than a magic value, and it caused a real
production trap: a field cleared in the `/admin` UI suppressed the
`CLAUDE_TRYIT_KEY` env fallback entirely. In Postgres, "off" is **the absence of
a row**, and clearing the field is `delete from admin_config where key = $1`.
One fewer concept and one fewer trap.

### 3.3 ★ Admin RBAC — this does not exist today and must be built

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

**Recommendation: the flag.** A shared secret does not survive a second person,
and `updated_by` is meaningless without an identity. **Q1 — Graham to rule.**

**Bootstrap:** the migration seeds `is_platform_admin = true` for the row whose
`owner_slug` matches a value supplied at migration time. It must not be
self-service, and no route may ever grant it.

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

### 4.2 ★ The policies were specified and never created — keep the stricter state

`design-supabase-backend.md:130-140` specifies two write policies on
`user_secrets`. **Neither exists.** `001_initial_schema.sql:55` enables RLS and
creates **no policies at all**, with only a comment at `:148`.

In Postgres, **RLS enabled with zero policies denies everything** to roles that
do not bypass it. So today the table is `service_role`-only for **read and
write** — *stricter* than designed.

**Ruling: keep the stricter state, and record it as deliberate.** It forces BYOA
writes through a server route using the admin client, which means the key never
rides a client-side Supabase call. The designed insert/update policies are
**not** to be added. This document supersedes
`design-supabase-backend.md`'s §`user_secrets` policy block.

### 4.3 The three §14 rulings, carried forward

Restated verbatim so the re-spec cannot lose them. Full original text at
`a624650:docs/design-ai-key-availability.md`.

1. **The overlay is settled spec**, and the reason is data loss: navigating away
   from the show page destroys restored composer text, because the prompt cache
   is write-only in production (`page.tsx:47` imports only `rememberPrompt`;
   `readPrompts` has zero callers). A plain link would cause the exact data loss
   §5.2a exists to prevent.
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
   masked (`sk-ant-…4f2a`) with **Replace** and **Remove** only. Enforced at the
   database by §4.2's zero-policy state, not by route discipline alone.
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

---

## 5. Quota → `tryit_quota`

### 5.1 What exists

`increment_tryit(p_ip_hash text, p_limit integer, p_window_days integer)` —
`001_initial_schema.sql:234`. Atomic via `insert … on conflict do update`,
`security definer`, and `revoke execute … from public, anon, authenticated` so
only the service role may call it. **Zero callers.**

**Privacy improvement, free:** the parameter is `p_ip_hash`. Redis stores the
**raw IP** in `quota:{ip}`. Nothing hashes IPs today. Migrating removes raw IPs
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
what users get and it must not be smuggled in as a port.** **Q2 — Graham to
rule.**

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
   90-day TTL, and the store is currently unreachable. **§8 Q3 — confirm no
   published-slug URLs of the old form are still circulating before this lands.**
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
| 1 | **`admin_config` table + RBAC** (§3) | migration, `readAdminConfig` swap, `/admin` route auth change, `admin_config` CRUD | depends on Q1 |
| 2 | **Quota** (§5) | `peek_tryit` migration, `quota()` rewritten onto both functions, IP hashing | depends on Q2 |
| 3 | **BYOA storage** (§4) | `user_secrets` server routes, the two-way storage choice, masked display | depends on chunk 1 for `/dashboard/settings` scaffolding only |
| 4 | **Settings overlay** (§4.3) | the §14 UI: overlay, §5 states 5–7 affordance, tests 21–24 restated | depends on chunk 3 |
| 5 | **Remove `redis`** | dependency removal, `REDIS_URL` retirement | depends on 0–3 |

**§13 of `design-ai-key-availability.md` is independent of every chunk here** and
may ship before, during or after — it resolves through `readAdminConfig`'s
interface, which §3.2 preserves exactly.

---

## 8. Open questions

- **Q1 — Admin RBAC (§3.3).** Shared secret retained, or
  `profiles.is_platform_admin`? Recommend the flag. **Graham.**
- **Q2 — Quota window (§5.3).** Accept the change from sliding to fixed?
  Recommend yes. **Graham.**
- **Q3 — Old slug URLs (§6.1).** Are any `show:{slug}` links still circulating
  that would break on deletion? Nothing reads the route today, so they are
  **already** broken — the question is whether anyone will report it. **Graham.**
- **Q4 — Column-level encryption.** Should `user_secrets.claude_api_key` and
  `admin_config.value` be encrypted at the application layer rather than relying
  on Supabase's at-rest encryption? Disk encryption does not protect against a
  leaked `service_role` key. **This question is deliberately unanswered: it turns
  on what pgsodium / Supabase Vault currently offer, and this document will not
  assert a vendor mechanism it has not verified.** Requires checking before it is
  answered — see `feedback_verify_vendor_mechanisms`.
- **Q5 — Does `/admin` remain a separate surface at all**, or does platform
  admin become a section of `/dashboard/settings` gated on the flag? Out of
  scope for v1; raised so it is not assumed either way.

---

## 9. Tests

**Chunk 0:** route deleted; a source-level assertion that no file under
`app/api/` imports `redis` *(mirrors test 20's shape in the key-availability
doc)*.

**Chunk 1:** `readAdminConfig` returns `ok`/`db` from a row, `ok`/`env` from the
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

Both are corrected **in this PR** (supersession notices only; full rewrites are
separate work):

1. **`design-kv-admin-settings.md`** — its *"Why Redis over Postgres"* rationale
   and its **instance-per-customer hosting model** ("Model C") are both dead.
   Graham ruled multi-tenant SaaS 2026-08-24, and the code already agreed:
   `app/api/profiles/route.ts:12` is `POST /api/profiles — claim owner slug
   (onboarding)` — self-serve owners on one deployment.
2. **`design-supabase-backend.md`** — its `user_secrets` policy block specifies
   two write policies that were never created and are now explicitly **not to be
   added** (§4.2). Its replacement table at `:45` is correct but was never
   executed for `/api/show`; chunk 0 executes it.

**Leaving these uncorrected is precisely the failure this document exists to
end** (§2.1). A superseded document that still reads as current is how
`/api/show` survived fifteen months after its replacement shipped.
