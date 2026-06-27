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
  vm: VMState;            // D2: the chunk-2 resumable seed, verbatim (the NEXT-step state)
  current: TraversalStep | null;  // D2: the last bar the shared VM EMITTED — what
                                  // renderers display ("you are here"). null pre-first-step.
  armed: Armed | null;    // pending telegraphed change (advisory display)
  clock: ClockState;      // MD-re-emitted tempo telemetry (chunk 5 fills it)
  updatedAt: number;      // = the admitted message's `sentAt` (MD clock). Display/debug
                          // only, NEVER an ordering key. Deterministic (D2/MED-2): the
                          // reducer copies sentAt, it never reads a local clock.
}

export interface Armed {
  fireAt: string;                              // barId where the change commits (marker position)
  directive: Extract<Directive, { kind: 'jumpTo' }>;  // D6: directive-shaped, not bare jumpTo
                                               // fields — widens to more armable kinds in ch4
                                               // without touching commit semantics.
}

export interface ClockState {
  tempoBpm: number | null;
  downbeatAt?: number;
  confidence: number;     // 0 when absent
}
```

### The message envelope (the wire unit)

```ts
// Every message carries the authority coordinates AND the session/song it targets,
// so the pure reducer fails CLOSED on a cross-room / replayed message (MED-1) — the
// "single authority gate" can't depend on transport to scope messages. The reducer
// is the SINGLE place (sessionId, songRef, epoch, seq) is enforced.
export interface ConductorMessage {
  sessionId: string;      // MUST match state.sessionId or the message is `ignored`
  songRef: string;        // MUST match state.songRef or the message is `ignored`
  epoch: number;
  seq: number;            // ignored for `claim` (see D4); required otherwise
  sentAt: number;         // MD wall clock at emit — the ONLY time source (MED-2); copied
                          // verbatim into updatedAt so every follower converges byte-for-byte.
  payload: ConductorPayload;
}

export type ConductorPayload =
  // Baton (re)claim — adopts the relay-accepted epoch, resets seq (D4).
  | { kind: 'claim' }
  // Normal playhead motion — the ONLY message that calls chunk-2 stepVM (D8).
  | { kind: 'advance' }
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

### The reducer outcome (the typed result — D7)

```ts
// The reducer CANNOT return bare ConductorState: it must be able to tell transport
// (3b) the difference between "nothing to do" and "I am behind — pull a snapshot."
// Without this, a dropped delta diverges a follower permanently (HIGH-1/HIGH-3).
export type ReduceOutcome =
  | { status: 'applied'; state: ConductorState }       // admitted; state advanced
  | { status: 'ignored'; state: ConductorState }       // stale / dup / mismatch — UNCHANGED
  | { status: 'needsSnapshot'; state: ConductorState }; // GAP (seq hole, missed claim,
                                                        // future epoch) — UNCHANGED; caller
                                                        // must pull a fresh snapshot (§3.3).
```

---

## 3. The reducer

```ts
export function reduceConductor(
  compiled: CompiledRoadmap,        // recomputed from the SongStructure, never wired
  state: ConductorState,
  msg: ConductorMessage,
): ReduceOutcome                     // D7 — typed result, not bare state
```

Pure. Recompute `compiled` once per song load on each device (it never travels — same as the batch path). The reducer is the only authority gate. **Deltas, not snapshots:** every non-claim message mutates the prior state, so admission must guarantee *contiguity* — a follower may never apply delta N+2 over state N (HIGH-1). Any gap routes to `needsSnapshot`, the **same recovery door as a fresh join** (§3.3).

### 3.1 Admission (the gate) — applied first, to every message

In order. Each rule returns one `ReduceOutcome`; only the last admits.

1. **Session/song scope (MED-1).** `msg.sessionId !== state.sessionId || msg.songRef !== state.songRef` → `{ ignored }` (state unchanged). The pure reducer fails closed; it does not trust transport to scope.
2. **`claim` (D4).** Claims are the *only* epoch-raiser, and they carry the **relay-accepted** epoch (the relay already arbitrated *which* claim won — §5):
   - `msg.epoch > state.epoch` → **adopt:** `epoch = msg.epoch`, `seq = 0`, `armed = null`; `vm`/`current`/`clock` carry forward; `updatedAt = msg.sentAt`. → `{ applied }`.
   - `msg.epoch <= state.epoch` → `{ ignored }` (a replayed / equal / stale claim is a no-op — never bumps epoch; this is why epoch is **carried**, never `state.epoch + 1`).
