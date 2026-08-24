# Design — AI key availability: capability probe + real empty state

Status: **IN BUILD. §13 is NEW at v10 and is PRE-CODEX — do not build to this
text until it has been through review and Graham has given the go.**
Version: **v11** (v1 = pre-Codex, v2 = R1, v3 = R2, v4 = R3, v5 = R4, v6 = R5, v7 = invariant
registry, v8 = review-closure bookkeeping, v9 = Q3 ruled: prompt cache + mid-stream error,
v9.1 = Codex R1 on #137 folded + scope split, v10 = §8 bullet 3 promoted: key resolution
unified across all three AI surfaces, and key ENTRY relocated to a settings overlay,
**v11 = §14 REMOVED, pending re-spec in a document not yet written** — see the v11 changelog)
Scope: AI tab (`AgentChat`), `/api/agent/chat`, `/admin` key status, and — new at v10 —
`/api/charts/roadmap/parse` and `/api/charts/convert`.
**`/dashboard/settings` is NO LONGER in this document's scope (v11).**

**v11 changelog — §14 is REMOVED from this document, pending re-spec elsewhere.**

Graham ruled on **2026-08-24** that ShowRunr is **multi-tenant SaaS**, not
instance-per-customer, and that the app consolidates onto **one backend
(Supabase)** with Redis retired. The removed section specified BYOA key entry
storing to `localStorage` — explicitly *"no settings framework, no schema, no
persistence layer"* — which is a per-**browser** key. Under multi-tenant SaaS a
key must follow the **account**, which makes it a `user_secrets` question — the
same work as retiring Redis, not adjacent to it.

**⚠ STATE THIS PRECISELY, because the first draft of this changelog did not
(Codex R2 High).** As of this commit:

- The section's full text exists **only in git history, at `a624650`**. It is
  recoverable with
  `git show a624650:docs/design-ai-key-availability.md`.
