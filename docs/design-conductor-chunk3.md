# Conductor chunk 3 — the shared state machine (build-level design)

**Status:** DESIGN-ONLY (review the spec; do NOT build until GO).
**Parent:** `design-conductor-authority.md` §4 (authority/epoch), §6 (state machine), §9-3 (build outline).
**Builds on:** chunk 2 `lib/roadmap-vm.ts` — `VMState`, `Directive` (the VM-level override), `compileRoadmap`/`initVM`/`stepVM`/`applyOverride`. Shipped to main `b69090f`.

---

## 0. Why a fresh design (two things the parent left to chunk-3 time)

1. **The §8.2-2 gate splits this chunk.** The parent (§8.2 "Still open") states **failover + session discovery on a backhaul-less relay gates chunk-3 *transport*** — the `claim` discovery protocol (how a new MD is found/accepted post-death) and room discovery (QR / mDNS / room code) are **not designed yet.** So chunk 3 cleanly splits:
   - **3a — the pure state machine (this doc, buildable now):** `ConductorState`, the directive envelope, `(epoch, seq)` idempotency, the reducer, claim *as a reducer rule* (a higher-epoch claim is a **snapshot boundary** → `needsSnapshot`, D4), late-join snapshot. Zero network. Fully unit-testable, mirrors the chunk-1/2 "pure core first" pattern.
   - **3b — the transport (deferred, gated by §8.2-2):** the own-AP WebSocket relay, room discovery, and the relay-arbitrated claim *protocol*. Needs §8.2-2 closed first.
   - **Why the split is honest:** the reducer rule "a higher-epoch claim forces a re-base" is well-defined regardless of *how* a claim is arbitrated — the **relay** is the arbiter (§5), and the reducer never *adopts* a claim into local state (its local VM may be stale); it routes to a snapshot that the new MD already minted authoritatively (D4). So 3a does not depend on §8.2-2; only 3b does.

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
  songRef: string;        // which SongStructure this VM runs on (song identity)
  programHash: string;    // D10: identity of the EXACT compiled program the indices below
                          // run against — hash(ordered bar ids + roadmap markers). vm.cursor
                          // is a numeric index into compiled.bars and every counter/fired flag
                          // keys to THIS roadmap; a different revision silently remaps them.
                          // The session is bound to an immutable (songRef, programHash).
  epoch: number;          // baton generation; a higher-epoch claim forces a re-base (D4)
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
// Every message carries the authority coordinates AND the session/song it SCOPES to,
// so the pure reducer fails CLOSED on a cross-room / replayed message (MED-1). This is
// SCOPING, not authentication — sender authenticity stays a relay responsibility (3b).
// The reducer is the SINGLE place (sessionId, songRef, epoch, seq) is enforced.
export interface ConductorMessage {
  sessionId: string;      // MUST match state.sessionId or the message is `ignored`
  songRef: string;        // MUST match state.songRef or the message is `ignored`
  programHash: string;    // D10: MUST match state.programHash or the message is `ignored` —
                          // a message keyed to a different roadmap revision cannot be applied
                          // to these numeric indices. Structure edit = new session, never a
                          // silent remap within a live one.
  epoch: number;
  seq: number;            // ignored for `claim` (a claim → needsSnapshot, D4); required otherwise
  sentAt: number;         // MD wall clock at emit — the ONLY time source (MED-2); copied
                          // verbatim into updatedAt so every follower converges byte-for-byte.
  payload: ConductorPayload;
}

export type ConductorPayload =
  // Baton (re)claim — a SNAPSHOT BOUNDARY: a higher-epoch claim → needsSnapshot (D4).
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
  | { status: 'needsSnapshot'; state: ConductorState }; // RE-BASE NEEDED (seq hole, higher-
                                                        // epoch claim, future epoch) — UNCHANGED;
                                                        // caller must pull a fresh snapshot (§3.3).
