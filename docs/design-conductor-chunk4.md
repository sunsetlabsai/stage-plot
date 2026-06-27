# Conductor Authority — Chunk 4: the change-marker UI + go-tap commit

**Design-only.** This spec builds the MD's live control surface over the chunk-3
pure reducer (`lib/conductor-state.ts`, shipped to main `5a958f0`). Review the
spec; do NOT build until Graham's explicit GO. Codex review first.

Parent: `design-conductor-authority.md` §3.5 (the change marker — telegraph + fire,
auto-fire gated) and §10 build outline step 4. Consumes chunk-3 `arm` / `commit` /
`disarm` payloads + the `armed` field directly (chunk-3 doc §6).

## 0. Scope — the three cuts (Graham-confirmed)

The §3.5 vision is "place/arm/telegraph on **all** charts; go-tap default, gated
auto-fire." Two of those words depend on chunks that aren't built. The confirmed cut:

1. **Single-device now; "all charts" deferred to 3b.** Chunk 4 is the **MD-side UI
   driving the local chunk-3 reducer** + rendering the armed overlay on the MD's own
   chart. Cross-device broadcast (the telegraph lighting up on every follower) is 3b
   transport, still gated on the undesigned §8.2-2 discovery/claim protocol. The MD
   experience is fully demonstrable solo; followers light up unchanged when 3b lands.
2. **Go-tap commit only; auto-fire structured but OFF until chunk 5.** §3.5: "MD
   go-tap = the default and the floor." Auto-fire needs the position-confidence gate
   (clock present + confidence + no unresolved hold) — chunk 5. Chunk 4 ships go-tap
   and lays a clean **seam** for the gate, but never fires automatically.
3. **jumpTo-only armable (carry chunk-3 D6 forward).** `Armed.directive` stays
   `Extract<Directive, { kind: 'jumpTo' }>`. Telegraphed `anotherRound` ("one more
   time") is a deliberate fast-follow, not this chunk; the directive-shaped envelope
   already accommodates it without touching commit semantics.

**Boundary, restated:** arm/commit data + reducer = chunk 3 (done). Change-marker UI +
go-tap = chunk 4 (this doc). Clock detection + auto-fire enablement = chunk 5. Multi-
device telegraph = 3b. Chunk 4 introduces **zero** new wire types and **zero** changes
to `lib/conductor-state.ts` — it is a consumer.

## 1. The session controller — `lib/conductor-session.ts` (pure, the testable core)

Following the chunk-1/2/3 "pure first" pattern, the live logic lives in a pure module;
the React hook (§5) is a thin binding. The MD is a **single writer**, so on one device
it is also its own relay: it mints a message, applies it through `reduceConductor`, and
renders the result. That mint+loopback is the seam 3b replaces with the real fan-out.

```ts
// lib/conductor-session.ts
import {
  type ConductorState, type ConductorMessage, type ConductorPayload,
  type Armed, reduceConductor,
} from './conductor-state';
import { type CompiledRoadmap, type VMState, initVM } from './roadmap-vm';

// Everything the controller needs to mint + apply a message, with no React and no
// network. `compiled` + `programHash` are the loader-pinned program (chunk-3 D10).
export interface ConductorSession {
  state: ConductorState;
  compiled: CompiledRoadmap;
  programHash: string;
}

// Initialize the MD's own session for a chart. Single-device: epoch 0, seq 0, the
// VM seeded at the song head, nothing armed, no clock (chunk 5 fills it). claim /
// snapshot are 3b concerns and never arise on one device (the MD always holds the
// baton). `now` is injected (determinism; mirrors chunk-3's sentAt-is-the-only-clock).
export function initSession(
  sessionId: string, songRef: string, programHash: string,
  compiled: CompiledRoadmap, now: number,
): ConductorSession;

// The MD's intent verbs — the ONLY way the UI mutates the session. Each stamps the
// next (epoch, seq) + sentAt, builds the ConductorMessage, and loops it through
// reduceConductor. Returns the new session (state replaced on `applied`; UNCHANGED on
// `ignored` — e.g. an arm at a bar the program doesn't have). `now` injected per call.
export function dispatch(
  session: ConductorSession, payload: ConductorPayload, now: number,
): { session: ConductorSession; outcome: ReduceOutcome['status'] };
```

- **Single-writer seq discipline.** `dispatch` is the sole seq-issuer: `seq = state.seq
  + 1`, `epoch = state.epoch`, `sentAt = now`. Because the MD applies its own contiguous
  deltas, the reducer always admits (`applied`) unless the payload is self-invalid (an
  `arm`/`commit` at a non-existent bar → `ignored`, surfaced to the UI as a no-op so the
  control can disable itself). No `needsSnapshot` path exists on one device.
- **Loopback IS the transport seam.** `dispatch` = mint → `reduceConductor` → keep the
  new state. 3b swaps "keep locally" for "broadcast to the relay + apply locally"; the
  message contract and the reducer are untouched. This is the explicit hand-off point.
- **Why a pure controller, not just a hook:** the seq/sentAt minting, the loopback, and
  the verb→payload mapping are all unit-testable in the lib gate (no jsdom). The hook
  becomes a ~30-line `useReducer` binding with nothing worth testing.

### 1.1 The verb surface the UI calls (thin wrappers over `dispatch`)

| MD verb | payload | effect (via chunk-3 reducer) |
|---|---|---|
| `advance()` | `{ kind: 'advance' }` | playhead steps one bar; `current` = emitted bar |
| `redirect(d)` | `{ kind: 'redirect', directive }` | immediate VM redirect (anotherRound/hold/release/jumpTo/resetJump) — NOT telegraphed |
| `arm(target)` | `{ kind: 'arm', armed }` | drop the telegraphed change marker |
| `commit()` | `{ kind: 'commit' }` | go-tap: fire the armed jumpTo + step once |
| `disarm()` | `{ kind: 'disarm' }` | "never mind" — clear the marker |

`redirect` (immediate) vs `arm`→`commit` (telegraphed) is the §3.5 distinction: a
telegraphed change shows "pending → X" and waits for the go-tap; an immediate redirect
is the instant yank paired with the MD's own downbeat. Both already exist in chunk 3;
chunk 4 only surfaces them.

## 2. The armable target model — the picker

Per cut #3 the only **armable** change is a `jumpTo`. Its legal targets are the finite,
enumerable set of canonical positions in the MD's compiled program (parent locked
decision: "redirect = jump to an EXISTING node; overlay, never edit"). The picker
enumerates them from `compiled` — no free-form bar entry, no inventing a node.

