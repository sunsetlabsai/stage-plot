# Design — one backend: retire Redis, consolidate on Supabase

**Status.** Build state is tracked in `docs/INDEX.md`, not here — every chunk this
document specifies, including chunk 4 (the BYOA settings overlay, §3), has shipped.
Everything else here is the durable design record — the
invariants, the security requirements, and the rulings that constrain future work
— in the present tense. History lives in git; this document does not carry its own
changelog.

---

## 0. Invariants

1. **One backend.** Supabase is the only persistence dependency. `redis` is not in
   `package.json`.
2. **A key is never readable back.** No route, policy or UI path returns a stored
   BYOA key to any client. Masked display only.
3. **Nothing is "replaced" until its replacement has a caller.** Each chunk shipped
   its caller in the same PR as its schema; no migration lands a table nothing
   reads. This invariant exists because three earlier supersessions (`/api/show`,
   `tryit_quota`, `user_secrets`) were designed, migrated, and left unwired for
   months — and a superseded thing that still reads as current is how `/api/show`
   survived fifteen months after its replacement shipped.
4. **Behavioural changes are stated, not absorbed.** Where Supabase behaves
   differently from Redis, the difference is named and ruled on rather than
   discovered later (the quota window, §7).

---

## 1. The decision

**One backend, Supabase. Redis retired.** (Graham, 2026-08-24.)

The deciding argument: AI is a *construction*-mode capability, not a *show*-mode
one. A second vendor's only real value was partial degradation — keeping AI alive
while Supabase is down — but nobody builds a stage plot while the app cannot serve
shows, so the surviving mode is unusable exactly when it would trigger.

> *"AI is purely a 'construction' mode NOT the 'show' mode. So, having AI without
> show (i.e., when supabase is 'down') buys us nothing of consequence."* — Graham

