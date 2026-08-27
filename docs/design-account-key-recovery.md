# Design — recovery for a rejected ACCOUNT key

**Status.** Design, for review. Follows chunk 4 (`design-single-backend.md` §3), which
made the capabilities probe account-aware and moved key entry into the settings overlay.
Scope is one gap chunk 4 left open, flagged there as deliberate.

---

## 1. The gap

`/api/agent/chat` returns **401** in three cases (`app/api/agent/chat/route.ts`):

1. **A BYOA key was rejected by Anthropic** — `resolved.mode === 'byoa'`, then Anthropic 401
   (`route.ts:131` → `'Invalid API key. Check your key and try again.'`). No `reason` field.
2. **The shared try-it key was rejected by Anthropic** — `resolved.mode === 'tryit'`, same
   Anthropic-401 path, *same message*. No `reason` field. (Design review R2, Codex Medium:
   this case is easy to miss because it is byte-identical to case 1 on the wire.)
3. **No key at all and try-it is unavailable** (`route.ts:90` → `reason: 'unconfigured'`).

Only **case 1** is the user's to fix, and it fires for *either* BYOA backend: a **device**
key sent in the `Authorization` header, **or** an **account** key the route resolved from the
session `userId` with no header at all (chunk 3, `resolveKeyMode`). Case 2 is a *platform*
fault — the user holds no key and can do nothing about the shared one — so it must **not**
raise the "your key was rejected" banner; case 3 likewise. The whole detection problem is
telling case 1 apart from cases 2 and 3, which status alone cannot do.

The show page has a recovery affordance for case 1 today — the `keyRejected` banner
("Clear saved key") — but it only detects the **device** variant:

```
isSavedKeyRejected({ status: res.status, hasKey: !!apiKey })   // page.tsx:5283
```