- **`docs/design-single-backend.md` NOW EXISTS**, created at `894c25c` on this
  same branch. *(It did not at `d5f8a94`, when this changelog was first written;
  the statement was true then and is corrected here rather than left to rot —
  which is the whole failure mode this file's v11 history is a record of.)*
  Forward references to that filename now resolve.
- The **removed section's full text** — its argument, its citations, its
  worked detail — exists **only at `a624650`**.
- The **three rulings** it carried (the overlay as settled spec for the
  data-loss reason; the §5 states 5–7 remedy relocation; the
  BYOA-extends-to-every-surface reversal) are **restated in full in the §14
  tombstone in this document**, so no ruling depends on git history or on
  another file. They are not superseded and not cancelled. **As of `894c25c`
  they are also RE-SPEC'D**, in `design-single-backend.md` §4.3, against the
  multi-tenant `user_secrets` storage model that made the move necessary.

**Consequence for merge:** merging this document alone would put dangling
`design-single-backend.md` references on `main`. **RULED by Graham 2026-08-24:
the two documents LAND TOGETHER**, so the dangle never reaches `main` — this
document is not to be merged on its own.

*(Superseded framing, kept because the reasoning is the record: this was posed as
a choice — either the two land together, or this merges first and the dangle is
accepted as temporary and tracked. Graham took the first.)*

**§13 is unaffected and this document is now §13-only.** §13 specs resolution
through `resolveKeyMode`, which reads through `readAdminConfig`'s existing
store-then-env abstraction. Whether the store beneath is Redis, Supabase or
env-only is invisible to this spec — the centralisation §4 argued for is what
makes §13 backend-agnostic. **Nothing in the 2026-08-24 Redis findings changes a
line of §13.**

**v10 changelog** — this version exists because **§8's third out-of-scope bullet
came true**. It read:

> *"three AI surfaces fail three different ways. Unifying them is worth doing and
> is **not** in this scope; flagged so it isn't forgotten."*

Graham hit it in production on 2026-08-21: the chart builder returned
`503 "Parser is not configured"` while the AI input list worked fine. The bullet
is now promoted to spec.

| Change | Source |
|---|---|
| **§13 NEW — all three AI surfaces resolve keys through `resolveKeyMode`.** `parse` (`:48`) and `convert` (`:104`) call `getAdminConfig('claude_tryit_key')` directly, so **neither has ever had a BYOA path**. §4's whole argument against duplicated resolution applies to them and was never extended to them. | §8 bullet 3, forced by a live defect |
| **§13.3 — "parse degrades to the manual editor" is NOT AVAILABLE and is not specified.** `RoadmapBuilder` sets `view` only from `specToView(...)` (`:74` edit, `:104` parse). **There is no blank-spec entry point**, so the builder is unusable without a successful AI call. Manual-first roadmap building is a feature, and it is backlog. | Corrected against code before drafting |
| ~~**§14 NEW — BYOA key ENTRY moves off the operational pages**~~ | **REMOVED at v11.** Its **rulings** are restated in the §14 tombstone below; its **full text** (argument, citations, worked detail) is only at `a624650`, and has **not been re-spec'd** into a replacement document. |
| ~~**§14.4 — the overlay is settled spec**~~ | **REMOVED at v11.** The ruling still stands and the data-loss reason (§5.2a's prompt cache is write-only in production) is restated in the §14 tombstone so it is not lost. |
| ~~**§14.2 — with ONE key surface, BYOA extends to every AI surface**~~ | **REMOVED at v11.** Ruling restated in the tombstone. |
| §5 — states 5, 6 and 7 keep their copy and lose their inline key input. **Remedy superseded, and the superseding spec is currently UNWRITTEN** — do not build these states' key field from this document. | Follows from the removed section, v11 |
| §8 — bullet 3 promoted to §13; its `convert/route.ts:102` citation was stale (the call is `:104`, `:102` is a comment). | Promotion + re-verification |
| §9 — tests 16–20, 25, 26 (§13). **Tests 21–24 REMOVED with §14 at v11; original text at `a624650`, carried forward as `design-single-backend.md` §9 chunk 4's test requirement.** | Follows from §13 |

**Scope split, ruled by Graham 2026-08-21 — §13 and §14 are TWO work items and
must not share a PR. At v11 the split became a document split as well:**

| # | Work item | Ships as | Why separate |
|---|---|---|---|
| 1 | **§13** — unify key resolution; honest failure copy | **this document** | Strictly an improvement even if §14 never ships, and it is what is blocking production today. Depends on nothing in §14. |
| 2 | ~~**§14** — settings overlay + the §5 relocation~~ | **`docs/design-single-backend.md` §4** (created `894c25c`, same branch) | Its storage layer is a `user_secrets` decision under Graham's 2026-08-24 multi-tenant ruling, which is the same work as retiring Redis. Keeping it here would have left a known-stale section inside a mergeable document — the exact failure mode the 08-24 sweep exists to remove. |

**v10.1 changelog** — Codex R1 on PR #150 returned **NOGO (2 High + 2 Medium)**.
All four folded, nothing declined. **Every one of them is the same defect class:
a claim in one section that another section quietly contradicts** — which is
what this document exists to catch and, three times in v10, did not.

| Change | Source |
|---|---|
| **§13.4.2 NEW — §13 now includes MINIMAL CLIENT KEY DELIVERY.** v10 claimed §13 "depends on nothing in §14" *and* that its BYOA half was §14.2 — so as written **work item 1 did not fix Graham's symptom.** A route that accepts `Authorization` is inert while no client sends one, and neither chart client sends any header but `Content-Type` (`chart-upload.ts:51`, `RoadmapBuilder.tsx:91`). Both now read `lib/byoa-key-storage` directly. | Codex R1 **High** |
| **§13.5 + Q6 CLOSED — the converter gets a distinct `no_key` reason.** v10 required the `unconfigured`/`error` distinction to propagate on both chart routes while leaving the converter at `degrade('failed')` and Q6 open. **Those cannot both be true**: `'failed'` erases the distinction the same sentence demands. Q6 is closed as a **yes** inside this design rather than carried. | Codex R1 **High** |
| **§9 test 20 scoped to the three routes**, with `admin/backfill-chart-overlays` explicitly excluded and the reason given. v10's blanket "no file under `app/api/`" **would have failed on the first run** — `:158` calls the key, and §4.1 named it as one of four callers a version ago. | Codex R1 **Medium** |
| **§13.5 gains PRE-§14 copy that names a surface that exists.** v10's interim copy was "the same, without the link" — still pointing at a Settings page that does not exist yet. It now points at the show page's AI tab, which is where a key can actually be entered today. | Codex R1 **Medium** |

**★ The lesson, and it is the one worth keeping from this round:** all four
findings are *internal* contradictions — §13's independence claim vs §13.4, §13.4's
distinction requirement vs §13.5's converter row, test 20's scope vs §4.1's own
list of callers, §13.5's copy vs §14's existence. **Nothing needed external
knowledge to catch.** A self-sweep asking "does any section here contradict any
other section here?" would have found every one, and §5.2a's own "self-sweep after
the fold" note says to do exactly that. It was not done for v10.

**v9 changelog** — §11 Q3 was reserved for Graham and he ruled on 2026-08-14.
This is a **spec change to §5.2**, not a build deviation, so it lands before
chunk 4 rather than in §12 after it:

| Change | Source |
|---|---|
| **§5.2a NEW — cache the sent prompt in `sessionStorage`** via an injectable-store `lib/prompt-cache.ts`. Text is never lost on failure *or* success, so `streamStarted` no longer decides whether the user keeps their words — only whether restoring is automatic. | **Graham, Q3 ruling** |
| **§5.2a.2 NEW — the client silently swallows mid-stream `error` events.** The parse loop handles only `content_block_*`; an `error` event falls through and the loop commits partial text with no error shown. Live defect, found while verifying Q3. | Found in verification |
| §5.2a.5 NEW — edit-and-resend from the transcript, replacing the composer-history alternative. Resend stays explicit. | **Graham's call** |
| §5.2a.1 — **Q3's option C (terminal error frame from our route) WITHDRAWN.** Two assumptions behind it were false in code: pre-stream failures already fail closed at `route.ts:102`, and `route.ts:121` is a body passthrough so a frame would need a `TransformStream`. | Corrected against code |
| §0 invariant 5 strengthened from "no message lost on a **pre-stream** failure" to "on **any** failure", now that a mechanism exists to enforce it. | Follows from §5.2a |
| §9 — tests 13e–13k. | Follows from §5.2a |

**v9.1 changelog** — Codex R1 on PR #137 returned **NO-GO**; both findings folded,
plus a scope split Graham called:

| Change | Source |
|---|---|
| **§5.2a.2b NEW — a `failed` turn is excluded from `buildApiMessages`**, and its tool calls are **discarded, not left pending.** v9.0 said "keep partial content" and nothing about API history, so a failed half-turn would have been replayed to Claude as a completed turn. | Codex R1 **medium** |
| §5.2a.2b — the collision that finding exposed: a tool call completing *before* the error left `hasPendingTools` true, **locking the composer** behind approve/reject for a turn the model never finished. This document's own defect class, introduced by its own fix. | Found folding the above |
| §5.2a.6 — stale §5.1 clear-action bullet corrected and returned to §5.1. It claimed the handler "resets `rememberKey`"; it does not (`page.tsx:5398`), and post-#133 that has no meaning. | Codex R1 **low** |
| §5.2a.5 — clarified that "the prior turn is not mutated" describes *editing*, and is not a claim that failed turns are canonical context. | Codex R1 low |
| **§5.2a.0 NEW — §5.2a is THREE work items**, not one: chunk 4 (cache + restore), a separate PR (mid-stream error), and edit-and-resend **deferred past UAT**. | **Graham**, on scope growth |
| §9 — tests 13l, 13m. ~29 → ~31. | Follows from §5.2a.2b |

**v2 changelog** — Codex R1 returned **no blockers**; three refinements folded:

| Change | Source |
|---|---|
| §4 — `lib/agent-key.ts` extraction is now **decided**, not an open question. The shared **fallback quota state** moves with it. | Codex R1 high |
| §5.1 NEW — a stale/invalid saved BYOA key currently **masks working try-it**. Adds a prominent Clear-key action + re-probe. | Codex R1 medium |
| §4 / §6 — probe `error` stays **distinct from `unconfigured`** internally, even though user-facing copy converges. | Codex R1 medium |
| §7 — raise the quota for UAT (was an open question) | Codex R1 answer |
| §5 — do **not** hide the AI tab; show the honest empty state | Codex R1 answer |
| §6 — exposing `source` behind admin auth confirmed fine | Codex R1 answer |

**v3 changelog:**

| Change | Source |
|---|---|
| **§4.1 NEW — `readAdminConfig`, a status-aware config read.** v2's error-vs-unconfigured requirement was **unsatisfiable** through `getAdminConfig`, which swallows Redis errors. | Codex R2 **high** |
| §4 — `quota` and all arithmetic derive from `TRYIT_QUOTA`; no literals | Codex R2 medium |
| §5 — the false privacy sentence is fixed **in the copy block itself** | Codex R2 medium |
| §7 — quota set to **50** for UAT | Codex R2 answer |
| §5.1 — **no auto-retry** after clearing a bad key | Codex R2 answer |

**v4 changelog:**

| Change | Source |
|---|---|
| **§5.2 NEW — the failed message is lost today.** `sendMessage` clears the composer before the fetch; v3's "retry is one keystroke" was false. Restore text + drop the undelivered transcript entry on any pre-stream failure. | Codex R3 **high** |
| §4 — the `agent-key.ts` bullet now names **`readAdminConfig`**, not `getAdminConfig` | Codex R3 low |
| §6.1 — `source: 'env'` and the KV-unreachable banner are now a **coupled requirement**, not two gaps | Codex R3 answer |
| §9 — behavioral send-path test (14), paired-outage test (15), message-preservation tests (13a–13d) | Codex R3 answer |
| Q1 (wrapper), Q2 (`ok`/`env`), Q3 (equivalence test) all **closed** | Codex R3 answers |

**v5 changelog:**

| Change | Source |
|---|---|
| §5.2 — the predicate is a **`streamStarted` flag set at the first read chunk**, not `assistantText.length === 0`. A tool-only stream has no text and must not be treated as never-sent. | Codex R4 **medium** |
| §9 — tests 13c-i (tool-only stream), 13c-ii (unparseable bytes), 13c-iii (`tryitExhausted` restores). ~19 → ~22. | Codex R4 |

**v6 changelog** — Codex R5 returned **no findings**; two open calls ratified:

| Change | Source |
|---|---|
| §5.2's **broader pre-stream restoration** and **transcript removal** are now settled spec, not proposals. Open since R4. | Codex R5 answer |
| §11 Q1 and Q2 closed | Codex R5 answer |

**v8 changelog** — **no spec change.** Bookkeeping so the doc stops claiming a review
round that is not coming. Graham closed design review at R6 (2026-08-11) with no R7, and
this doc merges to main mid-build so the code citations in `lib/agent-key.ts` and
`tests/agent-key.test.ts` resolve:

| Change | Source |
|---|---|
| Status line — was "no R6 planned" while §11 was titled *Open questions for Codex R6*. Now states review is closed and the build is in flight. | v7 shipped stale |
| §11 Q3 and Q4 given explicit dispositions instead of sitting undisposed. **Q4 is answered by what chunk 1 actually built**; **Q3 is carried to chunk 4 as a call for Graham**, default = ship as specified. | Graham closed review |
| §12 NEW — build deviations, empty at merge time. Chunk 1 introduced none; later chunks append here rather than leaving main's doc stale (the failure this doc's merge ordering was chosen to accept, with this section as the mechanism). | Merge-order decision 2026-08-12 |

---

## 0. Invariants this design establishes

*(New in v7 — **additive only, no spec change.** Codex R5 returned no findings;
nothing below alters the approved design. The list exists so the build can be
cross-checked against it per chunk, and so any future edit is walked against the
rules rather than re-read.)*

1. **The UI never claims a capability it has not verified with the server.**
   The defect this document exists to fix. (§2, §5)
2. **`unconfigured` and `error` stay distinct in data**, even where the
   user-facing copy converges. (§4.1, §5)
3. **`error` means no usable value *and* the store was unreachable.** A working
   env fallback is `ok`/`env`, never `error`. (§4.1)
4. **A user-facing "everything is fine" during a partial outage requires
   `/admin` to report the outage independently.** The two are one requirement,
   not two gaps. (§6.1)
5. **No user message is lost on ANY failure, and no message is ever silently
   re-sent.** Both halves, always together. *(Strengthened in v9 — was "on a
   pre-stream failure". The qualifier existed because nothing enforced the wider
   claim; `lib/prompt-cache.ts` now does.)* (§5.2, §5.2a)
6. **Quota values derive from `TRYIT_QUOTA`.** No literals in response,
   arithmetic, or tests. (§4)
7. **The probe never returns any substring of a key**, in any state. (§4, §9)

**The rule: every addition is walked against all seven before a version ships**,
and each claim must name the mechanism that enforces it. Invariants 2, 3 and 5
each became a Codex finding *because the mechanism was unnamed or unenforceable*
while the prose was correct.

---

## 1. The reported symptom, and what it actually is

Reported: *"my graham.edwards@gmail.com account has no active AI key."*

**There is no per-account AI key anywhere in ShowRunr.** Nothing about the AI tab
is account-scoped. Signing in as a different user changes nothing. The correction
matters because it changes what we build.

Three — and only three — key paths exist:

| Path | Where the key lives | Scope |
|---|---|---|
| BYOA | `localStorage['showrunr-claude-key']` (`page.tsx:4924-4951`) | **this browser** |
| Try-it | Redis `admin:claude_tryit_key`, env `CLAUDE_TRYIT_KEY` fallback (`lib/admin-config.ts:27-39`) | **global, one key for everyone** |
| — | `user_secrets.claude_api_key` (`001_initial_schema.sql:49-55`) | **dead code — zero references in any `.ts`/`.tsx`** |

Try-it quota is `quota:<ip>` — **10 messages per IP per 30 days**
(`app/api/agent/chat/route.ts:12-13, 46-47`). Per IP, not per account, not per
show.

So "no active key" on that account means one of:

1. `admin:claude_tryit_key` is not set in Redis, and `CLAUDE_TRYIT_KEY` is not in
   the environment (**confirmed: it is not among the Vercel production env vars**
   — only `NEXT_PUBLIC_RELAY_URL`, the three Supabase vars, the two Google vars,
   `ADMIN_SECRET`, `REDIS_URL`), or
2. the key was set in Redis and has since been lost, or
3. that browser has no BYOA key in localStorage and the IP's 10 free messages are
   spent.

**Unverified.** I could not read production Redis or the admin settings endpoint
from here. Case 2 is a hypothesis, not a finding. §6 makes the state legible so
this is never a guessing game again.

---

## 2. The actual UX defect

`AgentChat` **never asks the server whether a key exists.** It renders
optimistically and discovers the truth only after the user has typed and sent.

Initial render with no key configured, `page.tsx:5312-5322`:

> Describe your band in plain English. The AI builds your stage plot, input list, and monitors.
> Try it free — or <u>enter your own API key</u> for unlimited use. <u>(get a key)</u>

The user types, sends, and gets a red line — the route's 401 surfaced verbatim
(`route.ts:118-123` → `page.tsx:5095` → rendered at `:5408-5410`):

> No API key provided and try-it mode is not available.

Three things are wrong:

1. **The invitation is a lie.** "Try it free" is offered when try-it is not
   configured.
2. **The failure is a dead end.** `canSend` (`page.tsx:5298`) is
   `!streaming && !hasPendingTools && (!!apiKey || !tryitExhausted)`. With no
   server key, the route returns **401 without `tryitExhausted`**, so
   `setTryitExhausted` never fires (`page.tsx:5028` only sets it on the 429
   path). `canSend` stays `true` and the user can retry forever, getting the same
   error each time.
3. **The remedy is hidden.** The key field only renders when
   `needsKey || apiKey || showKey` (`page.tsx:5331`), and `needsKey = !apiKey &&
   tryitExhausted` (`:5299`) — which, per (2), is never true in this state. The
   only way to the input is noticing a small underlined phrase mid-sentence.

Net: in the exact condition Graham hit, the panel invites you to try, fails
opaquely, and hides the fix.

---

## 3. Decision taken

Ratified by Graham, 2026-08-10:

> **Fix the empty state and keep BYOA in localStorage.** Add a server capability
> probe so the AI tab knows up front whether try-it is live; render real
> instructions and a visible key field when it isn't; disable send. No schema
> change.

Explicitly **out of scope**: persisting a per-user BYOA key server-side. The
`user_secrets` table stays dead. See §8.

---

## 4. Capability probe

New route: `GET /api/agent/capabilities`.

```jsonc
{
  "tryit": "available" | "exhausted" | "unconfigured" | "error",
  "tryitRemaining": 7 | 0 | null,   // null unless tryit is available/exhausted
  "quota": TRYIT_QUOTA             // serialized from the constant, never a literal
}
```

**`quota` is derived from `TRYIT_QUOTA` (`route.ts:12`), not written as a
number** — Codex R2 medium. v2 hard-coded `10` in this example and in the
`remaining = max(0, 10 - count)` arithmetic while §7 raises the constant to 50,
so the doc contradicted itself and invited an implementer to bake in a literal
that silently disagrees with the sender. Response, arithmetic, and tests all read
the constant.

### 4.1 The config read must be status-aware (new in v3)

**Codex R2 high, and it is correct: the v2 spec was unsatisfiable.** §5 requires
`error` to stay distinct from `unconfigured`, while step 1 resolved state through
`getAdminConfig('claude_tryit_key')` — which cannot express the difference:

```ts
// lib/admin-config.ts:27-39
export async function getAdminConfig(key: string): Promise<string | null> {
  try {
    const redis = await getRedis();
    if (redis) { /* ... */ }
  } catch {
    // Redis not configured or unavailable — fall through to env var
  }
  return process.env[key.toUpperCase()] || null;
}
```

The `catch` swallows the failure and the function returns `null` — **identical**
to a clean "no key configured". With Redis down and no `CLAUDE_TRYIT_KEY` in the
environment (which is production's actual state — the env var is not set), a
store outage renders as *intentionally off*. That is precisely the confusion this
whole document exists to end, reintroduced one layer down.

**New in `lib/admin-config.ts`:**

```ts
export type ConfigRead =
  | { status: 'ok';    value: string; source: 'store' | 'env' }
  | { status: 'none' }                        // store reachable, nothing set
  | { status: 'error'; reason: string };      // store unreachable, no env fallback

export async function readAdminConfig(key: string): Promise<ConfigRead>
```

`getAdminConfig` stays as-is — it is called by four other routes
(`agent/chat`, `charts/convert`, `charts/roadmap/parse`,
`admin/backfill-chart-overlays`) and this design does not touch them.
`readAdminConfig` is the status-aware sibling; `getAdminConfig` can be
reimplemented as a thin wrapper over it so there is one lookup, two shapes.

Note the ordering subtlety it must preserve: a Redis failure with a **valid env
fallback** is still `ok`/`env`, not `error`. `error` means *no usable value and
the store was unreachable*. Only that combination is ambiguous today.

This read also supplies §6.1's `source` field — the same information, surfaced in
two places. Deriving both from one call is what keeps them honest.

**Resolution** (mirrors `POST /api/agent/chat:90-123` minus the send):

1. `readAdminConfig('claude_tryit_key')`:
   - `error` ⇒ `tryit: 'error'`, remaining `null`. Do not touch the quota store.
   - `none` ⇒ `tryit: 'unconfigured'`, remaining `null`. Do not touch the store.
2. Otherwise **peek** the quota: `GET quota:<ip>` — a plain read, no `INCR`, no
   `EXPIRE`. `remaining = max(0, TRYIT_QUOTA - count)`.
3. `remaining === 0` ⇒ `exhausted`, else `available`.

**Hard requirements:**

- **The probe never consumes quota.** A tab-open must not cost a free message.
  This means it cannot reuse `consumeTryitQuota` (`route.ts:37-70`) — that
  function `INCR`s unconditionally. Add a sibling `peekTryitQuota(ip)`.
- **The probe never returns the key, its length, or its prefix.** Only the three
  enum values above.
- The in-memory fallback map (`route.ts:16, 22-35`) must be peekable the same
  way. Note it is process-local, so on serverless its numbers are already
  advisory; the probe inherits that and does not make it worse.
- Cache-Control: `no-store`. A cached "available" would be worse than no probe.

**Extraction is DECIDED, not optional.** v1 left this as an open question; Codex
R1 closed it: *"extract `lib/agent-key.ts`. Do not duplicate capability
resolution. The current quota fallback is module-local in
`app/api/agent/chat/route.ts:15`; if probe/send each grow their own fallback
state, no-Redis behavior will drift immediately."*

That second sentence is the sharp part and is why this is not a style preference.
`fallbackQuota` is a module-level `Map` (`route.ts:16`). A probe route with its
own copy would count in a **different map** from the sender — so with Redis down,
the panel and the send would disagree about how many messages remain, in the
exact scenario where the fallback is load-bearing.

**New `lib/agent-key.ts` owns all of it:**

```ts
export async function resolveKeyMode(
  clientKey: string | undefined,
  ip: string,
  opts: { consume: boolean },
): Promise<KeyMode>
```

- the `fallbackQuota` map — **one instance**, imported by both routes
- `consumeTryitQuota` / `peekTryitQuota` (`consume: true | false`)
- the **`readAdminConfig('claude_tryit_key')`** lookup — status-aware, per §4.1.
  *Corrected in v4 (Codex R3 low): v3 still named `getAdminConfig` here while
  §4.1's entire fix was to stop resolving state through it. An implementer
  reading §4 in isolation would have rebuilt the exact ambiguity §4.1 exists to
  remove.* `resolveKeyMode` therefore branches on the `ConfigRead` **status**,
  and propagates `none` vs `error` outward rather than flattening both to "no
  key" — the distinction §5 depends on is made here or not at all.
- the BYOA-wins precedence currently at `route.ts:100-123`

`app/api/agent/chat/route.ts` and the new capabilities route both call it and
neither owns quota state. This is a refactor of a working route; it is justified
by the drift it forecloses, not by tidiness.

**Codex R3 confirmed the wrapper is worth it.** The safety condition attached to
it is that the send path is verified **behaviorally, not by byte-for-byte
equivalence** with today's inline code — §9 test 14. Byte-equivalence would just
freeze the current shape, including the parts §4.1 is deliberately changing.

**Rate limiting:** the probe is unauthenticated and hits Redis. Reuse
`checkRateLimit(ip, 'agent-capabilities')` from `lib/admin-rate-limit.ts:11-21`.
Its process-local `Map` is weak (§ same caveat as above) but it is what exists,
and the endpoint returns no secret, so the exposure is a Redis read per request.

---

## 5. AI tab states

> **★ v11 — the REMEDY in states 5, 6 and 7 is superseded, and the superseding
> spec was removed at v11. See the §14 tombstone below for the ruling it
> carried.**
> Every state's condition, copy and `canSend` behaviour stands. What changes is
> that the inline key input becomes an affordance opening the settings overlay.
> **Do not build states 5–7's key field from this section alone, and do not
> build it from §13 either — §13 does not touch key ENTRY.**
>
> §5's `page.tsx:5298` / `:5331` citations are v2-era and no longer resolve.
> **The current mechanisms, stated here so this section does not depend on any
> other document:** `canSendMessage({ availability, streaming, hasPendingTools })`
> at `page.tsx:5528`, and `availability.showKeyField && !apiKey` at `:5529`,
> both via `lib/agent-availability`.

`AgentChat` gains `probe: 'loading' | Capabilities | 'error'`, fetched once on
mount — **skipped entirely when a BYOA key is already in localStorage**, since
that key wins at `route.ts:100-104` regardless of try-it state.

| # | Condition | Render |
|---|---|---|
| 1 | BYOA key present | Today's behavior. Key field shown collapsed with Clear + Remember. No probe. |
| 2 | probe `loading` | Composer disabled, no error, no "try it free" claim. |
| 3 | `available`, remaining > 0 | Today's behavior + honest count: "*N free messages remaining.*" (existing copy at `page.tsx:5324-5329`, now correct on first paint instead of only after a send). |
| 4 | `exhausted` | Existing exhausted copy, key field **expanded** (`needsKey` already does this once the flag is set). |
| 5 | **`unconfigured`** | **New — the state that has no design today.** |
| 6 | probe `error` | Renders **as** state 5 for the user, with a softer lead ("Couldn't check AI availability"). Never claims "try it free". |
| 7 | BYOA key present **and rejected** | **New in v2 — see §5.1.** |

**States 5 and 6 look the same to the user but must not be conflated
internally** (Codex R1 medium). The probe returns `unconfigured` and `error` as
**distinct values**, and `/admin` (§6) and any logging keep them apart. The
distinction is "try-it is intentionally off" vs "Redis or the API is down" —
which is precisely the question Graham had to ask a human to answer this week.
Converging them in the UI is a copy decision; converging them in the data would
throw away the diagnostic.

### 5.1 A stale BYOA key masks working try-it (new in v2)

Codex R1 medium, verified: §5 skips the probe whenever localStorage holds a key,
and `route.ts:100-104` prefers `Authorization` unconditionally. So a user whose
saved key has been **revoked, rotated, or mistyped** sees only:

> Invalid API key. Check your key and try again.

(`route.ts:149-156`) — even when try-it is configured and would have worked. The
app has a working path available and never offers it. For a UAT tester who pasted
a key once, months ago, this reads as "the AI is broken."

**Spec:**

- On a `401`-derived `Invalid API key` error, render the error **with a
  prominent `Clear saved key` button**, not just red text. The existing Clear
  control (`page.tsx:5340-5347`) is a small link beside the input and is not
  discoverable at the moment of failure.
- Clearing the key **re-runs the probe**, since the reason for skipping it has
  gone. If try-it is available, the panel drops straight into state 3 and the
  user can continue without a key at all.
- **The failed message is not auto-retried.** Send is re-enabled and the user
  presses it. Codex R2: *"Do not auto-retry the failed message after clearing a
  bad key; re-enable send and leave retry explicit."* Agreed — a `401` from
  Anthropic means the upstream call did not bill or apply, but the request did
  reach our proxy, and silently re-sending on a state change is the kind of
  invisible duplicate that is miserable to debug. Retry must therefore be one
  keystroke, which is §5.2 — and today it is not.

### 5.2 "The composer retains the text" is false today (new in v4)

**Codex R3 high, verified.** v3 asserted retry was one keystroke because the
composer still held the message. It does not. `sendMessage` clears the input
*before* the request and no path puts it back:

```ts
// app/[owner]/[show]/page.tsx:4994-4999
async function sendMessage(text?: string) {
  const userText = text ?? input.trim();
  if (!userText || streaming) return;
  setInput('');              // ← cleared here, before any fetch
  setError('');
```

and the failure path is only `catch (e) { setError(...) }` (`:5094-5096`). So
after an invalid-key failure the tester is left with their message stranded in
the transcript, an error under it, and **an empty composer** — the "one
keystroke" is actually retyping the whole prompt. That lands hardest on exactly
the message worth retrying: the long one.

**Spec — restore on pre-stream failure** *(v4–v8; superseded by §5.2a in v9, and
its `streamStarted` mechanism superseded again by item 2's R1 fold — see §5.2a.4
and §12. Retained because the pre-stream reasoning below still holds and v9 built
on it; **the flag it names no longer exists in the code**, so read the mechanism
here as history and §5.2a.4 as current.)*:

- When a send fails **before the response stream has started**, restore
  `userText` to the composer **and remove the optimistic user message** from the
  transcript. Nothing was delivered, so the transcript should not claim
  otherwise, and a restored composer plus a duplicated transcript entry would be
  the worst of both.
- The predicate is **stream-started**, not "status was 401". A failure after the
  stream began means the upstream call did happen and may have billed; that
  message stays in the transcript, unrestored, and the user decides. Scoping the
  fix to the invalid-key path only would leave every other pre-flight failure
  (offline, 500, aborted) eating the text just as silently — same defect, one
  branch over.

**The predicate is a flag, not a text-length check** *(tightened in v5 — Codex
R4 medium)*. v4 wrote it as "no bytes streamed", which an implementer can
plausibly render as `assistantText.length === 0` — and that is **wrong**, because
the stream can carry tool-use events with no text at all. `content_block_start`
with `type: 'tool_use'`, then `input_json_delta` (`page.tsx:5060-5079`) produce a
fully-started stream and an empty `assistantText`. A tool-only turn that fails
mid-flight would be treated as never-sent, restoring a message the model had
already begun acting on.

> **Spec:** `let streamStarted = false`, set to `true` on the **first
> `reader.read()` that yields a chunk** — at `buffer += decoder.decode(value)`
> (`page.tsx:5046-5048`), *before* any SSE parsing. Restoration is gated on
> `!streamStarted` and on nothing else.

Set at the read, not at the parse, so it is also true for a stream that starts
and then emits only unparseable lines — the request happened either way, which
is the only thing the flag is asserting.

The load-bearing case still works: an invalid key is a **non-`ok` response**, so
`sendMessage` throws at `page.tsx:5026-5030` before `res.body.getReader()` is
ever called. `streamStarted` is `false`, the message is restored. Same for
`tryitExhausted` (`:5028`) — a tester who runs out of free messages keeps their
text while they paste a key, which is the exact moment losing it would hurt most.
- Retry stays **explicit** either way. Restoring the composer re-arms the
  existing Send control; it does not re-send. This satisfies Codex R2's
  no-auto-retry rule and R3's don't-lose-the-message rule at the same time,
  which is the combination v3 claimed and did not have.

Codex offered "or render an explicit retry action from the failed user message"
as the alternative. Rejected, narrowly: it adds a per-message affordance and a
new message state to a transcript that has neither, and it leaves the
already-cleared composer as a second thing to reason about. Restoring the input
uses only state that exists. *(v9 note: Graham's ruling reverses this narrow
rejection — §5.2a adds exactly such a per-message affordance, for a reason
neither round considered. See §5.2a.)*

---

### 5.2a Cache the prompt; stop inferring whether it is safe to restore (new in v9)

**Graham's ruling, 2026-08-14, closing §11 Q3.** Verbatim:

> "I think it's a low-tax/cost fix to cache the text as we would in a
> conversational chat, even if just tied to the session and not in a persistent
> store. This way no text is lost on a failure, or on success. Note, sometimes,
> with success too, we want the original text for reference to see if the
> response aligns."

#### 5.2a.0 Scope — this section is THREE work items, not one

**Graham's call, 2026-08-14, after §5.2a as first drafted grew chunk 4 from two
concerns to five.** Recorded here because scope growth inside a UAT-readiness
pass is the thing most worth catching early, and it accreted across a
conversation without anyone naming it.

| # | Work item | Ships as | Why here |
|---|---|---|---|
| 1 | §5.1 stale-key recovery + §5.2a.3 prompt cache + §5.2a.4 auto-restore | **chunk 4** | The original ask. Directly stops a tester losing typed work. |
| 2 | §5.2a.2 mid-stream error + §5.2a.2b failed-turn history rule | **its own PR** | A live defect, independent of the cache, and testable alone. |
| 3 | §5.2a.5 edit-and-resend | **deferred past UAT** | Real feature, largest new UI surface here, and a nice-to-have rather than a rough edge. |

Item 3 is **specified but not scheduled** — it is written down so the decision
does not have to be re-derived, not because it is next.

**Why the split is safe:** item 1 depends on nothing in items 2 or 3. Item 2's
history rule (§5.2a.2b) only matters once failed turns can exist, which is item 2
itself. Item 3 reads the cache item 1 builds, so it must not land first.

**Why this is better than what I originally proposed.** The old §5.2 was ~2
concerns; my first v9 draft made chunk 4 five. Nothing in the growth was
individually wrong, which is exactly how it went unnoticed.

**Why this is a better frame than the question it answers.** §11 Q3 asked
whether `streamStarted` should be set at the read or the parse — that is, how to
*guess* whether a partially-delivered turn is safe to restore. Every answer
traded data loss against a double-send. A cache dissolves the trade: the text is
never lost, so `streamStarted` no longer decides whether the user keeps their
words, only whether restoring is **automatic**. Resending stays an explicit user
action in every ambiguous case, which satisfies Codex R2's no-auto-retry rule and
R3's don't-lose-the-message rule simultaneously — without the double-bill risk
that setting the flag at the parse would have carried.

It also covers a case the old §5.2 never addressed at all: **the prompt is wanted
on success**, to check the response against what was actually asked.

#### 5.2a.1 Two corrections to the record — verified in code, not reasoned

Both were assumptions in the Q3 framing. Both are wrong, and the option they
were used to justify is **not being built**.

1. **A pre-stream upstream failure already fails closed.** `route.ts:102` tests
   `anthropicRes.ok` **before** any streaming and returns a JSON 401/502. The
   client throws at `page.tsx:5082`, before `res.body?.getReader()` at `:5089`.
   No bytes flow, so nothing reaches the transcript and the message restores.
   *(Written when this was `streamStarted` staying `false`; after item 2's R1
   fold the flag is gone and the predicate reads the stream state directly. The
   conclusion is unchanged — an empty state restores either way.)* **The
   "proxy opens, then upstream dies" shape Q3 was written about is already
   handled** for every failure that happens before Anthropic's response headers.
2. **A terminal error frame from our own route is not cheap.** `route.ts:121` is
   `return new Response(anthropicRes.body, ...)` — a direct passthrough of the
   upstream body. Injecting a frame means wrapping it in a `TransformStream` and
   giving up the passthrough. Q3's "we own the route, so we can signal
   explicitly" understated the cost by a lot.

**Therefore the route is NOT changed.** Q3's option C is withdrawn on the
evidence above.

#### 5.2a.2 The case that IS ambiguous — and it is a live defect

The only shape where "did this deliver?" is genuinely unanswerable is: Anthropic
returns `200`, the stream opens, and it **then** fails mid-flight. Anthropic
signals that in-band with an `error` event.

**The client throws it away.** The SSE parse loop handles `content_block_start`,
`content_block_delta` and `content_block_stop` and nothing else
(`page.tsx:5116-5142`). An `error` event parses as JSON, matches no branch, and
falls through. The loop then ends normally and `page.tsx:5149` commits whatever
partial text arrived **with no error surfaced**. A stream that dies mid-flight is
indistinguishable, to the user, from Claude choosing to stop.

> **Spec:** handle `event.type === 'error'` in the parse loop. Set an
> `streamError` flag, surface `event.error?.message` through the existing
> `setError` path, and keep whatever partial content arrived. Do **not** discard
> the partial assistant message — it was delivered and it was billed.

This is the fourth instance in this project of an error path that is silent about
the state it strands the caller in (§11 Q3 lineage: #123 R5, the `'skipped'`
probe value, the probe 429, now this). It is also the cheap form of what Q3's
option C wanted: **the explicit signal already exists in the stream — we were
discarding it.** No route change required.

##### 5.2a.2b What a failed turn means to the *model* (Codex R1 medium on #137)

**The gap:** v9 as first written said "keep whatever partial content arrived" and
"the prior turn is not mutated or truncated", and said nothing about API history.
`buildApiMessages` (`page.tsx:5015`) replays **every** assistant message as
canonical context, so a failed half-turn would be handed to Claude on the next
send as though it had completed normally. The model would then continue from
something it never actually said.

> **Spec:** a mid-stream error marks the assistant turn **`failed: true`**.
> A `failed` turn is **excluded from `buildApiMessages` entirely** — both its
> assistant blocks and any `tool_result` derived from them. It remains in the
> transcript, visibly marked, because the user should see what arrived.

Excluding rather than truncating, for two reasons:

1. **A truncated turn is not honest context.** Sending half a sentence as a
   completed assistant message invites the model to treat it as deliberate.
2. **A replayed `tool_use` without its `tool_result` is a malformed request.**
   `buildApiMessages:5024-5028` emits `tool_use` blocks, and the paired
   `tool_result` is only emitted when a call has left `pending`
   (`:5032`). Keeping a failed turn in history would produce exactly that
   dangling pair.

**And the collision this exposed, which v9 would otherwise have shipped:** tool
calls are pushed at `content_block_stop` with status `'pending'`
(`page.tsx:5134`). A stream that completes a tool block and *then* errors leaves
a pending call in the transcript — and `hasPendingTools` (`:5353`) feeds
`canSend` (`:5354`), so **the composer locks with "Apply or reject pending
changes first"** for changes the model never finished proposing. That is this
document's own defect class, introduced by its own fix.

> **Spec:** a `failed` turn's tool calls are **discarded, not left pending.**
> The turn proposed nothing complete, so there is nothing to approve. This keeps
> `hasPendingTools` false and the composer usable.

*Accepted tradeoff, stated:* a tool call that did complete before the error is
thrown away rather than offered. That loses a possibly-valid proposal. It is the
right trade — the alternative gates the user behind an approve/reject decision
about a turn that failed, and applying half a plan is worse than re-asking.

**Verified, so it is not claimed as a defect:** `canSend` already blocks sending
while tools are pending, so there is **no pre-existing dangling-`tool_use` bug**
to fix here. The hazard is created only by keeping a failed turn, which is why
the rule above exists.

#### 5.2a.3 The cache

**Substrate: `sessionStorage`** (Graham's call, 2026-08-14). Survives a reload or
a crash; dies with the tab. That is the literal reading of "tied to the session,
not a persistent store".

> **Spec:** a new pure module `lib/prompt-cache.ts`, over an **injectable** store
> — `Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>` — exactly the shape
> `lib/byoa-key-storage.ts` established in #133.

**This shape is mandatory, not stylistic.** Under `@vitest-environment jsdom` in
this repo `localStorage`/`sessionStorage` are bare `{}` with `getItem`
undefined, so a module that closes over the global store **cannot be tested at
all**. That is precisely why the BYOA path shipped with zero coverage before
#133. An injectable store is tested in the `node` environment against a fake.

Rules:

- Cached per show, keyed on the existing owner/show identity, so one show's
  prompts never surface in another.
- Retains the last **10** prompts, most recent first, de-duplicated on exact
  repeat. A ring, not unbounded growth — `sessionStorage` is small and a prompt
  can be long.
- Written **on send**, before the fetch, in the same place `setInput('')` clears
  the composer (`page.tsx:5054`). The cache write and the clear are one action;
  neither may happen without the other.
- Never contains key material. The prompt is user prose; the BYOA key travels in
  a header and must not reach this module. *(Invariant 7.)*

**Privacy, stated because it is a real cost:** on a shared venue laptop the
prompt text stays readable in that tab's `sessionStorage` until the tab closes.
Accepted — prompts are show notes, materially less sensitive than the API key
that already persists more aggressively (see #134). It is a cost, not a
non-issue, and it is recorded here so nobody re-derives it as a surprise.

#### 5.2a.4 Restoration behaviour

| Failure shape | Delivered? | Composer | Transcript |
|---|---|---|---|
| Non-`ok` response (invalid key, quota exhausted, 500, offline) | No — `route.ts:102` fails closed before streaming | **Auto-restore** | Optimistic message removed |
| Stream opened, then failed (`error` event **or** transport drop), **with text or a completed tool call** | Yes, partially — billed | Not auto-restored | Partial content **kept and marked `failed`**, error shown under it. Excluded from API history, tool calls discarded (§5.2a.2b) |
| Stream opened, then failed, **nothing delivered** — no text and no completed tool call | No — nothing reached the transcript | **Auto-restore** | Optimistic message removed |
| Stream completed normally (including a legitimately empty answer) | Yes | Cleared, as today | User message stays |

**Auto-restore is gated on what reached the transcript, not on byte timing**
(item 2, Codex R1 fold — see §12). The predicate is
`shouldRestoreComposer({ text, completedToolCalls })`, fed by `arrivedFrom(state)`
in `lib/agent-stream.ts`, and it is applied to **both** failure paths — the
`error` frame at the end of the read loop and the transport drop in the `catch` —
so the two cannot diverge.

**The `streamStarted` flag is gone.** It was set at the first `reader.read()`
chunk before parsing, and it was correct for chunk 4's scope, where every failure
that could reach the predicate was a non-`ok` response and so "bytes arrived" and
"content arrived" could not disagree. Item 2 makes them disagree: a stream can
open, emit `message_start`, and die before any text or completed tool block.
Under the byte rule that committed an assistant turn whose entire content was the
"This response was interrupted" line and left the composer empty — this
document's own stranding class. The flag is also strictly implied by the new
predicate (no bytes read ⇒ `newStreamState()` ⇒ empty text, no tool calls), so
keeping it would be a second source of truth for one question.

**Codex R4's tool-only-stream reason still binds, and is why the predicate counts
completed tool calls rather than testing `text === ''` alone.** A tool-only turn
carries `content_block_start` / `input_json_delta` and no text at all; it *is*
delivered and must not be restored. An in-flight tool block that never reached
`content_block_stop` counts as **not** delivered — it never becomes a completed
call, and `finalizeTurn` discards even completed calls on a failed turn, so
nothing from it survives.

**The empty-turn guard:** the `error`-frame branch additionally requires
`streamState.failed` before restoring, because a legitimately empty **successful**
turn satisfies the same "nothing delivered" predicate and must fall through to
`finalizeTurn` rather than refilling the composer.

#### 5.2a.5 Recall: edit and resend from the transcript

**Graham's call, 2026-08-14**, choosing the conversational-chat pattern over a
composer history recall.

> **Spec:** each user message in the transcript carries an **edit** affordance.
> Activating it loads that message's text into the composer for editing. The
> Send control then behaves exactly as it does for any typed message.

- **Resend is never implicit.** Editing loads the composer and stops. The user
  presses Send. This is the same no-auto-retry rule as everywhere else in §5.2.
- **The prior turn is not mutated or truncated.** Editing loads text; it does not
  rewrite history or delete the response that followed. A resend appends a new
  turn. *(This is about what **editing** does. It is not a claim that every turn
  is canonical context — a `failed` turn is excluded from API history per
  §5.2a.2b. Codex R1 low on #137 read these two together and was right to: the
  original wording implied a failed turn stayed canonical.)* *(Deliberately narrower than ChatGPT/Claude, which fork the conversation
  — forking implies a branch model the transcript does not have. Out of scope,
  §8.)*
- This is what serves Graham's success-case need: the transcript already
  *displays* the sent text, so what was missing was the ability to pull it back
  and adjust it.

#### 5.2a.6 Invariant 5, restated

v7's invariant 5 read: *"No user message is lost on a pre-stream failure, and no
message is ever silently re-sent."* The pre-stream qualifier is now too weak —
the cache makes the stronger claim enforceable.

> **Invariant 5 (v9): No user message is lost on ANY failure, and no message is
> ever silently re-sent.** Mechanism: `lib/prompt-cache.ts` writes on send
> (§5.2a.3); auto-restore covers the unambiguous case (§5.2a.4); edit-and-resend
> covers the rest (§5.2a.5). Every path to resending requires a user action.

Per §0's own rule, the mechanism is named because the prose alone is what turned
invariants 2, 3 and 5 into findings the first time.
*(A stale §5.1 bullet stood here through v8 and was left stranded under §5.2a by
v9's insertion — Codex R1 low on #137. It claimed the clear action "resets
`rememberKey`, matching the existing handler". **Both halves were false.** The
handler removes both store entries and does **not** touch `rememberKey`
(`page.tsx:5398`), and since #133 `rememberKey` defaults to checked, so
"resetting" it has no defined meaning. Corrected and returned to §5.1, where it
belongs.)*

**State 5 panel** — the deliverable:

```
  AI Show Designer needs a Claude API key

  Free try-it mode isn't set up on this server, so you'll need to
  use your own Anthropic key. It's stored in this browser only — we
  pass it straight to Anthropic and never save it.

    1. Go to console.anthropic.com/settings/keys  ↗
    2. Create a key (starts with sk-ant-)
    3. Paste it below

    [ sk-ant-...                        ] [x] Remember

  Everything else in ShowRunr works without this.
```

Requirements:

- The key field is **rendered expanded**, not behind a link. Extend the
  `page.tsx:5331` condition to include state 5.
- **`canSend` must be false** in states 2, 5 and 6 with no BYOA key. Restate
  `page.tsx:5298` in terms of the probe rather than `tryitExhausted`:
  `canSend = !streaming && !hasPendingTools && (!!apiKey || probeSaysAvailable)`.
  This is the fix for the infinite-retry dead end.
- The composer placeholder in state 5 reads *"Add a key above to start"* — the
  disabled control explains itself.
- The last line ("Everything else works without this") is load-bearing for UAT:
  a tester who lands on a dead AI tab must not conclude the app is broken.
- **The privacy sentence in the block above is the shippable string.** *Fixed in
  v3 — Codex R2 medium.* v2 left the false wording (*"never sent to ShowRunr's
  servers"*) in the sample and put the correction only in this prose, which is
  exactly the arrangement where an implementer copies the block and ships the
  wrong claim. The sample now carries the correct text and this note explains
  why it matters:

  The key **is** sent to our server — `Authorization: Bearer` at
  `page.tsx:5010` — which proxies it to Anthropic (`route.ts:100-102, 132-147`).
  It is never *persisted* server-side. "Never sent to our servers" would be a
  false privacy claim; "we pass it straight to Anthropic and never save it" is
  accurate. **No variant of this sentence ships without checking it against
  those two line references.**

---

## 6. Making the admin state legible

`/admin` already has the field: `label="Claude API Key (Try-It Mode)"`
(`app/admin/page.tsx:279-286`), status row at `:189`, backed by
`GET/PUT /api/admin/settings` with the allowlist at `route.ts:52`.
**Mechanism EXISTS.** Three gaps:

1. **Source is invisible.** `getAllAdminConfig` (`lib/admin-config.ts:56-68`)
   returns `{ configured, masked }` — you cannot tell whether a configured key
   came from the store or from `CLAUDE_TRYIT_KEY`. Add `source: 'store' | 'env' |
   'none' | 'error'`, **derived from `readAdminConfig` (§4.1)** rather than
   computed separately.
   *(v11.1: the discriminant is `'store'`, not `'redis'` — it names a role, not a
   vendor, so it survives the backend change specified in
   `design-single-backend.md` §3.2. **That document also rules `/admin` DELETED**
   — this display moves to the flag-gated platform section of
   `/dashboard/settings`. The gap and its fix are unchanged; only the surface
   that renders it moves.)* Without it, §1's three cases stay indistinguishable from
   the UI, which is exactly the hole this whole document exists to close — and
   the `'error'` member is what §4.1 makes expressible for the first time.

   **This is load-bearing for §4.1's env-fallback rule, not cosmetic** (Codex R3
   answer). A Redis outage with a working `CLAUDE_TRYIT_KEY` resolves to
   `ok`/`env`, which is right for the *user* — try-it works, so say so — but it
   means the outage is invisible to everyone unless `/admin` reports it
   independently. So gap 1 (`source: 'env'`) and gap 2 (the `isKvConnected()`
   banner) are a **pair**: shipping the fallback without both would trade a
   user-facing lie for an operator-facing one. Test 6b asserts the user side;
   test 15 asserts the admin side of the same outage.
2. **Redis-down reads as key-missing.** `getAdminConfig` swallows Redis errors
   and falls through to env (`:35-37`), so a Redis outage with no env var renders
   as a clean "not configured". Meanwhile `setAdminConfig` **throws**
   (`:46-51`) and the PUT 503s — so the operator sees "not configured", tries to
   fix it, and the save fails. `isKvConnected()` (`:81-90`) already exists and is
   already surfaced; the admin page must show a distinct **"Key store
   unreachable — cannot read or save"** banner and disable the save button rather
   than letting the operator run into a 503.
3. **No break-glass.** `CLAUDE_TRYIT_KEY` is a supported fallback in code but is
   not set in production and is documented nowhere. It should be documented as
   the recovery path when Redis is unavailable — note the `__DISABLED__`
   sentinel (`:3, :50`) suppresses it, so an operator who once cleared the field
   in the UI must clear that Redis key before the env var takes effect. That
   interaction is a trap and belongs in the doc.

---

## 7. The venue-NAT problem

Try-it quota is keyed on `x-forwarded-for` (`route.ts:18-20`). **Every tester
behind one router shares one 10-message allowance.** A band at a rehearsal
space, or Graham and a tester on the same home wifi, will exhaust it between
them and see "Free messages used up" without having sent ten messages
individually.

Not fixed here — per-account quota needs an authenticated identity on a route
that is deliberately anonymous.

**Decided in v2** (Codex R1: *"Raise UAT quota if try-it is enabled; otherwise
the per-network quota will create false bug reports"*):

- **Raise `TRYIT_QUOTA`** (`route.ts:12`) for the UAT window — conditional on
  try-it actually being configured, since the constant is inert otherwise.
  **Set to 50** for the UAT window (Codex R2: *"use 50 for UAT"*). One-constant
  change; spend bounded by `TRYIT_MAX_TOKENS = 2048` per message. Everything that
  reads the quota — probe response, arithmetic, tests — derives from the constant
  (§4), so this is genuinely a one-line change.
- **Say it plainly** in the exhausted copy: *"Free messages are shared across
  everyone on your network."* Without this line, two testers in one room file two
  bug reports about a quota neither of them spent.

Both, and the per-account model stays backlog rather than being pretended at.

---

## 8. Explicitly not built

- **Per-user server-side BYOA.** `user_secrets` (`001_initial_schema.sql:49-55`)
  has RLS insert/update policies, no SELECT policy, and **no application code
  whatsoever**. It should either be wired up in a later pass or dropped in a
  migration; leaving a key-shaped table unused invites someone to assume keys are
  being stored. Backlog item, not this build.
- Changing the model or token caps (`route.ts:8-11`).
- Any change to try-it quota accounting beyond §7's constant.
- ~~Per-owner BYOA for chart conversion~~ — **PROMOTED TO §13 AT v10. No longer
  out of scope.** This bullet said *"three AI surfaces fail three different ways.
  Unifying them is worth doing and is not in this scope; flagged so it isn't
  forgotten."* It was not forgotten, and on 2026-08-21 it became a production
  defect. See §13.

  *Two citation corrections made on promotion, recorded because this doc's rule
  is that a restated citation is still a quote from memory:* the convert route's
  key read is at **`:104`**, not `:102` (`:102` is the comment above it), and its
  degrade is at `:105`. The parse route's `503` at `:48-51` still resolves.

---

## 9. Tests

New `tests/agent-capabilities.test.ts`:

1. `unconfigured` when `readAdminConfig` returns `{ status: 'none' }` — and
   **the quota store is never touched** (assert on the mock).
2. `available` with remaining reflecting an existing count.
3. `exhausted` at `count ≥ TRYIT_QUOTA` — **read from the constant**, so raising
   it to 50 (§7) does not silently invalidate the test.
4. Probe response contains no substring of the key, under any state.
5. Peek does not increment: probe twice, count unchanged.
6. Redis unreachable → in-memory fallback path returns a usable answer, not a 500.

**§4.1 status-aware read (new in v3):**

6a. Redis unreachable **and** no `CLAUDE_TRYIT_KEY` ⇒ `readAdminConfig` returns
    `{ status: 'error' }` and the probe reports `tryit: 'error'` — **not**
    `unconfigured`. This is the regression that v2's spec could not have passed.
6b. Redis unreachable **but** `CLAUDE_TRYIT_KEY` set ⇒ `{ status: 'ok', source:
    'env' }`, probe reports `available`. A store outage with a working fallback
    is not an error.
6c. `__DISABLED__` sentinel in Redis ⇒ `{ status: 'none' }`, not `ok` — the env
    var stays suppressed, matching `getAdminConfig`'s existing behavior
    (`lib/admin-config.ts:32`).
6d. `quota` in the response equals `TRYIT_QUOTA`; no literal appears in the
    assertion.

New cases in a client test (jsdom + RTL, per the existing harness pattern in
`tests/setlist-bpm.test.tsx`):

7. `unconfigured` and `error` are returned as **distinct values** (§5), not
   collapsed at the API layer.

**Shared-state regression (v2, the point of the §4 extraction):**

8. With Redis unavailable, a probe followed by a send observes **the same**
   fallback counter — remaining decrements by exactly 1, not 0 and not 2. This
   test fails if either route re-declares its own `fallbackQuota`.

New cases in a client test (jsdom + RTL, per the existing harness pattern in
`tests/setlist-bpm.test.tsx`):

9. State 5 renders the instructional panel and an **enabled, visible** key input.
10. State 5 leaves the send control **disabled**; typing does not enable it.
11. Entering a key in state 5 enables send and suppresses the panel.
12. State 3 renders the remaining-count line on first paint with no send.
13. **State 7 (§5.1):** with a saved key, an `Invalid API key` response renders a
    `Clear saved key` action; clearing it re-probes and, when try-it is
    available, lands in state 3 with send enabled.

**§5.2 message preservation (new in v4) — Codex R3 high:**

13a. An invalid-key failure **restores the message text to the composer** and
     removes the optimistic user message from the transcript. Assert on the
     composer's value, not on the absence of an error — the v3 spec would have
     passed an error-rendering assertion while still losing the text.
13b. The same holds for a **non-401 pre-stream failure** (network throw, 500):
     restored composer, no stranded transcript entry. This is the general rule
     of §5.2, and the reason the predicate is "no bytes streamed" rather than
     "status 401".
13c. A failure **after** partial assistant text is **not** restored — the
     message stays in the transcript and the composer stays empty. Guards
     against a fix that reads "always restore" and quietly resurrects text the
     user already spent tokens on.
13c-i. **A failure after a TOOL-ONLY stream is not restored either** — Codex R4
     medium, still binding. Feed `content_block_start` (`type: 'tool_use'`) and
     `input_json_delta` events through `content_block_stop`, **no `text_delta`**,
     then fail. The assistant text is `''`, a tool call **completed**, and the
     message must still stay put. This is the test that separates a correct
     `completedToolCalls` count from `text === ''` alone; 13c passes under both.
13c-ii. **REVERSED by item 2 (Codex R1 fold).** A failure after bytes arrive that
     parse to **nothing usable** (garbage SSE, a lone `\n`, or a stream that
     opened and died after `message_start`) **IS restored**, because nothing
     reached the transcript. This deliberately overturns the v9 rule, which
     pinned the old `streamStarted` flag as being set at the read rather than at
     the parse — that flag no longer exists. Committing an assistant turn whose
     only content is the "interrupted" line, with an empty composer, is the
     stranding §5.2a.4 now forbids.
13c-ii-a. **An in-flight tool block does not count as delivered.** Feed
     `content_block_start` (`type: 'tool_use'`) and `input_json_delta` with **no
     `content_block_stop`**, then fail: no completed call, nothing survives
     `finalizeTurn`, so the composer **is** restored. Separates "the model began
     emitting a tool call" from "a tool call reached the transcript".
13c-ii-b. **An empty SUCCESSFUL turn is not restored.** A stream that completes
     normally with no text and no tool calls satisfies the same
     nothing-delivered predicate; only `failed` turns may restore. Pins the
     guard that stops a legitimate empty answer from refilling the composer.
13c-iii. `tryitExhausted` (a non-`ok` response) **is** restored — the stream
     never started. Quota exhaustion is the moment a tester most needs their
     text kept while they go find a key.
13d. Restoring does **not** re-send: after 13a the request mock is called
     exactly once until the user presses Send. This is Codex R2's no-auto-retry
     rule, now asserted rather than asserted-about.

**§5.2a — prompt cache, mid-stream error, edit-and-resend (new in v9):**

All of 13e–13h run in the **`node`** environment against a fake store. That is
the point of the injectable shape (§5.2a.3) — under jsdom in this repo
`sessionStorage` is a bare `{}` and none of these could run at all.

13e. `lib/prompt-cache.ts` round-trips: write a prompt, read it back. Writing
     an 11th prompt evicts the oldest and **retains exactly 10**, most recent
     first. Assert the full array, not just the length — a ring that keeps the
     wrong end passes a length check.
13f. Prompts are **scoped per show**: a prompt written under show A is not
     readable under show B. Pins the key derivation, which is the part a
     plausible-wrong implementation gets wrong by using one global key.
13g. An exact-repeat prompt **de-duplicates** rather than occupying two slots,
     and moves to most-recent. Distinguishes de-dup from "skip the write".
13h. A store that **throws** on `setItem` (Safari private mode, quota exceeded)
     does not break sending. The cache is best-effort; a send must never fail
     because its prompt could not be cached. *This is the §5.2a instance of the
     rule that keeps producing findings here — the failure path must not strand
     the caller.*
13i. **A mid-stream `error` event surfaces an error AND keeps partial content.**
     Feed `content_block_delta` with text, then an `error` event, then end the
     stream. Assert both halves: the error is shown, and the partial assistant
     text is still in the transcript. **This is the test that distinguishes the
     fix from today's behavior** — today the loop ends silently and commits the
     partial text with no error, so an assertion on the text alone passes
     against the unfixed code.
13j. A mid-stream `error` **after text or a completed tool call** does not
     restore the composer and does not remove the transcript entry — that was
     delivered and billed (§5.2a.4 row 2). Guards against a fix that treats every
     error identically. **Qualified by item 2's R1 fold:** the same `error` frame
     with *nothing* delivered takes §5.2a.4 row 3 and **does** restore, so this
     test must feed text (or a completed tool block) before the error rather than
     asserting the rule unconditionally — otherwise it pins behaviour the spec no
     longer asks for.
13k. **Edit-and-resend loads the composer and stops.** Activating edit on a user
     message populates the composer with that text and the request mock is
     **not** called; the prior turn and its response are unchanged. Pins both
     halves of §5.2a.5 — no implicit resend, no history mutation.
13l. **A `failed` turn is excluded from `buildApiMessages`** — Codex R1 medium on
     #137. After a mid-stream error, the next send's request body contains
     neither the partial assistant text nor any `tool_use` block from it, while
     the transcript still displays it. Assert the **full** message array, not
     just "the partial text is absent": a plausible-wrong fix drops the text and
     leaves the `tool_use`, which is the malformed-request case.
13m. **A `failed` turn does not lock the composer.** After a mid-stream error
     that arrives *after* a `content_block_stop` for a tool call, `canSend` is
     true and the composer is not showing "Apply or reject pending changes
     first". Pins §5.2a.2b's discard rule. Without it the fix strands the user
     behind an approve/reject gate for a turn that failed — the exact class this
     document keeps re-learning.

**§4 wrapper — behavioral, not byte-equivalent (Codex R3 answer):**

14. `resolveKeyMode` preserves the send path's observable behavior: BYOA key
    wins over try-it; a try-it send with quota remaining decrements once; an
    exhausted quota 429s. Assert the outcomes, **not** that the extracted code
    matches `route.ts:100-123` line for line — §4.1 deliberately changes the
    config read inside it.
15. **Admin side of the §6 pair:** with the store unreachable and
    `CLAUDE_TRYIT_KEY` set, the probe reports `available` (test 6b) **while**
    `/admin` reports the store unreachable and disables save. Both at once, in
    one test, because the risk is that only one of them ships.

**§13 — one resolver, three surfaces (new in v10):**

16. **A BYOA key on `/api/charts/roadmap/parse` is used, and the config store is
    never consulted** — `expect(redis.getCalls).toBe(0)`, the same assertion that
    guards the escape hatch on `agent/chat` (`tests/agent-key.test.ts`, and see
    `agent-key.ts:189-198`). Without this the route can "support BYOA" while
    still stalling on the store during the outage BYOA exists to survive.

    *v11 note: the assertion is named for Redis because that is what the store is
    today. It pins a property — **BYOA resolves without external I/O** — not a
    vendor. `docs/design-single-backend.md` must keep the property true after the
    store changes, and rename the assertion with it.*
17. **Unconfigured parse returns the actionable copy, and `unconfigured` stays
    distinct from `error`.** Assert both: the string is not
    `"Parser is not configured"`, **and** a store-unreachable failure is
    reported differently from a store-reachable-nothing-set one. A fix that only
    rewrites the copy passes the first half and rebuilds §4.1's ambiguity.
18. **`convert` still DEGRADES when no key is available, carrying the distinct `no_key` reason** (amended v10.1) after being moved onto
    `resolveKeyMode`. *This is the test that stops "unify" from flattening §13.5* —
    the plausible-wrong refactor makes all three surfaces fail identically, and
    it would pass every other test here.
19. **One `fallbackQuota` across all three routes.** With Redis down, a probe,
    then a chat send, then a parse observe **the same** counter — decrementing by
    exactly the number of consuming calls. Extends test 8 to the two new callers;
    fails if either re-declares its own map.
20. **Neither chart route resolves `claude_tryit_key` directly.** A source-level
    assertion scoped to **exactly two files** — `app/api/charts/convert/route.ts`
    and `app/api/charts/roadmap/parse/route.ts` — that neither calls
    `getAdminConfig('claude_tryit_key')`. Crude, and it is the only thing that
    catches the regression: every behavioural test above passes against a route
    that resolves correctly *today* and drifts tomorrow. Same wiring-guard
    technique used for `withStableIds` in #147.

    > **★ Scoped at v10.1 — Codex R1 Medium, and v10's version would have failed
    > on its first run.** v10 asserted "no file under `app/api/`", but
    > `app/api/admin/backfill-chart-overlays/route.ts:158` calls that key too.
    > **§4.1 listed it as one of four callers a version ago and I did not check
    > my own document.** A test that fails immediately is the good outcome here;
    > the bad one is an implementer "fixing" it by dragging a fourth surface into
    > this build.
    >
    > **Backfill is deliberately excluded, and the reason is not convenience.**
    > It is an **operator maintenance job behind admin auth, not a user-facing AI
    > surface** — it has no end user, so there is no BYOA key to offer it and no
    > quota that would mean anything. It is correct for it to use the platform
    > key directly. Recorded so the exclusion reads as a decision rather than an
    > oversight, which is exactly the ambiguity that produced this finding.

**§13.4.2 — client key delivery (new at v10.1, Codex R1 High):**

25. **`RoadmapBuilder` sends `Authorization: Bearer` when a key is stored, and
    omits the header entirely when one is not.** Assert both halves. The
    omit-when-absent case is load-bearing: `resolveKeyMode` treats *any* truthy
    `clientKey` as BYOA and returns before consulting try-it, so sending an
    empty string would route every keyless user down the BYOA branch and 401
    them against try-it that works.
26. **The same for `lib/chart-upload`**, asserted separately rather than by
    analogy. These are two independent call sites and #140 is the recorded
    instance of one call site being fixed while its twin was missed.

**Tests 21–24 (settings overlay) REMOVED at v11** along with §14; their text is
at `a624650`. They are **carried forward as `design-single-backend.md` §9 chunk
4's test requirement** (created `894c25c`), which names them but does not
reproduce their text — the originals remain the reference.
They are not cancelled — they
pin the overlay's data-loss property and the no-duplicate-entry requirement, and
they must be written against whatever storage that document settles on.

Target for **this** document: **~36 new tests** (v3 said ~13; 13a–13d, 14, 15 in
v4; 13c-i/ii/iii in v5; 13e–13m in v9; 16–20, 25, 26 in v10/v10.1 — tests 21–24
removed with §14 at v11). **Split across work items — see §5.2a.0 and the scope
split above**, so no single PR carries all of them.
Delta reported on the build PR — measured on both refs immediately before the
PR body is written, never quoted from notes.

---

## 10. Codex R1 — disposition

No blockers. All findings accepted:

| Finding | Disposition |
|---|---|
| **High** — extract `lib/agent-key.ts`, don't duplicate resolution | **Accepted**, and promoted from open question to decision (§4). The module-local `fallbackQuota` argument is the decisive one; test 8 pins it. |
| **Medium** — stale BYOA key masks working try-it | **Accepted.** New §5.1 + state 7 + test 13. This was a genuine miss in v1. |
| **Medium** — keep probe `error` distinct from `unconfigured` | **Accepted** (§5). User-facing copy converges; the data does not. |
| Raise UAT quota | **Accepted** (§7), number still open. |
| Don't hide the AI tab | **Accepted** — spec unchanged. |
| `source: redis\|env\|none` behind admin auth is fine | Confirmed (§6). |

## 10a. Codex R2 — disposition

| Finding | Disposition |
|---|---|
| **High** — `error` vs `unconfigured` unsatisfiable via `getAdminConfig` | **Accepted.** You caught a spec that contradicted itself: §5 demanded a distinction the resolution step could not produce, because the helper's `catch` returns `null` identically to "nothing set". New §4.1 adds `readAdminConfig` returning a discriminated status. Tests 6a–6c. |
| **Medium** — quota literal vs the raise to 50 | **Accepted.** Response, arithmetic and tests all derive from `TRYIT_QUOTA`. |
| **Medium** — false privacy sentence still in the copy block | **Accepted.** Fixed in the sample itself, which was the right place — leaving it correct-in-prose-only is how the wrong string ships. |
| Use 50 for UAT | **Accepted** (§7). |
| No auto-retry after clearing a bad key | **Accepted** (§5.1). |

Nothing declined. Note the §4.1 work also supplies §6.1's `source` field,
including an `'error'` member that was not previously expressible — one lookup
now feeds both surfaces, which is what stops them drifting.

## 10b. Codex R3 — disposition

| Finding | Disposition |
|---|---|
| **High** — "no auto-retry" loses the failed message | **Accepted, and it was a real defect in my own claim.** v3 justified explicit retry by saying the composer retains the text; `page.tsx:4998` clears it before the fetch and nothing restores it. I asserted a property of code I had read, without checking it — the same failure mode as this document's own §1. New **§5.2**: restore the text and drop the optimistic transcript entry on any **pre-stream** failure, retry still explicit. Tests 13a–13d. |
| **Low** — §4 still names `getAdminConfig` | **Accepted.** That bullet was the one place an implementer could rebuild the exact ambiguity §4.1 removes. Now `readAdminConfig`, and `resolveKeyMode` propagates `none` vs `error` rather than flattening. |
| Wrapper over `readAdminConfig` is worth it | Confirmed — §4.1 stands. **Q1 closed.** |
| `ok`/`env` during a store outage is right, **if** `/admin` shows KV unreachable separately | Confirmed, and now written as a **coupled requirement** rather than two independent gaps: §6.1 states the pairing, test 15 asserts both halves in one test. **Q2 closed.** |
| Behavioral send-path test, not byte-for-byte equivalence | **Accepted** — test 14 asserts outcomes (BYOA precedence, single decrement, 429 at quota). Byte-equivalence would have frozen the very code §4.1 changes. **Q3 closed.** |

Nothing declined. The high finding is worth naming plainly: this doc exists
because the app reported a state it had not actually checked, and v3's retry
claim was the same bug one level up, in the spec.

## 10c. Codex R4 — disposition

| Finding | Disposition |
|---|---|
| **Medium** — "no bytes streamed" is not pinned for tool-only streams | **Accepted.** You caught the gap between what I meant and what an implementer would write: "no bytes streamed" renders naturally as `assistantText.length === 0`, and a tool-use stream carries `content_block_start`/`input_json_delta` with **no text at all** (`page.tsx:5060-5079`). That turn would have been treated as never-sent and its message restored, after the model had already begun acting. §5.2 now specifies a `streamStarted` flag set at the **first `reader.read()` chunk**, before parsing — so it is also true for a stream that emits only unparseable lines. Tests 13c-i (tool-only), 13c-ii (garbage SSE), 13c-iii (`tryitExhausted` still restores). |

Nothing declined. Note what 13c alone would have done: it passes under both the
correct flag and the broken length check, which is exactly why the finding
matters. **The suite has to distinguish the two implementations, not just the two
outcomes** — same lesson §9's full-array rule teaches on #121.

Unanswered from R4, carried forward as Q1/Q2 below.

## 10d. Codex R5 — disposition

| Finding | Disposition |
|---|---|
| **No findings.** The `streamStarted` flag closes the tool-only stream hole. | Confirmed. |
| Keep the **broader pre-stream restoration** and the **transcript removal** — "that is the right UX contract" | **Ratified.** These were R4 Q1 and Q2, open two rounds. Both are now **settled spec, not proposals**: restoration applies to every pre-stream failure (not just 401), and the undelivered optimistic message is removed rather than left stranded. §5.2 stands as written; tests 13a–13d and 13c-i/ii/iii pin it. |

**This document is design-complete pending R6.** Every finding across five
rounds has been accepted, nothing declined, and the two behavior calls I was
least sure of are now ratified rather than assumed. The remaining §11 questions
are refinements, not blockers — none of them change the shape of the build.

## 10e. Codex R1 on PR #150 (v10) — disposition

**NOGO: 2 High + 2 Medium. All four accepted, nothing declined.**

| Finding | Disposition |
|---|---|
| **High** — §13 claims independence from §14 while deferring its BYOA client half to §14.2, so work item 1 does not fix the reported symptom | **Accepted, and it was the most useful finding of the round.** §13 now includes **§13.4.2 client key delivery** — `RoadmapBuilder` and `chart-upload` read `lib/byoa-key-storage` directly. The confusion was mine and it was conceptual: §14 changes where a key is **entered**, §13.4.2 changes where a key is **read**, and I collapsed the two. Tests 25, 26. |
| **High** — converter cannot both preserve `unconfigured`/`error` and keep `degrade('failed')`; Q6 left open | **Accepted. Q6 CLOSED inside this design**, answered yes: a distinct `no_key` `ConvertReason`. A requirement contradicted by the section implementing it is worse than no requirement — it reads as satisfied. Test 18 amended to assert the reason, not just that a degrade happened. |
| **Medium** — test 20's `app/api/` scope catches `admin/backfill-chart-overlays` | **Accepted; it would have failed on the first run.** Scoped to the two chart routes, with backfill **explicitly excluded and the reason stated** — an operator job behind admin auth has no end user, so no BYOA key and no meaningful quota. **§4.1 listed that caller a version ago and I did not check my own document.** |
| **Medium** — §13's pre-§14 copy still points at a Settings page that does not exist | **Accepted.** Interim copy now names the show page's AI tab — a surface that exists today and, after §13.4.2, genuinely works. It also *explains* the inconsistency Graham reported rather than papering over it. |

**★ The disposition worth reading is the pattern, not the four rows: every
finding is an INTERNAL contradiction.** §13 vs §13.4. §13.4 vs §13.5. Test 20 vs
§4.1's own list. §13.5's copy vs §14's existence. **None required knowledge
outside this file.** §5.2a's "self-sweep after the fold" note prescribes exactly
the pass that would have caught all four, and it was not run on v10 — the doc
grew two large sections in one sitting and I reviewed each against the code
rather than against each other.

**The rule this adds to §0's discipline:** a new section is walked against the
seven invariants **and against every other section it references or is
referenced by**, before the version ships. Cross-references are where a design
lies to itself.

## 11. Questions raised for Codex R6 — ALL DISPOSED (v8)

**Review closed at R6, no R7.** None of these is open against the design; 3 is the
only one that still needs a human call, and it is scoped to chunk 4.

1. **CLOSED by R5** — the broader pre-stream restoration is confirmed as the
   right contract.
2. **CLOSED by R5** — transcript removal on restore is confirmed.
3. **RULED BY GRAHAM 2026-08-14 — see §5.2a. Superseded; the default was NOT
   taken.** He chose neither read-vs-parse: cache the prompt so the question
   stops being load-bearing, plus surface the mid-stream error the client was
   discarding. Option C (terminal error frame from our route) is **withdrawn** —
   §5.2a.1 records the two code facts that invalidated it. **Chunk 4 builds
   §5.2a, not the v8 text below**, which is retained for its reasoning only.

   *Original question, for the record:*
   §5.2 sets `streamStarted` at the read rather than the parse, so a response
   that opens a stream and immediately dies still counts as sent. That is
   deliberately conservative — it errs toward *not* restoring, on the grounds
   that an upstream call which happened may have billed.

   The question was whether the proxy-opens-then-upstream-500 shape is common
   enough to flip it. **It is not answerable from the spec, and it should not be
   guessed at, because there is a third option neither R4 nor R5 considered:**
   `/api/agent/chat` is *our own* route, so a pre-stream upstream failure is a
   state we can signal explicitly rather than infer from byte timing. If the
   route emitted a terminal error frame before any `content_block`, the client
   would not have to guess whether anything was delivered.

   **That is a spec change, not a build detail**, so it is a Graham call at
   chunk 4 — not a Codex question and not mine. Absent a ruling, chunk 4 builds
   §5.2 exactly as written and the conservative branch stands.
4. **ANSWERED by chunk 1 — now a chunk-3 requirement, not an open question.**
   The 401 from `/api/agent/chat` carries `reason: 'unconfigured' | 'error'` as
   of chunk 1 (`f97d79f`), which is precisely the distinction the send path
   needed in order to disagree honestly during a partial outage. So yes, the
   send path is the third surface, and the mechanism already exists: **§5's
   states 2–6 must render different copy for `error` than for `unconfigured`,
   and chunk 3 owns it.** Nothing consumes `reason` before chunk 3, so the field
   is currently inert — which is the shape to watch for, not a gap in the spec.

---

## 13. One key resolver for all three AI surfaces (new in v10)

**Work item 1. Independent of the settings-overlay work — including its client
half (§13.4.2), which v10 wrongly deferred to that work.** This is the
production defect.

### 13.1 What is true today — measured, not recalled

| Surface | Route | How it resolves a key | BYOA? | Failure when unconfigured |
|---|---|---|---|---|
| AI Show Designer | `/api/agent/chat` | **`resolveKeyMode`** (`lib/agent-key.ts:184`) | ✅ | 401 carrying `reason: 'unconfigured' \| 'error'` |
| Chart converter | `/api/charts/convert` | `getAdminConfig('claude_tryit_key')` (`:104`) | ❌ | `degrade('failed')` (`:105`) — silent fall back to manual |
| Roadmap builder | `/api/charts/roadmap/parse` | `getAdminConfig('claude_tryit_key')` (`:48`) | ❌ | `503 "Parser is not configured"` (`:50`) |

Three surfaces, three resolutions, three failure modes — and **only one of them
can accept a user's own key.** That is the whole defect, and §8 named it a
version ago.

**The symptom Graham hit is the exact shape this predicts.** His key worked in
the AI input list and the chart builder returned 503, at the same moment, from
the same browser. The input list works because `resolveKeyMode` takes the BYOA
branch (`agent-key.ts:189-198`); the chart builder 503s because it only ever
consults server-side config, which was unset in production. **Nothing was
broken.** Two routes simply answer a different question.

### 13.2 Why this was missed, and it is not an oversight

§4 argued the resolution must live in one place, and gave a specific reason:
`fallbackQuota` is a module-level `Map`, so two routes with two copies would
count in two different maps and disagree during exactly the outage the fallback
exists for. That argument was applied to the probe and the send path **and
stopped there.** §4.1 even names the four `getAdminConfig` callers and says *"this
design does not touch them."*

So the extraction was correct and its blast radius was underestimated. **The
lesson worth keeping: an argument for centralising a resolver is an argument
about every caller of that resolver, not about the two you happened to be
editing.** Same shape as §12's `resolveAvailability` finding — when you fix one
input to a shared decision, enumerate all of them.

### 13.3 ★ "Degrade to the manual editor" is NOT available — corrected before spec

The obvious fix for the 503 is to copy the converter: degrade instead of
erroring. **It cannot be specified, because the roadmap builder has no manual
mode to degrade into.**

`RoadmapBuilder` sets `view` in exactly two places — `specToView(editChart.spec)`
when re-opening a saved chart (`:74`), and `specToView(data.spec)` after a
successful parse (`:104`). There is **no blank-spec constructor and no
manual-first entry**. A fresh build starts at Compose with `view === null`, and
the only way out of Compose is the AI.

⇒ **The roadmap builder is unusable without a working AI key, by construction.**
That is a bigger statement than the bug report, and it belongs on the record.

**Manual-first roadmap building is a FEATURE, not this fix.** Backlog. It is
called out here so nobody reads §13.4 and wonders why the obvious symmetry with
the converter was not taken.

### 13.4 Spec

1. **Both routes resolve through `resolveKeyMode(clientKey, ip, { consume })`.**
   No route calls `getAdminConfig('claude_tryit_key')` directly. After this,
   `agent/chat`, `charts/convert` and `charts/roadmap/parse` share one resolver,
   one `fallbackQuota`, and one `unconfigured`/`error` distinction.
2. **Both routes accept a BYOA key, AND both clients send one.** *(Rewritten at
   v10.1 — Codex R1 High. v10 deferred the client half to the settings-overlay
   work while also
   claiming §13 was independent and was the production fix. **Two of those three
   could be true at once.** A route that accepts `Authorization` is inert while
   no client sends one: `lib/chart-upload.ts:51` and
   `components/RoadmapBuilder.tsx:91` send `Content-Type` and nothing else.)*

   **§13.4.2 — the client half, and it is four lines, not a project.**
   `RoadmapBuilder` and `chart-upload` import `readKey` from
   `lib/byoa-key-storage` — the module that already exists, is already tested,
   and today has exactly one reader — and send `Authorization: Bearer` when a key
   is present, exactly as `page.tsx` does.

   **This does not depend on the settings-overlay work and must not wait for
   it.** That work changes where a
   key is *entered*; §13.4.2 changes where a key is *read*. Anyone who has ever
   set a key on the show page gets a working chart builder the moment §13 ships.

   **Scope honesty:** a user who has never visited the show page still has no
   key, and no way to get one until §14. §13 is therefore a **complete fix for
   BYOA holders and an honest failure for everyone else** — which is the most
   §13 can be, and is materially more than v10 claimed for it.
3. **The `unconfigured` / `error` distinction propagates on both routes**, per §0
   invariant 2 — **and for the converter that requires a new `ConvertReason`, so
   Q6 is closed here rather than carried (§13.5).** *(Codex R1 High: v10 demanded
   the distinction and simultaneously kept the converter at `degrade('failed')`,
   which erases it. A requirement contradicted by the section that implements it
   is worse than no requirement — it reads as satisfied.)*
4. **Quota applies to try-it on these routes too.** A chart parse on the
   platform key is a billable call and must not be free of the accounting the
   AI tab is subject to. **One call = one unit, no weighting** (Q5, ruled).
   Consumption stays a property of `resolveKeyMode`'s `{ consume }` flag and is
   never open-coded per route, so revisiting 1:1 before public launch is a
   one-function change.

### 13.5 Failure modes stay DIFFERENT on purpose

"Unify" means one resolver, **not** one failure. The three surfaces have
genuinely different right answers, and flattening them would be a regression:

| Surface | Right failure | Why |
|---|---|---|
| Converter | **degrade to manual, carrying a distinct `no_key` reason** | A manual chart path exists and works, so erroring would take away a capability the user has. But `degrade('failed')` says *the conversion failed* when the truth is *there was nothing to convert with* — a failure misreporting its own cause, which is the same defect as the 503. **Q6 closed: add the reason.** |
| Roadmap builder | **honest, actionable error** | No manual path exists (§13.3), so there is nothing to degrade to. Pretending otherwise strands the user in Compose. |
| AI designer | **states 5/6/7**, as today | Already designed. The remedy relocation was removed at v11 and re-spec'd in `design-single-backend.md` §4.3, which does not change these states' conditions, copy or `canSend` behaviour — so §13 ships against them unchanged. |

**The roadmap builder's new copy replaces a message that tells the user about our
infrastructure and offers them nothing:**

> **AI chart generation isn't available.** Add your Anthropic API key in Settings
> to generate charts from a description. *(Settings →)*

The `Settings →` affordance is the overlay specified in
`docs/design-single-backend.md` §4.3. **That copy is the eventual target and
MUST NOT be built from this document** — §13
does not create a Settings page, so shipping this string would point users at a
route that 404s.

**★ THE COPY §13 ACTUALLY SHIPS** *(at v11 this is no longer "interim" — it is
what §13 builds, and it stands until the settings surface exists. Codex R1
Medium — v10 said "the same copy without the link", which still described a
Settings page that does not exist. Copy must name a surface the reader can
actually reach **today**):*

> **AI chart generation isn't available.** If you have an Anthropic API key, add
> it on a show's AI tab — it applies here too. *(Open a show →)*

That is accurate the moment §13.4.2 ships, because the chart routes read the
same stored key the show page writes. It also does something better than
placeholder copy: **it explains the inconsistency Graham reported** — one key,
entered in one odd place, working everywhere — instead of hiding it. The
settings work then replaces the sentence with the Settings link and the oddness
goes away.

Either version beats `"Parser is not configured"`: a sentence whose only possible
reader is an operator, shown to someone who cannot operate anything.

### 13.6 Open questions

- **Q5 — RULED by Graham 2026-08-21: 1:1. One call, one unit.** A chart parse
  and a PDF conversion each consume **one** try-it message, exactly like a chat
  turn, even though a vision call over a whole PDF costs materially more.
  **No weighting, no per-surface cost model.** `TRYIT_QUOTA` stays the single
  constant everything derives from (§4).

  **His reasoning, recorded because it bounds how long this holds:** *"we'll have
  to see how long this survives. For now, 1:1 is fine. I suspect that's not going
  to be the case when we offer this publicly."* So 1:1 is a **UAT-window
  decision**, in the same class as §7 raising the quota to 50 — right for the
  current audience, explicitly expected to be revisited before public launch.

  **The design consequence, so the revisit is cheap:** nothing may hard-code the
  1:1 assumption. Quota consumption stays a property of `resolveKeyMode`'s
  `{ consume: boolean }` and is never open-coded per route. A future weighting
  becomes a change to one function, not an audit of every AI surface — which is
  the same argument §4 makes for one resolver, applied to the thing most likely
  to change next.
- **Q6 — CLOSED at v10.1, answered YES inside this design** (Codex R1 High
  forced it: §13.4.3 cannot require the `unconfigured`/`error` distinction while
  §13.5 keeps the converter at a reason that erases it).

  `convert` degrades identically for "no key" and "the model failed" — both are
  `degrade('failed')` (`:105`, `:117`, `:123`, `:125`). **A missing key becomes
  its own `ConvertReason`**, so the UI can say what actually happened and point
  the user at a key rather than reporting a conversion failure that never
  occurred. Same defect class as the 503, and the same fix.

  **Deliberately NOT a per-`KeyMode` enum.** `unconfigured` and `error` are an
  *operator* distinction; to the user both mean "AI conversion is off right now".
  One new reason, the distinction preserved in logs and in the route's own
  branching per §0 invariant 2, and one user-facing message. Adding two reasons
  would publish an infrastructure distinction to someone who cannot act on it —
  which is §5's converge-the-copy-not-the-data rule.

---

## 14. Key ENTRY / settings overlay — REMOVED AT v11, RE-SPEC'D ELSEWHERE

**Where the original text is: `git show a624650:docs/design-ai-key-availability.md`.**
That commit is the last one containing this section in full. It was not
superseded, cancelled or de-scoped.

**Where it is now: `docs/design-single-backend.md` §4**, created at `894c25c` on
this branch. *(At `d5f8a94` that file did not exist and this block said so;
corrected here as soon as it did. Claiming a file exists before it does is what
Codex R2 caught in the first draft of this block, and the inverse — leaving a
"does not exist" claim standing after it exists — is the same defect.)*

The rulings below are **restated in full here anyway**, so no ruling depends on
git history or on another file. Until the re-spec is reviewed, this heading
remains a tombstone with a forwarding
address, not a redirect.

**What must survive the re-spec** — the rulings, so they are not re-litigated:

1. **The overlay is settled spec**, and the reason is data loss: navigating away
   would destroy the restored composer text, because the prompt cache is
   write-only in production (`page.tsx:47` imports only `rememberPrompt`;
   `readPrompts` has zero callers).
2. **The §5 states 5–7 remedy relocation** — conditions, copy and `canSend`
   behaviour all stand; only the inline key input becomes an affordance.
3. **BYOA extends to every AI surface**, reversed from try-it-only on the
   grounds that one entry surface dissolves the stale-second-input objection.

**Why it was removed (2026-08-24):** it specified `localStorage` — a
per-**browser** key. Graham ruled the same day that ShowRunr is **multi-tenant
SaaS**, where a key must follow the **account**. That makes it a `user_secrets`
question, and `user_secrets` belongs to the single-backend consolidation, not to
key resolution.

**★ The collision that forced the removal, recorded so it is not re-discovered:**
the removed section argued BYOA's reliability value is that `resolveKeyMode`
returns **before touching any store** (`agent-key.ts:189-198`, pinned by
`expect(redis.getCalls).toBe(0)`). Moving BYOA server-side **breaks that
property**. With Redis retired, one Supabase outage would take shows, charts,
auth, try-it **and** BYOA down together. The re-spec must resolve that
explicitly rather than inherit it.

**§13 does not depend on any of this** and does not wait for it.

---

---

## 12. Build deviations (folded back post-merge)

*(§12 is kept last on purpose: it is an append-only log, and §13/§14 were
inserted above it so future rows stay at the end of the file.)*

This doc merged to main **during** the build, by decision on 2026-08-12: the
alternative left `lib/agent-key.ts` and `tests/agent-key.test.ts` on main citing
a path that did not resolve. The accepted cost is that the doc can drift from
what gets built. **This section is the mechanism that repays it** — every chunk
that deviates from the spec above appends here in the same PR as the deviation,
so main's copy of the design is never silently wrong.

| Chunk | Deviation | Why |
|---|---|---|
| 1 | Two additions beyond the spec, neither contradicting it: `REDIS_URL` absent and `REDIS_URL=''` both resolve to `none` (matching `getRedis`'s own `if (!url)` truthiness check) rather than being reported as an outage. | A missing store is a deployment choice, not an outage; reporting `error` would send an operator hunting a store that was never meant to exist. |
| 1 | **§4's `peekTryitQuota` / `consumeTryitQuota` sibling pair does not exist.** Chunk 1 built one private `quota(ip, consume)` in `lib/agent-key.ts` instead. Behaviorally identical; the names in §4 resolve to nothing in code. | Found while writing chunk 2, whose route comment had already begun citing `peekTryitQuota` as though it existed. One implementation with two modes cannot drift from itself, which is the same argument §4 makes for one `fallbackQuota` — so the deviation is an improvement, but §4's names had to stop being load-bearing. |
| 2 | **`checkRateLimit` gains an optional per-call `max`; the probe uses `PROBE_RATE_LIMIT_MAX = 60`, not the shared default of 5.** Existing callers are untouched (the parameter defaults). | §4 said reuse `checkRateLimit(ip, 'agent-capabilities')` without noting its ceiling was tuned for five *authenticated, hand-invoked* admin routes. The probe is unauthenticated and fires on every AI-tab mount. At 5/min, a sixth reload inside a minute returns a 429 — and a 429 is not one of §4's four states, so the client would have to render it as one, almost certainly the store-unreachable state. That converts "you reloaded quickly" into a reported outage: the same misreporting defect §1 exists to remove, reintroduced by the mitigation. |
| 2 | The 429 body carries `rateLimited: true` and deliberately **omits `tryit`**. | So chunk 3 can tell "ask again shortly" from the four measured states instead of guessing. Raising the ceiling makes the collision improbable; omitting the field makes misreporting it impossible rather than merely unlikely. |
| 2 | New `capabilitiesFrom(KeyMode)` returns `null` for `byoa`, and the route **500s** on it. | `byoa` is unreachable from a route that passes no client key, but TypeScript still demands the branch. The tempting shape is a default case reporting some state — which would publish a try-it status nobody measured (§0 invariant 2). Failing loud is the honest option, and it is pinned by a test. |
| 4 | **§9's client tests 13, 13a–13d and 13c-i/ii/iii are asserted at the `lib/` level, not against `AgentChat`.** `shouldRestoreComposer`, `rollbackOptimisticSend` and `isSavedKeyRejected` are tested directly; the wiring that calls them inside `sendMessage` is not covered. | `AgentChat` is declared inside a 6700-line client component that needs `useParams` + Supabase + a rendered page, and this repo's jsdom `sessionStorage` is a bare `{}` (the harness gap that left BYOA uncovered before #133). Extracting the rules is what makes the *decisions* provable at all; the residual — that a wrong call site would pass — is declared in the PR rather than papered over, exactly as chunk 3 declared it for `canSendMessage`. |
| 4 | **Issue #136 folded in: the probe's status→`FetchedProbe` mapping moved out of the page effect into `probeCapabilities(fetchFn)`.** Not requested by the spec. | Codex R2 on chunk 3 logged the gap and Graham left the call to me. The three lines that *produce* `'rateLimited'` had no reachable test, so a wrong branch there passed the whole suite while reintroducing the state-2 dead end chunk 3 exists to fix. Injecting `fetchFn` mirrors the injectable-store shape §5.2a.3 already mandates for the same reason. |
| 4 | **A new predicate `isSavedKeyRejected({status, hasKey})` carries §5.1's detection rule**, rather than matching on the `Invalid API key` copy. | The route has two 401s; the try-it-unavailable one cannot fire while a key is held, because the client omits `Authorization` only when `apiKey` is empty. Naming the predicate puts that argument somewhere a test can hold it, and keeps §5.1 from depending on an error string that is copy. |
| 4 | **Clearing the key also resets the probe to `'loading'`**, beyond §5.1's "clearing re-runs the probe". | Without it the panel renders the *previous* probe's verdict — plausibly `error` from before the key was pasted — as though it described the re-probe now in flight. Same class as everything else in this document: a stale value presented as a current measurement. |
| 4 | **`keyRejected` is cleared at the top of every send, alongside `setError('')`.** | Found in my own sweep, not by review: the flag describes one response. Left standing it renders "That key was rejected — clear it" under the *next* failure, so a 502 or an offline send would talk a tester into deleting a working credential. |
| 4 | **The prompt cache is write-only in this chunk** — nothing reads it in product code until §5.2a.5 (item 3, deferred past UAT). | Anticipated by §5.2a.0 ("item 3 reads the cache item 1 builds, so it must not land first"). Recorded so the dead-looking `readPrompts` export is not mistaken for an oversight. Its value today is that no text is lost; its interface arrives with item 3. |
| 4 | **Emptying the key field routes into `handleClearKey`, and clearing resets `tryitRemaining` / `tryitExhausted` as well as the probe** — Codex R1 *and* R2 medium on #140, which were the same defect at two call sites. R1 fixed the button; R2 found that deleting the key by hand in the input reached none of it. There is now one function, and the explicit `removeItem` calls were deleted because the persist effect already clears both stores on an empty key (`tests/byoa-key-storage.test.ts` pins it) — a second storage path is the same drift risk. | Resetting the probe was not enough. Send-derived quota state deliberately OUTRANKS the probe in `resolveAvailability` (so spending the last free message updates the panel without a remount), which means a stale exhausted-or-zero from an earlier send silently overrode the fresh probe and landed the user in state 4 with the composer disabled — the precise opposite of §5.1's promise that clearing drops you into state 3. The precedence rule is right and stays; what had to go was the older measurement. Instances three and four of this document's own class inside one chunk — and the two I did not find myself. The lesson worth keeping is not "reset the quota state": it is that **when you reset one input to a resolver, you enumerate every input it has and ask which are older than the event you are reacting to**, and then you check every path that can trigger that event, not the one you happen to be editing. |
| item 2 | **The SSE parse loop's event→state rules moved to `lib/agent-stream.ts`, and `buildApiMessages`/`hasPendingTools` to `lib/agent-history.ts`.** Not requested by the spec. | §9's tests 13i, 13j, 13l and 13m are all written against a loop declared inside a 6700-line client component, so as written **none of them could be run at all**. 13l in particular demands asserting the *full* message array, which requires reaching the function. Same move chunk 4 made for the restore predicate and #136 made for the probe: the rules go where a test can hold them, and the page keeps the read loop and the `setState` calls. |
| item 2 | **A mid-stream transport drop is treated as a failed turn too**, not only an Anthropic `error` frame. §5.2a.2 specifies the frame. | Found by sweeping the class rather than the instance. A connection that dies mid-stream emits no frame — there is nothing alive to send one — yet it strands the caller identically: partial text already live in the transcript replays as canonical context, and a tool call that completed before the drop sits `pending` and locks the composer behind approve/reject. Same disposal for both, so the two paths cannot drift. |
| item 2 | **The failed turn carries a visible line in the transcript**: "This response was interrupted. It won't be sent back to Claude as context — ask again to continue." §5.2a.2 says "visibly marked" without saying what the mark says. | The second clause is not decoration. The turn genuinely is excluded from API history, so a user who re-asks will find Claude has no memory of it — telling them why is the difference between a quirk and a bug report. |
| item 2 | **The `error` event shape was verified against Anthropic's streaming documentation** (`event: error` / `{"type":"error","error":{"type":...,"message":...}}`), not inferred. | This project has one recorded instance of me inventing a third-party API and having it survive a review round. The shape §5.2a.2 specified turned out to be correct; that was worth confirming rather than assuming. |
| item 2 | **An unrecognised event type stays non-fatal**, and has its own test. | The defect being fixed *is* an unhandled event falling through silently, so the tempting overcorrection is to treat anything unknown as a failure. Anthropic's versioning policy says new event types will appear and clients must tolerate them — a stream carrying a new block type must not render as an interrupted turn. |
| item 2 (R1 fold) | **§5.2a.4's restore rule now keys on what reached the transcript, not on byte timing.** `shouldRestoreComposer(streamStarted)` becomes `shouldRestoreComposer({ text, completedToolCalls })`, fed by a new `arrivedFrom(state)` in `lib/agent-stream.ts`; the `streamStarted` flag is deleted. **This REVERSES a chunk-4 behaviour that a prior round pinned** (old test 13c-ii: "a started stream that produced only unparseable bytes is not restored"). | Chunk 4's byte rule was correct for chunk 4's scope — every failure that could reach it was a non-`ok` response, so "bytes arrived" and "content arrived" could not disagree. Item 2 makes them disagree: a stream can open, emit `message_start`, and die before any text or completed tool call. The byte rule then committed an assistant turn whose entire content was the red "interrupted" line and left the composer empty, stranding the user in exactly this document's recurring class. Codex R1 on item 2 raised it as a product preference and explicitly declined to block; **Graham ruled to fold it.** Codex R4's medium is preserved by counting completed tool calls, which is the distinction the bare boolean could not express: a tool-only turn that completed a call is delivered, a stream that produced nothing is not. An in-flight tool block counts as NOT delivered — it never completes, and `finalizeTurn` discards even completed calls on a failed turn, so nothing from it survives. Applied to BOTH failure paths (the `error` frame and the transport drop) so they cannot diverge; the `error`-frame branch is additionally guarded on `failed`, because a legitimately empty SUCCESSFUL turn satisfies the same predicate and must not refill the composer. |
| item 2 (R1 fold) | **§5.2a.3's prompt cache ships WRITE-ONLY for the UAT window, and no reasoning may treat it as a live safety net.** `readPrompts` is exported and tested but has zero production callers; `page.tsx` imports only `rememberPrompt`. Its consumer is item 3 (edit-and-resend), deferred past UAT per §5.2a.0. | Recorded because the argument for *not* restoring the composer rested on the cache being able to hand the text back, and it cannot yet. The text is still visible in the transcript, so this was never data loss — but "the cache protects the user" is false until item 3 lands, and a design that quietly depends on an unbuilt consumer is how a stated justification outlives the mechanism behind it. |