```

---

## 3. The reducer

```ts
export function reduceConductor(
  compiled: CompiledRoadmap,        // recomputed from the SongStructure, never wired
  programHash: string,              // D10: identity of THAT compiled program (loader-computed)
  state: ConductorState,
  msg: ConductorMessage,
): ReduceOutcome                     // D7 — typed result, not bare state
```

Pure. Recompute `compiled` once per song load on each device (it never travels — same as the batch path); the loader computes `programHash` from the same inputs. The reducer is the only authority gate. **Program-pinned (D10):** `compiled` is an *external* argument whose `bars` array gives `vm.cursor` its meaning, so the reducer **fails closed** unless the local program, the state, and the message all name the same roadmap revision — `programHash !== state.programHash` is a caller bug (the loader handed a mismatched `compiled`); `msg.programHash !== state.programHash` is a cross-revision message → `{ ignored }` (§3.1.1). **Deltas, not snapshots:** every non-claim message mutates the prior state, so admission must guarantee *contiguity* — a follower may never apply delta N+2 over state N (HIGH-1). Any gap routes to `needsSnapshot`, the **same recovery door as a fresh join** (§3.3).

### 3.1 Admission (the gate) — applied first, to every message

In order. Each rule returns one `ReduceOutcome`; only the last admits.

1. **Session / song / program scope (MED-1, D10).** `msg.sessionId !== state.sessionId || msg.songRef !== state.songRef || msg.programHash !== state.programHash` → `{ ignored }` (state unchanged). The pure reducer fails closed; it does not trust transport to scope. `programHash` is what stops a same-`songRef` message from a *different roadmap revision* from being silently applied to these numeric indices (Codex R3 HIGH). (Precondition, asserted by the harness: the local `programHash` argument equals `state.programHash` — else the loader compiled the wrong structure.)
2. **`claim` (D4).** Claims are the *only* epoch-raiser, and they carry the **relay-accepted** epoch (the relay already arbitrated *which* claim won — §5). A claim is a **snapshot boundary, not a follower-applicable delta** (Codex R2 HIGH): the follower's local `vm`/`current` may be stale on the *old* epoch, so re-basing to `seq = 0` on top of it would diverge permanently. Therefore the reducer never *adopts* a claim into local state:
   - `msg.epoch > state.epoch` → `{ needsSnapshot }`. The follower pulls the new generation's full `ConductorState` (§3.3) — the only safe baseline for a new baton.
   - `msg.epoch <= state.epoch` → `{ ignored }` (a replayed / equal / stale claim is a no-op — never bumps epoch; this is why epoch is **carried**, never `state.epoch + 1`).

   > The *new MD* mints the new-generation state **out of band** via an MD-local accept-baton helper (`epoch+1`, `seq = 0`, `armed = null`, carrying its **own authoritative** `vm`/`current`/`clock`) — authoritative because the new MD holds the truth. That helper is not the follower reducer; it is the snapshot the relay then serves to everyone (3b).
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
- **`redirect`** → `vm = applyOverride(compiled, vm, directive)` (chunk-2, pure). Moves the *next-step* seed only; `current` is unchanged until the following `advance` re-emits onto the new location (the live gesture: point the baton, then downbeat). Redirect carries any directive — incl. `hold`/`release`/`resetJump`, which only touch counters/flags — so it must **never** auto-step (that would advance the playhead a bar on a pure counter change). D2.
- **`arm`** → validate the target first (Codex R3 MED): `!compiled.barPos.has(msg.payload.armed.directive.barId)` → `{ ignored }` (never store a marker that points at no bar — a poison pill that `commit` couldn't honor). Else `armed = msg.payload.armed`. (No VM change yet; advisory display.)
- **`disarm`** → `armed = null`. (D5.)
- **`commit`** → if `armed === null`, no-op (idempotent). **Defensive re-validation (Codex R3 MED):** if `!compiled.barPos.has(armed.directive.barId)` (a corrupt/stale target that slipped past arm — e.g. via a snapshot), **clear `armed` WITHOUT stepping** and stop. This is the crux of the finding: chunk 2 makes an unknown `jumpTo` a *no-op* (`roadmap-vm.ts:553`), so blindly `applyOverride`-then-`stepVM` on a bad target would advance one *normal* bar and clear armed — a silent wrong jump. Only with a valid target do we **"go now"** (D2, R2 HIGH): apply the armed jumpTo **and step once in the same message**, so the committed position is immediately visible to a mid-cue joiner — `vm = applyOverride(compiled, vm, armed.directive)`, then `const r = stepVM(compiled, vm); vm = r.state; if (r.transition) current = r.transition`, then `armed = null`. `current` becomes the **real emitted** target transition (a true 1-based `pass` from `stepVM`, never an invented `passCount ?? 0`); `vm` is seeded for the next `advance`. This satisfies the parent's "post-fire = committed cursor with `armed` cleared." (In a volta edge case `stepVM` may skip a pass-excluded target forward to the first reachable bar — the correct, roadmap-consistent landing.)
- **`clock`** → `clock = msg.payload.clock`. (Pure store; chunk 5 supplies it.)

### 3.3 Late-join / reconnect / gap recovery — one door

No event replay. Whenever a follower is **not converged** — a fresh join, a `needsSnapshot` seq gap, a higher-epoch baton claim, or a future epoch — it pulls the full `ConductorState` (3b delivers it; 3a just *is* the value) and resumes mirroring from it. The snapshot **resets the follower's `(epoch, seq)` baseline** to the MD's, so the very next in-order delta admits cleanly. Because the state carries `current` + `armed`, a mid-cue joiner sees both the live position and any pending change (§3.5 "why it must be state, not an event"). The reducer's job is only to *detect* the gap (`needsSnapshot`) and stay pure; the *fetch* is 3b's.

**Program-reload precondition (D10).** Before adopting a snapshot the follower checks `snapshot.programHash` against its **local** compiled program. If they differ (the MD is on a structure revision the follower hasn't loaded), the follower must **reload the SongStructure and recompile** *before* it can mirror — the numeric indices are meaningless otherwise. Within a live session this never happens (the session is pinned to one immutable `(songRef, programHash)`; a structure edit ends the session and everyone rejoins). This reload step is a 3b/loader concern; 3a only *names* the invariant via `programHash`.

---

## 4. Decisions for sign-off

- **D1 — Split 3a (pure reducer, build now) from 3b (transport, gated by §8.2-2).** Recommend YES: 3a is the natural pure-core next step and unblocks chunks 4-5 logic; 3b waits for the discovery/claim protocol. *(If you'd rather close §8.2-2 first and design 3a+3b together, say so.)*
- **D2 — `ConductorState.vm = VMState` (the resumable seed) + `current: TraversalStep | null` (the last EMITTED bar)** (supersede §6's illustrative `node: CanonicalRef` shape). Two facts forced this split (Codex HIGH-2, verified against `roadmap-vm.ts:379`): (a) `VMState.cursor` is the **next** position index, not the current bar — `stepVM` records `bars[cursor]` *then* advances — so deriving display from it shows late-joiners the wrong bar; (b) the field name `cursor: VMState` invited a `cursor.cursor` footgun. So: rename the field to `vm`, and store the bar the VM actually emitted in `current`. Display = `current` (no derivation from the next-step index). Recommend YES.
  - **RESOLVED (Codex R2 HIGH):** the redirect-vs-commit `current` question is now decided, not open. **`commit` = "go now":** it applies the armed jumpTo **and steps once** in the same reducer message, so `current` lands on the **real emitted** target (a true 1-based `pass` from `stepVM` — *not* the rejected `passCount ?? 0`), satisfying the parent's "post-fire = committed cursor, `armed` cleared" for mid-cue joiners. **`redirect` does NOT auto-step** — it carries arbitrary directives (`hold`/`release`/`resetJump` only touch counters), so `current` re-emits on the next `advance` (the immediate-yank-then-downbeat gesture). The asymmetry is intentional: commit fires a *telegraphed* marker that must leave a visible committed position; redirect is an instantaneous MD action paired with the MD's own next downbeat.
- **D3 — Envelope naming `ConductorMessage`/`ConductorPayload`; `redirect` wraps the chunk-2 `Directive`** (avoid the name collision). Recommend YES.
- **D4 — `claim` is the only epoch-raiser and a SNAPSHOT BOUNDARY, not a follower-applicable delta** (Codex R2 HIGH). A higher-epoch claim (`msg.epoch > state.epoch`, the relay-accepted value — never `state.epoch + 1`) → `{ needsSnapshot }`: the follower's local `vm`/`current` may be stale on the old epoch, so re-basing to `seq = 0` on top of it diverges permanently — the only safe baseline for a new baton is the new generation's full snapshot. Equal/lower-epoch claim → `{ ignored }` (replay no-op). The *new MD* mints the new generation **out of band** (accept-baton helper: `epoch+1`, `seq = 0`, `armed = null`, its **own** authoritative `vm`/`current`/`clock`), which the relay then serves as the snapshot (3b). Recommend YES (claim → needsSnapshot; MD-local mint).
- **D5 — Add a `disarm` directive** (MD cancels a telegraphed change before commit). Not in §6's set, but the change-marker UX needs "never mind." Recommend YES (cheap, obviously needed for chunk 4).
- **D6 — Only `jumpTo`-shaped changes are *armable*, carried as a directive not bare fields** — `Armed.directive: Extract<Directive, { kind: 'jumpTo' }>` (Codex LOW). `anotherRound`/`hold`/`release`/`resetJump` are *immediate* `redirect`s, not telegraphed. The directive-shaped envelope lets chunk 4 widen the armable set (e.g. telegraphed `anotherRound`) without touching commit semantics. *(Deferred to chunk 4, NOT an open chunk-3 decision: whether "one more time"/`anotherRound` should also be armable — musically you do signal it early; the directive shape already accommodates it.)* Recommend: ship 3a jumpTo-only armed.
- **D7 — The reducer returns `ReduceOutcome` (`applied` / `ignored` / `needsSnapshot`), not bare `ConductorState`** (Codex HIGH-1/HIGH-3, MED-1). This is the root fix: a pure delta reducer must be able to tell transport "I am behind — pull a snapshot," or a single dropped message diverges the follower forever. `needsSnapshot` unifies seq-gap, missed-claim, and future-epoch recovery into the one late-join door (§3.3). Recommend YES.
- **D8 — Add an `advance` payload** — the only message that calls chunk-2 `stepVM` and moves `current` (Codex HIGH-2b). Without it the shared VM can only be *redirected*, never progress bar-to-bar normally. It is an ordinary `(epoch, seq)` delta (idempotent, contiguity-gated) and the primary live message. Recommend YES.
- **D9 — Envelope is self-*scoping* (not self-authenticating — Codex R2 LOW): `sessionId` + `songRef` + `programHash` (fail-closed scope, MED-1/D10) and `sentAt` (the ONLY time source, MED-2).** Scoping fails closed on a cross-room / cross-revision / replayed message, but it is **not authentication** — the reducer still trusts that 3b filtered senders; **sender authenticity remains a relay responsibility.** The reducer copies `sentAt → updatedAt` so followers converge byte-for-byte; it never reads a local clock. Recommend YES.
- **D10 — Pin the exact compiled program with `programHash` on state + envelope; fail closed on any mismatch** (Codex R3 HIGH). `vm.cursor` is a numeric index into `compiled.bars` and every counter/`fired` flag keys to *that* roadmap, so `songRef` (song identity) is not enough — a structure revision under the same song silently remaps every index. `programHash = hash(ordered bar ids + roadmap markers)`, loader-computed alongside `compiled`. A session is bound to an **immutable `(songRef, programHash)`**; a cross-revision message → `{ ignored }` (§3.1.1); a structure edit ends the session (everyone rejoins) rather than mutating the program live. Snapshot adoption verifies `programHash` and reloads the SongStructure first if it differs (§3.3, a 3b/loader step). Recommend YES.

---

## 5. Test plan (3a, pure)

Every assertion is on the `ReduceOutcome.status` AND the resulting state (D7).

- **Outcome discrimination:** in-order delta → `applied`; duplicate/lower seq → `ignored` + unchanged; **seq gap (`seq > state.seq+1`) → `needsSnapshot` + unchanged** (HIGH-1 regression test); stale epoch → `ignored`; **future non-claim epoch → `needsSnapshot`** (HIGH-3); session/song mismatch → `ignored` (MED-1).
- **Program pin (R3 HIGH/D10):** `msg.programHash !== state.programHash` → `{ ignored }`, state unchanged (a same-`songRef` message from a different roadmap revision must NOT touch the numeric indices); harness asserts the local `programHash` argument equals `state.programHash`.
- **Corrupt armed target (R3 MED):** `arm` with a `barId` not in `compiled.barPos` → `{ ignored }` (poison pill never stored); `commit` with an armed target that is invalid (injected via snapshot) → `armed` cleared, **`vm`/`current` UNCHANGED, no stepVM** (regression: must NOT advance one normal bar via the chunk-2 unknown-jumpTo no-op).
- **Contiguity (HIGH-1):** apply seq 1,2,**4** → the 4 is `needsSnapshot` and state stays at seq 2; then snapshot-reset to MD state + seq 3,4 converges. Prove the pre-fix bug is gone: arm(2) dropped, commit(3) must NOT silently no-op-then-advance past the lost arm.
- **Claim = snapshot boundary (R2 HIGH/D4):** higher-epoch claim → **`needsSnapshot`, state UNCHANGED** (NOT applied — regression test for the stale-VM divergence: a follower behind on the old epoch must NOT re-base to seq 0 on its own stale `vm`); **equal/lower-epoch claim → `ignored`, epoch NOT bumped** (replay-bump regression); post-snapshot the follower converges on the new generation.
- **advance (HIGH-2/D8):** N advances over a known roadmap → `current` equals the chunk-2 `stepVM` transition stream bar-for-bar; `current` is the EMITTED bar (not `vm.cursor`'s next index); song-end advance → no `current` change, `vm.done` true; idempotent under repeated seq.
- **redirect:** wraps each chunk-2 directive (anotherRound/hold/release/jumpTo/resetJump) → `vm` matches a direct `applyOverride` (equivalence net); `current` unchanged + NO auto-step, even for jumpTo (re-emits on the next advance — D2).
- **arm/commit/disarm (R2 HIGH/D2):** arm sets armed; **commit applies `armed.directive` AND steps once → `current` = the real emitted target (1-based `pass` from `stepVM`, never `passCount ?? 0`), `armed` cleared, `vm` seeded for next advance** (mid-cue-joiner sees the committed position); commit with nothing armed = no-op; disarm clears; double-commit = idempotent; volta-edge commit lands on the first reachable bar.
- **clock:** stored verbatim; ordering still governed by seq.
- **Determinism (MED-2):** two reducers fed identical messages produce byte-identical state incl. `updatedAt` (= `sentAt`); the reducer reads no local clock.
- **Purity:** reducer never mutates the input state (JSON-snapshot guard, mirroring the chunk-2 purity tests).
- **Late-join = gap recovery (one door):** a fresh mirror fed a snapshot + subsequent in-order messages ends at the same state as one that saw the whole stream; a `needsSnapshot` follower re-based on a snapshot converges identically.

---

## 6. What this unblocks

- **Chunk 4** (change-marker UI + gated auto-fire) consumes `arm`/`commit`/`disarm` + the `armed` field directly.
- **Chunk 5** (clock) consumes the `clock` directive + field.
- **3b** (transport) wraps this reducer behind the relay once §8.2-2 (discovery + claim protocol) is designed.