`apiKey` is the *device* key. For an account key it is empty, so `hasKey` is false and the
banner never shows. The user sees only the raw inline error and has no in-context path to
fix the key. Everything to fix it already exists (the settings overlay's Remove/Replace) —
nothing routes them there.

**This is not a data bug.** The predicate *under*-detects (misses account rejections); it
never *mis*-detects. So the current behaviour is safe, just incomplete.

---

## 2. A stale premise to correct alongside

`lib/send-recovery.ts`'s `isSavedKeyRejected` doc-comment justifies "401 while holding a
key ⇒ rejection" like this:

> the [unconfigured] 401 cannot fire while we hold a key, because the client only omits the
> `Authorization` header when `apiKey` is empty and the route resolves to `byoa` whenever
> that header is present.

Chunk 3/4 broke that premise: the route now resolves `byoa` from the **account** key with
**no header at all**. So "no header" no longer implies "no key," and the reasoning that
made the device-only predicate provably complete is now itself incomplete. The comment must
be corrected in the same change, or it will mislead the next reader into thinking the
device-only check is exhaustive.

---

## 3. Detection — a server signal, not a client guess

> **Revised after design review R1 (Codex, Medium).** The first draft detected an
> account-key rejection from `availability.state === 1 && !apiKey`. That is a **prior probe
> snapshot, not the server's resolution for this send.** Between the probe and the send the
> account key can be removed on another device, be unreadable (`readAccountKey` fails open →
> try-it), or the 401 can be a try-it / unconfigured case — each of which a probe-based label
> would mis-attribute to the account key. Detection must come from the side that actually
> resolved the key.

The **server** performed the resolution, so the server names the rejected source.
`resolveKeyMode` tags its BYOA result with where the key came from:

```
{ mode: 'byoa'; source: 'device' | 'account'; apiKey; model; maxTokens }
```

- client key (the `Authorization` header) → `source: 'device'`
- account key (resolved from `userId`) → `source: 'account'`

On an Anthropic **401 for a BYOA send**, `/api/agent/chat` includes a stable machine field:

```
{ error: 'Invalid API key…', keyReject: 'device' | 'account' }     // status 401
```

**`keyReject` is set only when `resolved.mode === 'byoa'`** — it is derived from
`resolved.source`, which exists on no other mode. So the two 401s the user cannot fix carry
none: the **try-it** rejection (§1 case 2, `resolved.mode === 'tryit'`) and the
**unconfigured** 401 (§1 case 3, which already carries `reason: 'unconfigured'`). Its absence
is meaningful — "no `keyReject`" is exactly "not a key the user can fix," which is why the
banner keys on presence, not on the 401 status. `keyReject` is an **enum the client switches
on, not copy**, so reading it does not violate `send-recovery.ts`'s "never match on response
*text*" rule; it is the same kind of machine breadcrumb `reason` already is, promoted to a
control signal because the client genuinely needs it.

Detection becomes: **a 401 whose parsed body carries `keyReject`.** `isSavedKeyRejected`
reads that field and returns the rejected **source** (`'device' | 'account' | null`) instead
of guessing from `hasKey`. The send handler already parses the 401 body for its error text,
so `keyReject` is in hand. No availability inference; the label is the server's truth, and
because the server used exactly one key, the two cases are mutually exclusive **by
construction**, not by a client-side precedence argument.

The predicate stays pure and fully unit-testable, and — new benefit — the *production* of the
signal is now testable too: `agent-chat-route.test.ts` can assert the 401 carries the right
`keyReject` for a rejected device key vs a rejected account key, which the old
availability-based scheme could only assert through the untestable host.

---

## 4. Recovery action — the one real decision

The device banner clears `localStorage` via `handleClearKey`. That is **wrong for an
account key**: the key lives server-side, so clearing the (empty) device key changes
nothing, the re-probe returns `{ accountKey: true }` again (presence, not validity), and the
next send 401s identically — a loop.

**Ruled: the account-key banner opens the settings overlay** (`setSettingsOpen(true)`),
where Remove and Replace already exist and already carry the consent copy. Rejected.

- **Not auto-delete from the banner.** An Anthropic 401 does mean the key is genuinely bad
  (revoked/invalid, not transient), so deleting would be *defensible* — but destroying a
  stored credential straight from an error affordance is heavier than warranted when a
  one-click route to the same Remove button exists. Replace is also often what the user
  actually wants (they rotated the key), and the overlay offers both; a bare "delete" does
  not.

So the banner branches on `keyReject` (§3), which the server set:

| `keyReject` | Copy | Action |
|---|---|---|
| `'device'` | "That key was rejected. Clearing it lets ShowRunr check whether free try-it mode is available." | `handleClearKey` (unchanged) |
| `'account'` | "That account key was rejected. Remove or replace it in Settings." | `setSettingsOpen(true)` |

### 4.1 The banner must be cleared on recovery (design review R1, Codex Medium)

The first draft claimed the existing chunk-4 wiring clears the banner after Remove/Replace.
It does **not**: `handleAccountKeyChange` resets the probe and the stale send state but
**leaves `keyRejected` set** (`page.tsx`), so the "that account key was rejected" banner
would survive the very action that fixed the key — a confusing loop. The implementation
**must** add `setKeyRejected(false)` to `handleAccountKeyChange`, mirroring the device path
(which already clears it via `handleClearKey`/`handleDeviceKeyChange`). Removing **and**
replacing both route through `onAccountKeyChange`, so one line covers both. This is a
required part of the change, not incidental.

---

## 5. What this touches, and what it does NOT

**Touches:** `lib/agent-key.ts` (tag `KeyMode` BYOA with `source`), `app/api/agent/chat/
route.ts` (surface `keyReject` on the BYOA 401), `lib/send-recovery.ts` (predicate reads
`keyReject`, premise corrected), `app/[owner]/[show]/page.tsx` (banner branch +
`setKeyRejected(false)` in `handleAccountKeyChange`), and the two test files (§6).

**Does NOT touch:**

- **No new server endpoints.** `DELETE`/`PUT /api/settings/byoa` already exist; the overlay
  uses them. The chat route is *modified*, not added to.
- **No probe change.** `/api/agent/capabilities` and `{ accountKey: true }` are untouched;
  detection now comes from the chat 401, not the probe.
- **No migration, no schema.** `source` is a runtime field on `KeyMode`, not a stored column.
- **No change to device-key recovery** beyond re-keying it on `keyReject: 'device'` (same
  path, same copy, same `handleClearKey`).
- **No auto-retry.** As today, the failed send is not resent; Send is re-armed and the user
  presses it after fixing the key.

---

## 6. Tests

- **`agent-chat-route.test.ts` — the signal's PRODUCTION**: a send that resolves a **device**
  key which Anthropic 401s returns `keyReject: 'device'`; a send that resolves an **account**
  key which 401s returns `keyReject: 'account'`; the **try-it** key rejected by Anthropic
  (§1 case 2) returns **no** `keyReject` (design review R2 — this is the case that must not
  raise a banner despite an identical error message); the **unconfigured** 401 (§1 case 3)
  returns **no** `keyReject` (and still `reason: 'unconfigured'`). This is the coverage the R1
  design gained by moving detection server-side — it was untestable under the availability
  scheme. Positive controls: both the try-it-rejection and the unconfigured cases must stay
  `keyReject`-free, or the banner would fire on a platform-key fault the user cannot fix.
- **`send-recovery.test.ts` — `isSavedKeyRejected`**: maps a 401 body carrying `keyReject` to
  its source, and a 401 without it (unconfigured) to "not a key rejection." A non-401 with a
  stray `keyReject` is also not a rejection (status gate holds).
- **The banner branch itself is host code** (the 6700-line page), unreachable from vitest —
  declared, not faked, exactly as chunk 4 declared its host seams. The testable cores are the
  server field and the predicate; the branch is a two-line switch over `keyReject`.

---

## 7. Estimated blast radius

`lib/agent-key.ts` (BYOA `source` tag), `app/api/agent/chat/route.ts` (surface `keyReject` on
the BYOA 401), `lib/send-recovery.ts` (predicate reads `keyReject`, premise corrected),
`app/[owner]/[show]/page.tsx` (banner branch + `setKeyRejected(false)` in
`handleAccountKeyChange`), and `tests/agent-chat-route.test.ts` + `tests/send-recovery.test.ts`.
No migration, no new route, no schema. The one product decision (§4) is ruled to (a); the R1
review moved detection from a client guess to a server signal (§3) and added the required
banner-clear (§4.1).
