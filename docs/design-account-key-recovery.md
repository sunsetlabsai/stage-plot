# Design — recovery for a rejected ACCOUNT key

**Status.** Design, for review. Follows chunk 4 (`design-single-backend.md` §3), which
made the capabilities probe account-aware and moved key entry into the settings overlay.
Scope is one gap chunk 4 left open, flagged there as deliberate.

---

## 1. The gap

`/api/agent/chat` returns **401** in two cases (`app/api/agent/chat/route.ts`):

1. **A supplied BYOA key was rejected by Anthropic** (`route.ts:131` → `'Invalid API
   key. Check your key and try again.'`). No `reason` field.
2. **No key at all and try-it is unavailable** (`route.ts:90` → `reason: 'unconfigured'`).

Case 1 fires for *either* BYOA backend: a **device** key sent in the `Authorization`
header, **or** an **account** key the route resolved from the session `userId` with no
header at all (chunk 3, `resolveKeyMode`).

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

## 3. Detection

Extend the predicate's input so a send counts as key-backed when **either** a device key
was sent **or** an account key was active for that send:

```
isSavedKeyRejected({ status, hasKey: sentDeviceKey || accountKeyActive })
```

- `sentDeviceKey` = `!!apiKey` (unchanged — the header we actually sent).
- `accountKeyActive` = the account-aware probe reported a key, i.e. state 1 with no device
  key: `availability.state === 1 && !apiKey`. The probe reports **presence**, not validity,
  so a present-but-rejected account key still reads as state 1 — which is exactly the
  condition we need to catch.

**Why availability, not the response body.** The unconfigured 401 carries
`reason: 'unconfigured'` and the rejected-key 401 does not, so `!body.reason` could also
distinguish them. We deliberately do **not** key on that: `send-recovery.ts` already refuses
to match on response *content* because it is caller-owned and drifts, and availability is a
value this component already holds. `reason` stays what it is — a log breadcrumb, not a
control signal. (If review prefers a server signal, the clean version is a stable
machine field, not the absence of one — out of scope here.)

`isSavedKeyRejected` itself stays a pure `status === 401 && hasKey`; only what the caller
feeds as `hasKey` widens. The predicate remains fully unit-testable.

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

So the banner branches on which key was rejected:

| Rejected key | Copy | Action |
|---|---|---|
| Device (`apiKey` set) | "That key was rejected. Clearing it lets ShowRunr check whether free try-it mode is available." | `handleClearKey` (unchanged) |
| Account (`accountKeyActive`) | "That account key was rejected. Remove or replace it in Settings." | `setSettingsOpen(true)` |

The two are mutually exclusive at the point of a 401: device precedence means a device key,
if present, is what was sent — so `apiKey` set ⇒ device rejection, `apiKey` empty +
`accountKeyActive` ⇒ account rejection.

After the user removes or replaces the key in the overlay, the existing chunk-4 wiring does
the rest: Remove fires `onAccountKeyChange` → re-probe (and the stale-send-state reset), so
the banner clears and availability re-resolves. No new plumbing.

---

## 5. What this does NOT touch

- **No new server endpoints.** `DELETE`/`PUT /api/settings/byoa` already exist; the overlay
  uses them.
- **No probe change.** `{ accountKey: true }` already tells the client an account key is
  active; that is the whole detection input.
- **No change to device-key recovery.** Its path and copy are unchanged.
- **No auto-retry.** As today, the failed send is not resent; Send is re-armed and the user
  presses it after fixing the key.

---

## 6. Tests

- **`send-recovery.test.ts` — `isSavedKeyRejected`**: gains the account case. A 401 with
  `hasKey` true (fed from `accountKeyActive`) is a rejection; a 401 with `hasKey` false (no
  device key, no account key — the genuine unconfigured case) is **not**. The positive
  control is the unconfigured 401: it must stay un-flagged, or the banner would fire on a
  deployment that simply has no try-it key.
- **The banner branch itself is host code** (the 6700-line page), unreachable from vitest —
  declared, not faked, exactly as chunk 4 declared its host seams. The testable core is the
  predicate; the branch is a two-line `apiKey ? … : …` over it.

---

## 7. Estimated blast radius

`lib/send-recovery.ts` (predicate input widened + comment corrected), `app/[owner]/[show]/
page.tsx` (compute `accountKeyActive`, feed the predicate, branch the banner), and
`tests/send-recovery.test.ts`. No migration, no route, no schema. One design decision (§4),
ruled to (a).