3. **Stale epoch.** non-claim, `msg.epoch < state.epoch` → `{ ignored }` (stale baton).
4. **Future epoch.** non-claim, `msg.epoch > state.epoch` → `{ needsSnapshot }`. The follower *might* have missed an accepted claim, or this *might* be forged — the pure reducer **cannot** tell, so it fails **safe** (ask for a snapshot) instead of failing **silent** (apply → diverge, or reject → strand). Forgery is rejected one layer down: the relay only relays from the epoch holder (3b). HIGH-3.
5. **Same epoch — seq contiguity.** non-claim, `msg.epoch === state.epoch`:
   - `msg.seq <= state.seq` → `{ ignored }` (duplicate / reorder; idempotent no-op).
   - `msg.seq === state.seq + 1` → **admit** (the next in-order delta); set `seq = msg.seq`. → §3.2.
   - `msg.seq > state.seq + 1` → `{ needsSnapshot }` (a delta was dropped; replaying out of order would diverge — HIGH-1).

> **Followers never write.** They run this reducer on inbound MD messages to *mirror*; they never originate a message. Single-writer (§4) is enforced socially (only the MD's UI emits) AND structurally (the relay only accepts from the epoch holder — 3b).

### 3.2 Payload application (only after admission; produces `{ applied }`)

The admitted message sets `seq = msg.seq` and `updatedAt = msg.sentAt`, then:

- **`advance`** (D8) → `const r = stepVM(compiled, vm); vm = r.state; if (r.transition) current = r.transition`. This is the **only** message that advances the playhead normally; `current` becomes the bar just emitted (so late-joiners read a *real* current bar, not the next-step index — HIGH-2). At song end `stepVM` returns no transition; `current` holds the last bar and `vm.done` is true.
- **`redirect`** → `vm = applyOverride(compiled, vm, directive)` (chunk-2, pure). Moves the *next-step* seed; `current` is unchanged until the following `advance` re-emits onto the new location (the live gesture: point the baton, then downbeat). See D2 open-q.
- **`arm`** → `armed = msg.payload.armed`. (No VM change yet; advisory display.)
- **`disarm`** → `armed = null`. (D5.)
- **`commit`** → if `armed === null`, no-op (idempotent). Else: `vm = applyOverride(compiled, vm, armed.directive)`, then `armed = null`. Same as redirect, `current` re-emits on the next `advance` (D2 open-q).
- **`clock`** → `clock = msg.payload.clock`. (Pure store; chunk 5 supplies it.)

### 3.3 Late-join / reconnect / gap recovery — one door

No event replay. Whenever a follower is **not converged** — a fresh join, a `needsSnapshot` seq gap, a missed claim, or a future epoch — it pulls the full `ConductorState` (3b delivers it; 3a just *is* the value) and resumes mirroring from it. The snapshot **resets the follower's `(epoch, seq)` baseline** to the MD's, so the very next in-order delta admits cleanly. Because the state carries `current` + `armed`, a mid-cue joiner sees both the live position and any pending change (§3.5 "why it must be state, not an event"). The reducer's job is only to *detect* the gap (`needsSnapshot`) and stay pure; the *fetch* is 3b's.

---

## 4. Decisions for sign-off

- **D1 — Split 3a (pure reducer, build now) from 3b (transport, gated by §8.2-2).** Recommend YES: 3a is the natural pure-core next step and unblocks chunks 4-5 logic; 3b waits for the discovery/claim protocol. *(If you'd rather close §8.2-2 first and design 3a+3b together, say so.)*
- **D2 — `ConductorState.vm = VMState` (the resumable seed) + `current: TraversalStep | null` (the last EMITTED bar)** (supersede §6's illustrative `node: CanonicalRef` shape). Two facts forced this split (Codex HIGH-2, verified against `roadmap-vm.ts:379`): (a) `VMState.cursor` is the **next** position index, not the current bar — `stepVM` records `bars[cursor]` *then* advances — so deriving display from it shows late-joiners the wrong bar; (b) the field name `cursor: VMState` invited a `cursor.cursor` footgun. So: rename the field to `vm`, and store the bar the VM actually emitted in `current`. Display = `current` (no derivation from the next-step index). Recommend YES.
  - **Open sub-q (D2):** after a `redirect`/`commit` jumpTo, does `current` move to the target **immediately**, or only when the next `advance` re-emits onto it? This doc takes **re-emit-on-advance** (point-the-baton-then-downbeat; keeps `current` always a real emitted bar, never an invented pass number for an un-played target). If you want the playhead to snap to the target the instant you commit, say so and `commit`/`redirect`-jumpTo will also set `current = { barId: target, pass: vm.passCount[target] ?? 0 }`. **Needs your call.**
- **D3 — Envelope naming `ConductorMessage`/`ConductorPayload`; `redirect` wraps the chunk-2 `Directive`** (avoid the name collision). Recommend YES.
- **D4 — `claim` is the only epoch-raiser; it CARRIES the relay-accepted epoch and the reducer adopts it iff `msg.epoch > state.epoch`** (equal/lower claim = `ignored` no-op), resetting `seq = 0` and clearing `armed`. Never compute `state.epoch + 1` in the reducer (that would let a replayed/equal claim bump the baton — Codex HIGH-3). The relay arbitrated *which* claim won (§5/§8.2-2); the reducer trusts the accepted value. Recommend YES (carried, strict `>`).
- **D5 — Add a `disarm` directive** (MD cancels a telegraphed change before commit). Not in §6's set, but the change-marker UX needs "never mind." Recommend YES (cheap, obviously needed for chunk 4).
- **D6 — Only `jumpTo`-shaped changes are *armable*, carried as a directive not bare fields** — `Armed.directive: Extract<Directive, { kind: 'jumpTo' }>` (Codex LOW). `anotherRound`/`hold`/`release`/`resetJump` are *immediate* `redirect`s, not telegraphed. The directive-shaped envelope lets chunk 4 widen the armable set (e.g. telegraphed `anotherRound`) without touching commit semantics. Open: should "one more time" be armable too? Musically you *do* signal it early. Recommend: ship 3a jumpTo-only armed; revisit in chunk 4.
- **D7 — The reducer returns `ReduceOutcome` (`applied` / `ignored` / `needsSnapshot`), not bare `ConductorState`** (Codex HIGH-1/HIGH-3, MED-1). This is the root fix: a pure delta reducer must be able to tell transport "I am behind — pull a snapshot," or a single dropped message diverges the follower forever. `needsSnapshot` unifies seq-gap, missed-claim, and future-epoch recovery into the one late-join door (§3.3). Recommend YES.
- **D8 — Add an `advance` payload** — the only message that calls chunk-2 `stepVM` and moves `current` (Codex HIGH-2b). Without it the shared VM can only be *redirected*, never progress bar-to-bar normally. It is an ordinary `(epoch, seq)` delta (idempotent, contiguity-gated) and the primary live message. Recommend YES.
- **D9 — Envelope is self-authenticating: `sessionId` + `songRef` (fail-closed scope, MED-1) and `sentAt` (the ONLY time source, MED-2).** The reducer copies `sentAt → updatedAt` so followers converge byte-for-byte; it never reads a local clock. Recommend YES.

---

## 5. Test plan (3a, pure)

Every assertion is on the `ReduceOutcome.status` AND the resulting state (D7).

- **Outcome discrimination:** in-order delta → `applied`; duplicate/lower seq → `ignored` + unchanged; **seq gap (`seq > state.seq+1`) → `needsSnapshot` + unchanged** (HIGH-1 regression test); stale epoch → `ignored`; **future non-claim epoch → `needsSnapshot`** (HIGH-3); session/song mismatch → `ignored` (MED-1).
- **Contiguity (HIGH-1):** apply seq 1,2,**4** → the 4 is `needsSnapshot` and state stays at seq 2; then snapshot-reset to MD state + seq 3,4 converges. Prove the pre-fix bug is gone: arm(2) dropped, commit(3) must NOT silently no-op-then-advance past the lost arm.
- **Claim (HIGH-3/D4):** claim with `epoch > state.epoch` → `applied`, epoch adopted, seq=0, armed cleared; **equal/lower-epoch claim → `ignored`, epoch NOT bumped** (replay-bump regression); post-claim lower-epoch directive → `ignored`.
- **advance (HIGH-2/D8):** N advances over a known roadmap → `current` equals the chunk-2 `stepVM` transition stream bar-for-bar; `current` is the EMITTED bar (not `vm.cursor`'s next index); song-end advance → no `current` change, `vm.done` true; idempotent under repeated seq.
- **redirect:** wraps each chunk-2 directive (anotherRound/hold/release/jumpTo/resetJump) → `vm` matches a direct `applyOverride` (equivalence net); `current` unchanged until the next advance re-emits (D2 decision).
- **arm/commit/disarm:** arm sets armed; commit applies `armed.directive` and clears armed; commit with nothing armed = no-op; disarm clears; double-commit = idempotent.
- **clock:** stored verbatim; ordering still governed by seq.
- **Determinism (MED-2):** two reducers fed identical messages produce byte-identical state incl. `updatedAt` (= `sentAt`); the reducer reads no local clock.
- **Purity:** reducer never mutates the input state (JSON-snapshot guard, mirroring the chunk-2 purity tests).
- **Late-join = gap recovery (one door):** a fresh mirror fed a snapshot + subsequent in-order messages ends at the same state as one that saw the whole stream; a `needsSnapshot` follower re-based on a snapshot converges identically.

---

## 6. What this unblocks

- **Chunk 4** (change-marker UI + gated auto-fire) consumes `arm`/`commit`/`disarm` + the `armed` field directly.
- **Chunk 5** (clock) consumes the `clock` directive + field.
- **3b** (transport) wraps this reducer behind the relay once §8.2-2 (discovery + claim protocol) is designed.
