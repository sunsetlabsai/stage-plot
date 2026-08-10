# Design — AI key availability: capability probe + real empty state

Status: **DESIGN — Codex R1 folded (no blockers), awaiting R2**
Version: **v2.0** (v1.0 = pre-Codex)
Scope: AI tab (`AgentChat`), `/api/agent/chat`, `/admin` key status

**v2 changelog** — Codex R1 returned **no blockers**; three refinements folded:

| Change | Source |
|---|---|
| §4 — `lib/agent-key.ts` extraction is now **decided**, not an open question. The shared **fallback quota state** moves with it. | Codex R1 high |
| §5.1 NEW — a stale/invalid saved BYOA key currently **masks working try-it**. Adds a prominent Clear-key action + re-probe. | Codex R1 medium |
| §4 / §6 — probe `error` stays **distinct from `unconfigured`** internally, even though user-facing copy converges. | Codex R1 medium |
| §7 — raise the quota for UAT (was an open question) | Codex R1 answer |
| §5 — do **not** hide the AI tab; show the honest empty state | Codex R1 answer |
| §6 — exposing `source` behind admin auth confirmed fine | Codex R1 answer |

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
  "tryit": "available" | "exhausted" | "unconfigured",
  "tryitRemaining": 7 | 0 | null,   // null when unconfigured
  "quota": 10
}
```

**Resolution** (mirrors `POST /api/agent/chat:90-123` exactly, minus the send):

1. `getAdminConfig('claude_tryit_key')` → falsy ⇒ `unconfigured`, remaining
   `null`. Return immediately; do not touch the quota store.
2. Otherwise **peek** the quota: `GET quota:<ip>` — a plain read, no `INCR`, no
   `EXPIRE`. `remaining = max(0, 10 - count)`.
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
- the `getAdminConfig('claude_tryit_key')` lookup
- the BYOA-wins precedence currently at `route.ts:100-123`

`app/api/agent/chat/route.ts` and the new capabilities route both call it and
neither owns quota state. This is a refactor of a working route; it is justified
by the drift it forecloses, not by tidiness.

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
- The clear action removes both `localStorage` and `sessionStorage` entries and
  resets `rememberKey`, matching the existing handler.

**State 5 panel** — the deliverable:

```
  AI Show Designer needs a Claude API key

  Free try-it mode isn't set up on this server, so you'll need to
  use your own Anthropic key. It's stored in this browser only and
  is never sent to ShowRunr's servers.

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
- The claim *"stored in this browser only and never sent to ShowRunr's servers"*
  is **false as written** and must not ship in that form. The key **is** sent to
  our server — `Authorization: Bearer` at `page.tsx:5010` — which proxies it to
  Anthropic (`route.ts:100-102, 132-147`). It is never *persisted* server-side.
  Correct copy: *"stored in this browser only — we pass it straight to Anthropic
  and never save it."* Flagged rather than silently corrected because getting
  this wrong is a trust problem, and Codex should check the final string.

---

## 6. Making the admin state legible

`/admin` already has the field: `label="Claude API Key (Try-It Mode)"`
(`app/admin/page.tsx:279-286`), status row at `:189`, backed by
`GET/PUT /api/admin/settings` with the allowlist at `route.ts:52`.
**Mechanism EXISTS.** Three gaps:

1. **Source is invisible.** `getAllAdminConfig` (`lib/admin-config.ts:56-68`)
   returns `{ configured, masked }` — you cannot tell whether a configured key
   came from Redis or from `CLAUDE_TRYIT_KEY`. Add `source: 'redis' | 'env' |
   'none'`. Without it, §1's three cases stay indistinguishable from the UI,
   which is exactly the hole this whole document exists to close.
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
  **Open: the number.** 10 → 50 is my suggestion; it is a one-constant change and
  the spend is bounded by `TRYIT_MAX_TOKENS = 2048` per message.
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

1. `unconfigured` when `getAdminConfig` returns null — and **the quota store is
   never touched** (assert on the mock).
2. `available` with remaining reflecting an existing count.
3. `exhausted` at count ≥ 10.
4. Probe response contains no substring of the key, under any state.
5. Peek does not increment: probe twice, count unchanged.
6. Redis unreachable → in-memory fallback path returns a usable answer, not a 500.

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

Target: **~13 new tests**. Delta reported on the build PR.

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

## 11. Open questions for Codex R2

1. §7 — what number for `TRYIT_QUOTA`? I suggest 50 for the UAT window. Bounded
   by `TRYIT_MAX_TOKENS = 2048` per message, but it is Graham's spend.
2. §5.1 — after clearing a bad key, should the panel *auto-retry the failed
   message*, or just re-enable send? Auto-retry is friendlier and risks
   double-sending if the original request actually landed.
3. §4 — the extraction moves quota state out of a route that is currently
   working and in production. Worth a same-PR test that the send path's
   behaviour is byte-identical before/after, or is test 8 enough?
4. §5 — the privacy copy corrected in R1 ("we pass it straight to Anthropic and
   never save it"): does that read as reassuring or as raising a doubt the user
   didn't have? It is accurate; I am less sure it is well-placed.