```ts
// lib/conductor-session.ts (or a small lib/conductor-targets.ts)
export interface JumpTarget {
  barId: string;             // the Armed.directive.barId
  label: string;             // human label for the picker + telegraph badge
  kind: 'segno' | 'coda' | 'fine' | 'section' | 'repeatStart' | 'bar';
}

// Enumerate the legal jumpTo targets, named-markers first then section/bar heads.
export function armableTargets(compiled: CompiledRoadmap, markers: RoadmapMarker[]): JumpTarget[];
```

- **Named landmarks first** (the calls an MD actually makes): Coda, Segno, Fine, then
  section heads (by label + ordinal, the chunk-1 `normalizeLabel` vocabulary), then
  repeat starts. Plain bars are available but de-emphasized (a bar number is the
  fallback, not the call — parent §locked "bar number = label + fine fallback ONLY").
- **`exit` policy:** a jumpTo MAY carry `exit?: alCoda | alFine` (chunk-2 `ExitPolicy`).
  The picker offers it only on a To-Coda / Fine-bearing program (the same gating
  `compiled.toCodaAt` / `compiled.fineAt` already encode). Default = no exit.
- **Validity is the reducer's job, not the picker's.** The picker only offers
  `compiled.barPos`-present targets; `arm` re-checks (chunk-3 reducer line 227) and the
  controller surfaces an `ignored` as a disabled control. Defense in depth, no new path.

## 3. `fireAt` + the telegraph overlay

`Armed.fireAt` is a `barId` — the position the change-pending badge sits at, and (chunk
5) the auto-fire trigger bar. In the **go-tap** world of chunk 4 it is **advisory display
only**: the MD taps Go to commit regardless of where the playhead is. So fireAt never
gates anything this chunk — it only places the badge.

