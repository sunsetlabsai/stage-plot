# Design — AI key availability: capability probe + real empty state

Status: **IN BUILD (chunks 1–2 shipped; chunk 3 = PR #135). §5.2 REOPENED at v9 by
Graham's Q3 ruling — chunk 4 must not be built to the v8 text.**
Version: **v9.0** (v1 = pre-Codex, v2 = R1, v3 = R2, v4 = R3, v5 = R4, v6 = R5, v7 = invariant
registry, v8 = review-closure bookkeeping, v9 = Q3 ruled: prompt cache + mid-stream error)
Scope: AI tab (`AgentChat`), `/api/agent/chat`, `/admin` key status

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
  | { status: 'ok';    value: string; source: 'redis' | 'env' }
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

**Spec — restore on pre-stream failure** *(v4–v8; superseded by §5.2a in v9,
retained because the reasoning below still holds and v9 builds on it)*:

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
   No bytes flow, `streamStarted` stays `false`, the message restores. **The
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
| Stream opened, then `error` event mid-flight | Yes, partially — billed | Not auto-restored | Partial content **kept**, error shown under it (§5.2a.2) |
| Stream completed normally | Yes | Cleared, as today | User message stays |

Auto-restore remains gated on `!streamStarted`, set at the **first
`reader.read()` chunk** before parsing (`page.tsx:5103`) — unchanged from v5, and
still correct for the tool-only-stream reason Codex R4 gave. What changed is that
this flag is no longer the last line of defence for the user's words.

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
  turn. *(Deliberately narrower than ChatGPT/Claude, which fork the conversation
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
- The clear action removes both `localStorage` and `sessionStorage` entries and
  resets `rememberKey`, matching the existing handler.

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
   came from Redis or from `CLAUDE_TRYIT_KEY`. Add `source: 'redis' | 'env' |
   'none' | 'error'`, **derived from `readAdminConfig` (§4.1)** rather than
   computed separately. Without it, §1's three cases stay indistinguishable from
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
- Per-owner BYOA for chart conversion — still the TODO at
  `app/api/charts/convert/route.ts:102`. Note that route **silently degrades**
  when no key is present (`:105`, `return degrade('failed')`), and
  `/api/charts/roadmap/parse` returns a `503 "Parser is not configured"`
  (`:48-51`). So three AI surfaces fail three different ways. Unifying them is
  worth doing and is **not** in this scope; flagged so it isn't forgotten.

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
     medium. Feed `content_block_start` (`type: 'tool_use'`) and
     `input_json_delta` events, **no `text_delta`**, then fail. `assistantText`
     is `''` and the message must still stay put. This is the test that
     separates a correct `streamStarted` flag from
     `assistantText.length === 0`; 13c alone passes under both.
13c-ii. A failure after bytes arrive that parse to **nothing usable** (garbage
     SSE, a lone `\n`) is also not restored. Pins that the flag is set at the
     read, not at the parse.
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
13j. A mid-stream `error` **does not** restore the composer and **does not**
     remove the transcript entry — it was delivered and billed (§5.2a.4 row 2).
     Guards against a fix that treats every error identically.
13k. **Edit-and-resend loads the composer and stops.** Activating edit on a user
     message populates the composer with that text and the request mock is
     **not** called; the prior turn and its response are unchanged. Pins both
     halves of §5.2a.5 — no implicit resend, no history mutation.

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

Target: **~29 new tests** (v3 said ~13; 13a–13d, 14, 15 in v4; 13c-i/ii/iii in
v5; 13e–13k in v9).
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

## 12. Build deviations (folded back post-merge)

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