Supporting context: the premise Redis was chosen under ("ShowRunr currently has
zero server-side persistence", in the since-deleted `design-kv-admin-settings.md`)
expired when Supabase landed 2026-05-25; and the vendor churned twice (`@vercel/kv` sunset Dec 2024 →
`redis`/Marketplace Redis Cloud, which itself became unreachable in prod by
2026-08).

---

## 2. What shipped, and what remains

Migrations in prod through `015`. **Build state is tracked in `docs/INDEX.md`, not here.**
This ledger records which PR carried each chunk; it is history, not status.

| Chunk | Shipped | PR | Key artifacts |
|---|---|---|---|
| 0 | ✅ | #151 (`c24ef4f`) | deleted the dead `app/api/show` Redis route |
| 1 | ✅ | #154 (`fe0f489`) | `/admin` and all four `ADMIN_SECRET` routes re-authed to the super-admin email check; `ADMIN_SECRET` retired in code; Redis stripped from `lib/admin-config.ts`; `ConfigRead` narrowed to `source: 'env'` |
| 2 | ✅ | #155 (`17268c1`) | quota → Supabase (`increment_tryit`/`peek_tryit`, migration `013`); IP hashing; fixed window; last production `redis` import removed |
| 3 | ✅ | #161 (`2989997`) | BYOA → `user_secrets` + Vault; server routes; `/dashboard/settings`; migration `015` |
| 5 | ✅ | #156 (`496b368`) | `redis` dropped from `package.json`; the import-scan guard widened repo-wide |
| 6 | ✅ | #158 (`0a2141f`) | collaborators view-only; `show_collaborators.role` dropped; migration `014` |
| 4 | ✅ | `b0bed1c` | the BYOA settings overlay — §3 below; `components/SettingsOverlay.tsx` |

Infrastructure teardown is complete: the `redis` package and the `showrunr-kv`
Marketplace store are gone, and the `REDIS_URL` and `ADMIN_SECRET` env vars were
removed from Vercel Production + Preview on 2026-09-04.

---

## 3. Chunk 4 — the BYOA settings overlay

### 3.1 The three carried-forward rulings

1. **The overlay is settled spec, and the reason is data loss.** Navigating away
   from the show page destroys restored composer text, because no product path
   reads the prompt cache back: `app/[owner]/[show]/page.tsx:47` imports only
   `rememberPrompt`, and `readPrompts`' sole production use is internal
   de-duplication inside `rememberPrompt` (`lib/prompt-cache.ts:78`). A plain link
   would cause exactly the data loss the overlay exists to prevent.
2. **§5 states 5, 6 and 7 keep their condition, copy and `canSend` behaviour.**
   Only the inline key input becomes an affordance that opens the overlay. Current
   mechanisms: `canSendMessage({ availability, streaming, hasPendingTools })`
   (`page.tsx:5613`) and `availability.showKeyField && !apiKey` (`:5614`), both via
   `lib/agent-availability`.
3. **BYOA extends to every AI surface**, not try-it only — one entry surface
   dissolves the stale-second-input objection.

Chunk 4 ships the settings-overlay UI (the overlay and the states 5–7 affordance)
and the chunk-4 tests spelled out in §9, run against whichever storage the user
chose (§5.1).

### 3.2 ⚠ The live inconsistency chunk 4 must close

Chunk 3 gave `resolveKeyMode` an account-key branch (`lib/agent-key.ts:345` reads
the stored key when a `userId` is passed), but the capabilities probe was
deliberately left **not account-aware** — widening the §5 states was chunk 4's
scope. The probe calls `resolveKeyMode(undefined, ip, { consume: false })`
(`app/api/agent/capabilities/route.ts:35`): no client key **and no `userId`**, so
the account branch never runs and `capabilitiesFrom` correctly returns `null` for
`byoa` (`lib/agent-key.ts:403`). That rationale still holds — the fix is not to
"correct a false premise" but to feed the probe the authenticated `userId`.

The inconsistency it causes is user-visible today: someone who saves a key at
`/dashboard/settings` has it used by `/api/agent/chat` (which resolves with the
`userId`), while the show-page affordance — driven by this probe, which passes no
`userId` — still reports no key. **Chunk 4 must either pass the authenticated
`userId` into the probe (making it account-aware) or restate why the affordance
should stay probe-driven.**

---

## 4. Reference — the current backend model

Present-tense state of the pieces the retirement touched. These are not build
steps; the build is done.

### 4.1 Admin config resolves from env — there is no table

`readAdminConfig` resolves from `process.env` alone; there is no `admin_config`
table. `ConfigRead` is `{ status: 'ok'; source: 'env' } | { status: 'none' }` —
`'store'` and `'error'` are unreachable (nothing stores anything, and an env var
has no failure mode). **All three config keys still have live consumers**
(`lib/admin-config.ts:60`): `google_client_id` and `google_client_secret` via
`/api/auth/google` and its callback — Google OAuth *login*, which the (still unbuilt)
Drive retirement would not touch — and `claude_tryit_key`
via the `CLAUDE_TRYIT_KEY` env fallback. Config changes via Vercel env + redeploy,
not a UI: these values rotate rarely and there is one operator.

### 4.2 Access model — three tiers, one admin

| Tier | Who | Scope | Mechanism |
|---|---|---|---|
| Platform super-admin | Graham only | The platform (try-it key, OAuth secrets) | `PLATFORM_ADMIN_EMAIL` identity check (`lib/admin-auth.ts`). No column, no role. |
| Owner | Anyone who claims a slug | Their own shows, library, BYOA key | `profiles` + `auth.uid() = user_id` |
| Collaborator | A bandmate invited by an owner | One show, **view only** | `show_collaborators` membership. No role (column dropped, migration `014`). |
| Anyone with the link | No account | Views any show by `owner/show` | The route, **not RLS** (§4.4) |

The admin identity check is normative: read the email from
`supabase.auth.getUser()` server-side (never a client value, never a
browser-decoded JWT, never `getSession()`); compare case-insensitively, both sides
trimmed; **fail closed when `PLATFORM_ADMIN_EMAIL` is unset**; enforce in the
route, not by hiding UI. The same check guards all four former-`ADMIN_SECRET`
routes: `admin/settings` (GET — its PUT was deleted with the Redis config write),
`admin/owners`, `admin/migrate-setlists`, `admin/backfill-chart-overlays`.

Conductor == owner for now. The "hand this song to someone to lead" delegate idea
is backlog, and if built must be **ephemeral realtime session state, never a
stored `role` column** — a stored role would recreate the `editor` mistake that
migration `014` deleted.

### 4.3 BYOA is owner-only in practice

The authorization rule is `auth.uid() = user_id` — no role check, and none should
be added ("is an owner" is derived state, not a stable predicate to authorize
against). BYOA is owner-only not by restriction but because collaborators are
view-only and have no AI surface to spend a key on. Rows in `user_secrets`
therefore track *owners*, not users — the cardinality input to the Vault decision
(§6).

### 4.4 Two facts that are non-obvious from the schema

1. **Link-viewing is a service-role bypass, not RLS.**
   `app/api/shows/[owner]/[show]/route.ts:50` resolves anonymous shows through
   `getSupabaseAdmin()`, which bypasses row-level security; there is no anon SELECT
   policy on `shows`. **If private or unlisted shows are ever wanted, RLS will not
   deliver them — that route will.** Any privacy work starts there, not at a
   migration.
2. **Collaborator membership buys discoverability, not access.** Because
   link-viewing is already public, a `show_collaborators` row grants no read the
   link did not. What it grants is placement — the invited show appears on the
   collaborator's dashboard. That is the whole reason to keep the table.

### 4.5 Method rules these audits established

Stated as standing rules because they are cheap to violate and expensive to catch:

- **A negative claim must name the search that establishes it — and that search
  must be able to produce the counterexample.** An empty grep with no positive
  control is not evidence of absence.
- **A concept sweep cannot be a keyword sweep.** "Someone other than the owner can
  write" is expressible without the word `editor`; an enumeration built from a
  single keyword is structurally incapable of completeness.
- **Any narrowing applied after enumeration is part of the search** and inherits
  every blind spot of the pattern behind it. Enumerate, then read every line.
- **A "live today" claim about a policy must be verified against the latest
  migration that touches its table, not the one that created it.** The `charts`
  editor policies died with `drop table charts` in migration `003`; a reading of
  `001`/`002` alone would target a table that no longer exists.

---

## 5. BYOA storage and security

### 5.1 Why it moved off localStorage, and the storage choice

localStorage is a per-browser key; ShowRunr is multi-tenant SaaS, so a key must
follow the account. Storing a third party's credential also makes ShowRunr a
custodian — a posture change — so **the user picks**:

| Option | Stored | Follows account | Custodial risk |
|---|---|---|---|
| Remember on this device | `localStorage` (`lib/byoa-key-storage`) | no | none |
| Save to my account | `user_secrets`, service-role only | yes | ours |

`lib/byoa-key-storage` is retained as one of two backends behind one UI. Keys are
held server-side only for users who explicitly chose it.

### 5.2 `user_secrets` RLS

**No RLS policy grants any client operation.** Migration `015` dropped the two
former write policies (`insert`/`update`, once `auth.uid() = user_id`); there has
never been a `select` or `delete` policy. A browser client — even with a valid
session — can therefore neither read, write, nor delete a row. Every read and write
goes through the server route and the `set_user_secret` RPC (`service_role`, which
bypasses RLS). The write-only-to-clients guarantee rests on two things: **no SELECT
policy** (nothing reads a key back) and **server-only writes** (no client path can
store a plaintext key into a column the design assumes holds a `vault_secret_id`).
The client write path was dropped rather than kept because a browser client cannot
create a Vault secret in the first place, and there is no DELETE policy for the
mandatory Remove action — so those writes had to move server-side regardless.

### 5.3 Security requirements — normative

1. **Write-only.** No route, policy or UI path returns a stored key. Masked display
   (`sk-ant-…4f2a`), Replace and Remove only. Enforced at the database by the
   absence of a SELECT policy on `user_secrets`.
2. **Never in a JWT or `user_metadata`** — `user_metadata` is user-editable and
   can ride in auth token claims.
3. **Never logged.** Scrub every error path that can carry a request body or header
   — a key in a Vercel log or an error trace is a likelier leak than a database
   breach, and the one that gets forgotten.
4. **The secret — not just the pointer — must die on delete.** `references
   auth.users(id) on delete cascade` deletes the `user_secrets` row but orphans the
   Vault secret. An **`after delete` trigger** on `user_secrets` deletes the Vault
   row (`015_user_secrets_vault.sql`) — on the trigger, not inside the delete RPC,
   so it holds for every path: the Remove button, the `auth.users` cascade, and
   hand-written SQL. Ask not "does the row go away" but "does the SECRET go away."
   Any future indirection away from a plain column re-opens this.
5. **Consent at the point of entry** — plain language on what is stored, who can
   read it, and how to remove it, plus a privacy-policy line.
6. **Blast radius, stated:** an Anthropic key is revocable by its owner and scoped
   to their own billing — context for proportionate controls, not licence for
   laxity.
7. **Encrypted at rest via Supabase Vault** (§6). `user_secrets` stores a
   `vault_secret_id`, never the key. Not pgsodium, not Transparent Column
   Encryption.
8. **Every mutation path takes the same per-user advisory lock, in the same
   order** — a security requirement, not a performance one: an unserialized
   Replace-vs-Remove leaves a pointer to a deleted secret, or a secret nothing
   points at. **The order is the fix.** The `auth.users` cascade cannot take an
   advisory lock (it arrives as plain SQL with no function to hook), so
   `set_user_secret` takes the `user_secrets` row `for update` **before** touching
   Vault — every path then agrees on (user_secrets, then vault). **Do not take the
   lock in a `before delete` trigger:** a row trigger fires after the row is already
   locked, making that path `row → advisory` against the setter's `advisory → row`
   and recreating the deadlock. Verified clean over 10 contended rounds.

---

## 6. Encryption at rest — Supabase Vault

**Use Supabase Vault for the BYOA key. Not pgsodium (pending deprecation), and not
Transparent Column Encryption (the vendor recommends against both).**
`user_secrets` stores a `vault_secret_id uuid`; nothing in that table is a
credential.

**What Vault buys, and its honest limit.** Vault's encryption key lives outside the
database, so a dump or backup, a replication stream, a leaked DB password without
the root key, and a raw table read all yield ciphertext only. It does **not**
protect against a compromised `service_role` key used through the application's own
read path — the server must decrypt to call Anthropic, so whatever performs that
read can, if leaked, yield plaintext. That threat is addressed by §5.3's controls
and by the "remember on this device" option, which has no server-side exposure at
all.

**Scale is verified, not assumed** (spike against prod, 2026-08-26): read latency
through `vault.decrypted_secrets` is flat at ~0.017–0.018 ms median from N=10 to
N=1000, with `EXPLAIN ANALYZE` showing `Index Scan … Actual Rows: 1` at every N.
It is flat *by construction*: the decrypt is a per-row expression in the view's
target list, so the `id` predicate is applied at the index before any decrypt runs
— exactly one decrypt per read regardless of table size.

**What the spike does NOT establish** (do not cite it for more): it was
server-side only, excluding network; "no limit found below 1000" is not "no limit
exists"; and reads were serial on one connection, so **concurrency is untested** —
§5.3's advisory-lock order is the design's answer to that, proven separately with
parallel `psql`, not by this spike.

---

## 7. Quota, and the one behavioural change

Quota is Supabase-backed: `increment_tryit(p_ip_hash, p_limit, p_window_days)` and
its peek sibling `peek_tryit` (migration `013`), both `security definer` and
service-role-only. `resolveKeyMode` calls `increment_tryit` when consuming a
message and `peek_tryit` when only checking, so a tab-open does not cost a free
message. IPs are hashed before they reach the database (the parameter is
`p_ip_hash`; Redis stored the raw IP). `fallbackQuota` (in-memory `Map`,
`lib/agent-key.ts`) remains as the per-process degradation path when the database
is unreachable — a safety valve, not a global accounting system.

**Behavioural change, ruled and not smuggled in (Graham, 2026-08-24): the window
is fixed, not sliding.** Redis reset the TTL on every increment (30 days from the
*last* message); Postgres resets `window_start` only once the window has elapsed
(30 days from the *first*). Fixed is what "50 messages per 30 days" actually means;
the sliding behaviour was an artifact of TTL being the only expiry Redis offers.

---

## 8. Documents this supersedes

Supersession notices are present in all four; full rewrites are separate work.

- **`design-kv-admin-settings.md`** — DELETED 2026-09-04, wholly dead. Its "Why Redis
  over Postgres" rationale and its instance-per-customer "Model C" hosting died with
  the multi-tenant ruling; its `ADMIN_SECRET` root-of-trust is replaced by the Supabase
  session plus `PLATFORM_ADMIN_EMAIL`.
- **`design-supabase-backend.md`** — its `user_secrets` write-policy block is
  superseded (Vault requires server-side writes and there is no DELETE policy); its
  replacement table is correct and was executed for `/api/show` by chunk 0. Notice
  landed #150.
- **`design-owner-onboarding.md`** — its `ADMIN_SECRET`-gated `/api/admin/owners`,
  and the KV-independent-validation rationale that retires with Redis, are
  superseded. Notice present (SUPERSEDED IN PART).
- **`design-ai-key-availability.md`** — the paired doc; its `source: 'store' | 'env'`
  union is amended to env-only. Notice present (SUPERSEDED IN PART, v11.3). It
  carries §13 (unify key resolution) and resolves through `readAdminConfig`'s status
  contract, which this design preserves. It also points here for chunk-4 test
  requirements — see §9.

---

## 9. Tests

Chunks 0–3, 5 and 6 shipped their tests with their code: those live in the vitest
suite (75 files / 1843 tests at `1700202`) plus the SQL guarantees proven with
parallel `psql` — the advisory lock, the lock ORDER, and both Vault triggers (§5.3,
§6), which vitest cannot reach. This section carries only the **unshipped chunk-4
tests**, restated from tests 21–24 (original wording at
`a624650:docs/design-ai-key-availability.md`), each run against whichever storage
the user chose (§5.1):

- **T21 — opening settings from a failure does not unmount the host.** With restored
  composer text present, open the overlay, close it, and assert the composer still
  holds the text and the transcript is unchanged. A navigation-based implementation
  fails this, and no other test here catches the loss.
- **T22 — a key entered in the overlay reaches the host without a remount.** Send
  goes from disabled to enabled, and the capabilities probe is not left showing its
  prior verdict — a stale measurement must not outlive the event that invalidated it.
- **T23 — states 5, 6 and 7 render the Settings affordance and NO inline key input.**
  Assert the *absence* of the input, not just the presence of the link: a half-done
  relocation leaves both, which is the duplicate-entry problem this UI removes.
- **T24 — `/dashboard/settings` renders standalone** when reached from `/dashboard`,
  with no host page behind it. Both presentations, one route.

And the account-aware probe fix (§3.2): once the probe passes the authenticated
`userId`, a saved account key must also flip the show-page affordance — assert the
inline affordance is absent when an account key exists.