- **Default fireAt = the MD's current bar's *next* bar** (`compiled.bars[vm.cursor]` —
  recall `vm.cursor` is the NEXT index, chunk-3 D2), i.e. "the change lands at the next
  downbeat," the natural telegraph. The MD MAY re-place it by tapping another bar; chunk
  4 keeps this minimal (default + optional re-tap), since precise placement only earns
  its keep once auto-fire (chunk 5) makes the bar meaningful.
- **Telegraph render:** an **ephemeral, overlay-only** badge — "**→ {target.label}**" (e.g.
  "→ Coda") near `fireAt`, reusing the `RoadmapOverlayLayer` / `SectionMarker` visual
  vocabulary (page.tsx:1900, :1656) so it reads native. **Never persisted** — honors the
  parent boundary ("ephemeral by default; no write-back path from live state"). It lives
  in `ConductorState.armed`, not in the chart's `calibration.roadmap`.
- **Commit feedback:** on go-tap the badge clears and the redline lands on the committed
  bar (`current` = the real emitted target, chunk-3 D2). On disarm it clears with no move.

## 4. The auto-fire seam (defined, stubbed OFF)

§3.5's auto-fire is "allowed only behind a position-confidence gate." That gate's inputs
(clock present, bars-since-anchor bound, confidence, no unresolved hold) are chunk-5
data. Chunk 4 defines the seam and wires it to a constant `false`, so chunk 5 turns it on
by implementing one predicate — **no dead auto-fire code ships now.**

```ts
// lib/conductor-session.ts
// Chunk 4: always false (go-tap only). Chunk 5 implements the §3.5 confidence gate.
export function shouldAutoFire(session: ConductorSession): boolean {
  return false; // go-tap is the floor; auto-fire is a chunk-5, clock-gated luxury
}
```

The hook calls `shouldAutoFire` on each `advance`; while it returns `false` only the
explicit Go button commits. The MD override (manual Go / disarm) stays live regardless —
parent §3.5 "with an MD override always live."

## 5. React binding — `useConductorSession` + the Perform transport surface

A thin hook wraps the pure controller; all logic that matters lives in §1.

```ts
// in app/[owner]/[show]/page.tsx (or a colocated hook file)
function useConductorSession(args): {
  state: ConductorState;
  current: TraversalStep | null;        // = state.current, the bar to redline
  armed: Armed | null;
  targets: JumpTarget[];
  advance: () => void;
  redirect: (d: Directive) => void;
  arm: (t: JumpTarget, exit?: ExitPolicy) => void;
  commit: () => void;
  disarm: () => void;
};
```

UI surface, additive to the existing Perform tab (page.tsx PerformTab / the chart
viewer), shown **only to the MD** (`isOwner` for now; a real baton-holder check is 3b):

- **Transport readout** — the current bar + pass ordinal (the scaffolding at page.tsx:103
  already computes pass ordinals), plus a primary **Advance** control (tap = next bar).
  The redline renders `current` via the existing SectionMarker/redline path.
- **Change-marker controls** — an **Arm** affordance opening the §2 target picker; while
  armed, the §3 telegraph badge plus a prominent **Go** (commit) and **Cancel** (disarm).
  Immediate redirects (anotherRound / hold / release) are secondary controls that call
  `redirect` directly (no telegraph) — surfacing chunk-3 capability, not new logic.
- **Non-MD / no-session:** Perform renders exactly as today (zero change for followers
  this chunk; the telegraph is single-device until 3b).

## 6. Decisions (recommend YES unless noted)

- **D1 — Pure `lib/conductor-session.ts` controller (`initSession` / `dispatch` /
  `armableTargets` / `shouldAutoFire`), React hook is a thin binding.** Keeps the live
  logic in the lib gate (no jsdom), mirrors chunks 1-3. Recommend YES.
