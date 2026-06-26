# Conductor chunk 3 — the shared state machine (build-level design)

**Status:** DESIGN-ONLY (review the spec; do NOT build until GO).
**Parent:** `design-conductor-authority.md` §4 (authority/epoch), §6 (state machine), §9-3 (build outline).
**Builds on:** chunk 2 `lib/roadmap-vm.ts` — `VMState`, `Directive` (the VM-level override), `compileRoadmap`/`initVM`/`stepVM`/`applyOverride`. Shipped to main `b69090f`.

---

## 0. Why a fresh design (two things the parent left to chunk-3 time)

1. **The §8.2-2 gate splits this chunk.** The parent (§8.2 "Still open") states **failover + session discovery on a backhaul-less relay gates chunk-3 *transport*** — the `claim` discovery protocol (how a new MD is found/accepted post-death) and room discovery (QR / mDNS / room code) are **not designed yet.** So chunk 3 cleanly splits:
   - **3a — the pure state machine (this doc, buildable now):** `ConductorState`, the directive envelope, `(epoch, seq)` idempotency, the reducer, claim *as a reducer rule* (higher accepted epoch wins), late-join snapshot. Zero network. Fully unit-testable, mirrors the chunk-1/2 "pure core first" pattern.
   - **3b — the transport (deferred, gated by §8.2-2):** the own-AP WebSocket relay, room discovery, and the relay-arbitrated claim *protocol*. Needs §8.2-2 closed first.
   - **Why the split is honest:** the reducer rule "a higher *accepted* epoch supersedes" is well-defined regardless of *how* a claim is arbitrated — the **relay** is the arbiter (§5), the reducer just adopts what the relay already accepted. So 3a does not depend on §8.2-2; only 3b does.

2. **§6 `ConductorState.cursor` predates the real `VMState`.** §6 sketches `cursor: { node: CanonicalRef; completedPasses; fired; flags; passCount }` — illustrative, written before chunk 2 existed. Chunk 2 produced the **actual** serializable snapshot `VMState` (`roadmap-vm.ts:75`): `{ cursor: number; completedPasses; fired; flags; passCount; holding; done }`, and the file header already declares "VMState is the serializable wire snapshot (design §6 ConductorState.cursor)." **Decision D2 below** reconciles them.

---

## 1. Scope of 3a (this doc)

A **pure reducer** over an authoritative state object, plus the message envelope and idempotency rules. No sockets, no React, no discovery. The MD's device owns one `ConductorState`; the reducer is how every directive mutates it; followers run the *same* reducer on the *same* messages and converge.

Out of scope (named so the boundary is explicit):
- Transport / relay / discovery / the claim *wire protocol* → **3b (gated, §8.2-2).**
- Change-marker **UI** + gated auto-fire trigger → **chunk 4** (§3.5). 3a owns the `armed` *data* + the arm/commit *reducer* transitions only.
- Clock detection/listener → **chunk 5** (§5.1). 3a carries the `clock` field + a `clock` directive that just stores the MD-re-emitted value (no detection).
- Local detach/resync → **per-device local UI state, never shared** (§4). Explicitly NOT in the reducer.

---

## 2. Types

```ts
// The authoritative shared state. The MD owns it; followers mirror it verbatim.
export interface ConductorState {
  sessionId: string;
  songRef: string;        // which SongStructure this VM runs on
  epoch: number;          // baton generation; a higher ACCEPTED epoch supersedes
  seq: number;            // monotonic per-epoch, MD-only; orders + supersedes
  cursor: VMState;        // D2: the chunk-2 canonical VM snapshot, verbatim
  armed: Armed | null;    // pending telegraphed change (advisory display)
  clock: ClockState;      // MD-re-emitted tempo telemetry (chunk 5 fills it)
  updatedAt: number;      // wall clock, display/debug only — NEVER an ordering key
}

export interface Armed {
  fireAt: string;         // barId where the change commits (the marker position)
  jumpTo: string;         // barId target
  exit?: ExitPolicy;      // reuse chunk-2 ExitPolicy (alCoda | alFine)
}

export interface ClockState {
  tempoBpm: number | null;
  downbeatAt?: number;
  confidence: number;     // 0 when absent
}
```

### The message envelope (the wire unit)

```ts
// Every message carries the authority coordinates. The reducer is the SINGLE
// place (epoch, seq) is enforced; payload is a discriminated union.
export interface ConductorMessage {
  epoch: number;
  seq: number;            // ignored for `claim` (see D4); required otherwise
  payload: ConductorPayload;
}

export type ConductorPayload =
  // Baton (re)claim — bumps epoch, resets the per-epoch seq high-water (D4).
  | { kind: 'claim' }
  // Immediate VM redirects — thin pass-through to chunk-2 applyOverride.
  | { kind: 'redirect'; directive: Directive }   // Directive = chunk-2 union
  // Telegraphed change marker (advisory). arm sets armed; commit fires + clears.
  | { kind: 'arm'; armed: Armed }
  | { kind: 'commit' }                            // fire the currently-armed change
  | { kind: 'disarm' }                            // MD cancels a pending change (D5)
  // MD-re-emitted clock telemetry (chunk 5 produces the value).
  | { kind: 'clock'; clock: ClockState };
```

> **Naming:** chunk 2 already exports `Directive` (the *VM-level* override). The conductor layer uses `ConductorMessage` / `ConductorPayload` so there is no collision; `redirect` simply wraps the chunk-2 `Directive`. (D3.)

---

## 3. The reducer

```ts
export function reduceConductor(
  compiled: CompiledRoadmap,        // recomputed from the SongStructure, never wired
  state: ConductorState,
  msg: ConductorMessage,
): ConductorState
```