- **D2 — The MD is its own relay on one device: `dispatch` = mint → `reduceConductor` →
  loopback.** This loopback is the explicit 3b seam (swap "keep locally" for "broadcast +
  apply"); message contract + reducer untouched. Recommend YES.
- **D3 — `dispatch` is the sole seq-issuer** (`seq+1`, `epoch` held, `sentAt = now`
  injected). Single-device never produces `needsSnapshot`; a self-invalid `arm`/`commit`
  → `ignored`, surfaced as a disabled control. Recommend YES.
- **D4 — Armable = jumpTo only (carry D6); picker enumerates `armableTargets` from
  `compiled`, named landmarks first, plain bars de-emphasized; `exit` offered only on a
  To-Coda/Fine program.** No free-form bar entry. Recommend YES.
- **D5 — `fireAt` = advisory display only this chunk; default to the next bar, optional
  re-tap.** Precise placement earns its keep in chunk 5 when auto-fire makes the bar a
  trigger. Recommend YES (minimal now). *(Alt: skip re-tap entirely, fireAt always = next
  bar. Lighter, but loses the MD's "telegraph two bars out" gesture — I lean keep-re-tap.)*
- **D6 — `shouldAutoFire` ships hard-`false`; the seam is the only auto-fire surface.**
  Chunk 5 implements the §3.5 gate by replacing the body; MD override always live.
  Recommend YES.
- **D7 — Telegraph is ephemeral overlay-only (lives in `state.armed`, never in
  `calibration.roadmap`), MD-only surface gated on `isOwner` for now** (real baton check
  = 3b). Honors the never-write-back boundary. Recommend YES.

**Open for Codex/Graham:** (a) D5 re-tap vs next-bar-only; (b) whether immediate
redirects (anotherRound/hold/release) belong in chunk 4's surface at all or defer with
their UI to the armable-anotherRound fast-follow — I lean **surface them now** (they're
free, already in chunk 3, and the MD needs "one more time" live); (c) is `isOwner` an
acceptable interim MD gate, or do we want a no-op "I am MD" local toggle to avoid implying
multi-device authority before 3b.

## 7. Test plan (pure controller — the gate stays lib-tested)

All assertions on `lib/conductor-session.ts` (no jsdom); the hook is a thin binding.

- **initSession:** epoch 0, seq 0, `vm = initVM`, `current = null`, `armed = null`,
  `clock` absent; `programHash` threaded; `updatedAt = now`.
- **dispatch seq discipline:** each verb bumps `seq` by exactly 1, holds `epoch`, stamps
  `sentAt = now`; N dispatches → `state.seq === N`. Determinism: same verbs + same `now`s
  → byte-identical state (no local clock read).
- **advance:** `current` tracks the chunk-2 `stepVM` stream bar-for-bar; song-end advance
  → `current` unchanged, `vm.done` true.
- **arm → commit (go-tap):** arm sets `armed`; commit clears it AND `current` = the real
  emitted jumpTo target (1-based pass); commit with nothing armed = no-op; double-commit
  idempotent. (Re-asserts the chunk-3 contract through the controller.)
- **disarm:** clears `armed`, `current`/`vm` unchanged.
- **self-invalid arm/commit:** `arm` at a bar not in `compiled.barPos` → outcome
  `ignored`, session UNCHANGED (the UI disables the control); commit on a corrupt armed
  target (injected) → `armed` cleared, no step.
- **armableTargets:** enumerates exactly the present landmarks + section/repeat/bar heads;
  named landmarks first; a To-Coda/Fine program offers `exit`, a plain one does not; a
  linear (markerless) program yields bar targets only.
- **shouldAutoFire:** returns `false` for every session (chunk-4 invariant — a guard test
  so chunk 5's change is visible and intentional).
- **redirect equivalence:** `redirect(d)` yields a `vm` equal to a direct chunk-2
  `applyOverride` (the controller adds nothing but seq/sentAt).

Target: a `tests/conductor-session.test.ts` companion (~20 assertions), gate green,
test-count delta reported on the build PR.

## 8. What this unblocks / what it does NOT do

- **Unblocks:** chunk 5 (clock) — implements `shouldAutoFire`'s body + feeds the `clock`
  directive through `dispatch`; the §3.5 gate has a home. Linkage step 6 may slot around
  here per the locked sequence (confirm with Graham).
- **Explicitly NOT in chunk 4:** any network / relay (3b); multi-device telegraph;
  auto-fire enablement; armable `anotherRound`; persisting an arrangement variant
  (deliberate separate owner action, never from live state). These stay gated where the
  parent put them.