Pure. Recompute `compiled` once per song load on each device (it never travels — same as the batch path). The reducer is the only authority gate:

### 3.1 Admission (the (epoch, seq) gate) — applied first, to every message

1. `msg.epoch < state.epoch` → **reject** (stale baton). Return `state` unchanged.
2. `msg.payload.kind === 'claim'` → see D4 (epoch bump). Claims are the *only* way epoch rises.
3. `msg.epoch > state.epoch` on a **non-claim** → **reject.** A non-claim can never introduce a new epoch (only the relay-arbitrated claim does). Guards against a forged future-epoch directive.
4. `msg.epoch === state.epoch`:
   - `msg.seq <= state.seq` → **reject** (duplicate / reordered; idempotent — re-applying is a no-op, the §3.3 invariant at the wire layer).
   - `msg.seq > state.seq` → **admit**, then set `state.seq = msg.seq` on the produced state.

> **Followers never write.** They run this reducer on inbound MD messages to *mirror*; they never originate a message. Single-writer (§4) is enforced socially (only the MD's UI emits) AND structurally (the relay only accepts from the epoch holder — 3b).

### 3.2 Payload application (only after admission)

- **`redirect`** → `cursor = applyOverride(compiled, cursor, directive)` (chunk-2, pure). Done.
- **`arm`** → `armed = msg.payload.armed`. (No VM change yet; advisory display.)
- **`disarm`** → `armed = null`. (D5.)
- **`commit`** → if `armed === null`, no-op (idempotent). Else:
  `cursor = applyOverride(compiled, cursor, { kind: 'jumpTo', barId: armed.jumpTo, exit: armed.exit })`, then `armed = null`. The committed cursor + cleared armed is the authoritative post-fire state (§6 "deterministic, MD-owned").
- **`clock`** → `clock = msg.payload.clock`. (Pure store; chunk 5 supplies it.)
- **`claim`** → handled in admission (D4); produces a fresh-epoch state.

Every admitted message also bumps `seq` (3.1.4) and refreshes `updatedAt`.

### 3.3 Late-join / reconnect

No event replay. A joiner pulls the full `ConductorState` (3b delivers it; 3a just *is* the value) and resumes mirroring. Because the state is the committed cursor + current armed, a mid-cue joiner sees the pending change too (§3.5 "why it must be state, not an event").

---

## 4. Decisions for sign-off

- **D1 — Split 3a (pure reducer, build now) from 3b (transport, gated by §8.2-2).** Recommend YES: 3a is the natural pure-core next step and unblocks chunks 4-5 logic; 3b waits for the discovery/claim protocol. *(If you'd rather close §8.2-2 first and design 3a+3b together, say so.)*
- **D2 — `ConductorState.cursor = VMState` verbatim** (supersede §6's illustrative `node: CanonicalRef` shape). The display "node/label" is *derived* by each renderer from `cursor.cursor` (bar index) → barId → local resolve; it is not stored. Recommend YES.
- **D3 — Envelope naming `ConductorMessage`/`ConductorPayload`; `redirect` wraps the chunk-2 `Directive`** (avoid the name collision). Recommend YES.
- **D4 — `claim` is the only epoch-raiser; bumps `epoch += 1` (or to a relay-supplied value) and resets `seq = 0`** for the new generation; the reducer adopts any *admitted* claim (the relay already arbitrated *which* claim — §5/§8.2-2). Open sub-q: epoch = `state.epoch + 1` computed by reducer, or carried on the claim message from the relay? Recommend **carried** (the relay is the arbiter; reducer trusts the accepted value), with `seq` reset to 0.
- **D5 — Add a `disarm` directive** (MD cancels a telegraphed change before commit). Not in §6's set, but the change-marker UX needs "never mind." Recommend YES (cheap, obviously needed for chunk 4).
- **D6 — Only `jumpTo`-shaped changes are *armable*** (matches §6 `armed`); `anotherRound`/`hold`/`release`/`resetJump` are *immediate* `redirect`s, not telegraphed. Open: should "one more time" (anotherRound) be armable/telegraphed too? Musically you *do* signal it early. Recommend: ship 3a with jumpTo-only armed (per §6); revisit armable-anotherRound in chunk 4 if the UX wants it.

---

## 5. Test plan (3a, pure)

- **Idempotency:** duplicate `(epoch, seq)` → no-op; reordered (lower seq) → ignored; a behind state re-converges when the next in-order msg arrives.
- **Epoch:** stale epoch rejected; non-claim future epoch rejected; `claim` bumps epoch + resets seq; post-claim lower-epoch directive rejected.
- **redirect:** wraps each chunk-2 directive (anotherRound/hold/release/jumpTo/resetJump) → cursor matches a direct `applyOverride` (equivalence net).
- **arm/commit/disarm:** arm sets armed; commit applies jumpTo+exit and clears armed; commit with nothing armed = no-op; disarm clears; double-commit = idempotent.
- **clock:** stored verbatim; ordering still governed by seq.
- **Purity:** reducer never mutates the input state (JSON-snapshot guard, mirroring the chunk-2 purity tests).
- **Late-join:** a fresh mirror fed the current state + subsequent in-order messages ends at the same state as one that saw the whole stream.

---

## 6. What this unblocks

- **Chunk 4** (change-marker UI + gated auto-fire) consumes `arm`/`commit`/`disarm` + the `armed` field directly.
- **Chunk 5** (clock) consumes the `clock` directive + field.
- **3b** (transport) wraps this reducer behind the relay once §8.2-2 (discovery + claim protocol) is designed.
