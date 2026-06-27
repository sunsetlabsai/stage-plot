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
  type Armed, type ReduceOutcome, reduceConductor,
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
// VM seeded at the song head, nothing armed, and the canonical CLOCK-ABSENT value
// `{ tempoBpm: null, confidence: 0 }` (ConductorState.clock is REQUIRED, not optional —
// chunk-3 models absence, not undefined; chunk 5 fills it). claim / snapshot are 3b
// concerns and never arise on one device (the MD always holds the baton). `now` is
// injected (determinism; mirrors chunk-3's sentAt-is-the-only-clock).
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
  + 1`, `epoch = state.epoch`, `sentAt = now`. The MD applies its own contiguous deltas,
  so no `needsSnapshot` path exists on one device. Two distinct invalid-payload behaviors,
  and the UI must respect the difference:
  - **`arm` / `commit` self-validate** (chunk-3 reducer:227, :237 check `compiled.barPos`):
    an `arm` at a non-existent bar → `ignored`, state UNCHANGED — surfaced to the UI as a
    disabled control.
  - **`redirect` is ALWAYS admitted** (`applied`) and **burns a seq even when it no-ops**
    (reducer:221 applies `applyOverride` unconditionally; `applyOverride` silently no-ops an
    unknown `repeatStartId`/`jumpId`/`barId` — roadmap-vm.ts:535/538/554). The reducer does
    NOT validate redirect targets. **Therefore redirect validity is the UI's job:** the
    immediate-redirect controls (§5) MUST enumerate only the live program's real repeat/jump
    targets and disable an inapplicable `release`/`resetJump`, so the MD can never fire a
    silent seq-burning no-op. (This is why open-Q (b) resolves to *target-constrained*.)
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
enumerable set of canonical positions in the MD's program (parent locked decision:
"redirect = jump to an EXISTING node; overlay, never edit"). No free-form bar entry, no
inventing a node.

**Input — `compiled` is NOT enough (Codex R1 Block).** `CompiledRoadmap.bars` is only
`{ id: string }[]` (roadmap-vm.ts:48); it carries NO section labels. Section identity
lives on `Bar.sectionId` (types.ts) → `CanonicalSection.label` (song-structure.ts:24).
So a "section head by label + ordinal" target is unreachable from `compiled` alone —
`armableTargets` MUST also receive the source bars (sectionId-bearing) and the ordered
sections. The loader already has both alongside `compiled` (it compiled them).

```ts
// lib/conductor-targets.ts
export interface JumpTarget {
  barId: string;             // the Armed.directive.barId
  label: string;             // human label for the picker + telegraph badge
  kind: 'segno' | 'coda' | 'fine' | 'section' | 'repeatStart' | 'bar';
}

// Enumerate legal jumpTo targets. Needs the SOURCE structure, not just `compiled`:
//   bars     — sectionId-bearing (types.ts Bar), to map a section to its HEAD bar
//   sections — ordered { id, label } (CanonicalSection), for the label + ordinal
//   markers  — the roadmap, for segno/coda/fine + repeatStart landmarks
// `compiled.barPos` is still the validity oracle (every emitted target is a present bar).
export function armableTargets(
  compiled: CompiledRoadmap,
  source: { bars: Bar[]; sections: { id: string; label: string }[]; markers: RoadmapMarker[] },
): JumpTarget[];
```

- **Named landmarks first** (the calls an MD actually makes): Coda, Segno, Fine (from
  `markers`), then **section heads** — each section's first bar in reading order, labelled
  by `CanonicalSection.label` + ordinal among same-`normalizeLabel` sections (chunk-1
  `sectionOrdinals` vocabulary, song-structure.ts:117) — then repeat starts. Plain bars are
  available but de-emphasized (a bar number is the fallback, not the call — parent §locked
  "bar number = label + fine fallback ONLY"). A linear/section-less chart yields bar targets
  only (no crash on absent sections).
- **`exit` policy is TARGET-aware, not just program-aware (Codex R1 Low).** A jumpTo MAY
  carry `exit?: alCoda | alFine` (chunk-2 `ExitPolicy`). Offer `alCoda` only when the
  program has a To-Coda AND the selected target sits at/before that To-Coda trigger (else
  the exit is inert/surprising); `alFine` likewise relative to the Fine bar. Position is
  read from `compiled.barPos` / `compiled.toCodaAt` / `compiled.fineAt`. Default = no exit.
- **Validity is enforced at BOTH ends.** The picker only offers `compiled.barPos`-present
  targets; `arm` re-checks (chunk-3 reducer:227) and the controller surfaces an `ignored`
  as a disabled control. Defense in depth, no new reducer path.

## 3. `fireAt` + the telegraph overlay

`Armed.fireAt` is a `barId` — the position the change-pending badge sits at, and (chunk
5) the auto-fire trigger bar. In the **go-tap** world of chunk 4 it is **advisory display
only**: the MD taps Go to commit regardless of where the playhead is. So fireAt never
gates anything this chunk — it only places the badge.

- **Default fireAt = the MD's current bar's *next* bar** (`compiled.bars[vm.cursor]` —
  recall `vm.cursor` is the NEXT index, chunk-3 D2), i.e. "the change lands at the next
  downbeat," the natural telegraph. **End-of-song guard (Codex R1 Medium):** when
  `vm.done` or `vm.cursor >= compiled.bars.length` there is no next bar, so there is no
  valid default fireAt — the Arm affordance is **disabled** at song end (a jumpTo off the
  end of the song is meaningless, and `armed.fireAt` is a raw string the reducer does not
  position-validate). The MD MAY re-place fireAt by tapping another **real** bar (any
  `compiled.barPos`-present id); the re-tap target is validated the same way.
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
by implementing one predicate — **no dead auto-fire code ships now.** For the seam to
genuinely unblock chunk 5 without an API change, the **evaluation contract is pinned now**
(Codex R1 Medium), even though the body is `false`:

- **Evaluated POST-advance, on the just-updated session.** The hook calls `shouldAutoFire`
  *after* an `advance` has stepped the VM and updated `current` — never pre-step — so the
  decision reads the bar the playhead actually landed on.
- **The match is `current.barId === armed.fireAt`** (the playhead reached the telegraphed
  fire bar) AND `armed !== null`. No clock/confidence inputs are consulted in chunk 4; chunk
  5 ANDs the §3.5 gate (clock present, bars-since-anchor bound, confidence high, no
  unresolved hold) onto that same predicate.
- **Return = "the hook should now `dispatch({ kind: 'commit' })`."** `true` does NOT itself
  mutate state — it tells the hook to issue exactly ONE additional `commit` message (its own
  seq), so auto-fire flows through the identical reducer path as a go-tap. A normal advance
  with no match returns `false` and dispatches nothing extra (no spurious commit). Because
  `commit` clears `armed`, the predicate cannot re-fire on a later bar.

```ts
// lib/conductor-session.ts
// Chunk 4: always false (go-tap only). Chunk 5 replaces the body with the §3.5 gate;
// the SIGNATURE + the post-advance / fireAt-match / "hook should commit" contract above
// are fixed now so chunk 5 changes one function body, not the API.
export function shouldAutoFire(session: ConductorSession): boolean {
  return false; // go-tap is the floor; auto-fire is a chunk-5, clock-gated luxury
}
```

The hook calls `shouldAutoFire` after each `advance`; while it returns `false` only the
explicit Go button commits, and an advance never injects a commit. The MD override (manual
Go / disarm) stays live regardless — parent §3.5 "with an MD override always live."

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
viewer), shown **only to the MD**. The interim gate is `isOwner`, but **UI copy + state
label it "Local MD mode" (Codex R1 (c))** — it drives only this device's local session and
must NOT imply relay authority over other players (there is no transport until 3b).

- **Transport readout** — the current bar + pass ordinal (the scaffolding at page.tsx:103
  already computes pass ordinals), plus a primary **Advance** control (tap = next bar).
  The redline renders `current` via the existing SectionMarker/redline path.
- **Change-marker controls** — an **Arm** affordance opening the §2 target picker (disabled
  at song end per §3), plus, while armed, the §3 telegraph badge and a prominent **Go**
  (commit) / **Cancel** (disarm).
- **Immediate-redirect controls are TARGET-CONSTRAINED (Codex R1 Medium / open-Q b).**
  anotherRound / hold / release / resetJump call `redirect` directly (no telegraph), but —
  because the reducer admits and seq-burns an invalid redirect (§1) — these controls
  enumerate ONLY the live program's real repeat/jump targets (`compiled.repeatStartById` /
  jump markers) and **disable an inapplicable `release`/`resetJump`** (e.g. release when not
  holding, resetJump for a not-yet-fired jump). No control can fire a silent no-op.
- **Non-MD / no-session:** Perform renders exactly as today (zero change for followers
  this chunk; the telegraph is single-device until 3b).

## 6. Decisions (recommend YES unless noted)

- **D1 — Pure lib core, React hook is a thin binding.** `lib/conductor-session.ts`
  (`initSession` / `dispatch` / `shouldAutoFire`) + `lib/conductor-targets.ts`
  (`armableTargets`, which needs the source `{ bars, sections, markers }` so it lives apart
  from the session state). Keeps the live logic in the lib gate (no jsdom), mirrors chunks
  1-3. Recommend YES.
- **D2 — The MD is its own relay on one device: `dispatch` = mint → `reduceConductor` →
  loopback.** This loopback is the explicit 3b seam (swap "keep locally" for "broadcast +
  apply"); message contract + reducer untouched. Recommend YES.
- **D3 — `dispatch` is the sole seq-issuer** (`seq+1`, `epoch` held, `sentAt = now`
  injected). Single-device never produces `needsSnapshot`. Two invalid-payload behaviors
  (§1): `arm`/`commit` self-validate → `ignored` → disabled control; `redirect` always
  admits + burns seq, so redirect validity is UI-enforced via target enumeration. Recommend
  YES.
- **D4 — Armable = jumpTo only (carry D6); `armableTargets(compiled, { bars, sections,
  markers })` (Codex R1 Block — section labels need the SOURCE structure, not `compiled`),
  named landmarks first, plain bars de-emphasized; `exit` offered TARGET-aware (target
  at/before the To-Coda/Fine trigger), not merely program-aware.** No free-form bar entry.
  Recommend YES.
- **D5 — `fireAt` = advisory display only this chunk; default to the next bar (disabled at
  song end — §3 guard), optional re-tap to any real bar.** Precise placement earns its keep
  in chunk 5 when auto-fire makes the bar a trigger. Recommend YES (keep re-tap — Codex (a)
  concurs, gated on the validated bar source the Block fix provides + song-end disable).
- **D6 — `shouldAutoFire` ships hard-`false`; the seam is the only auto-fire surface, with
  its evaluation contract pinned now (post-advance, `current.barId === armed.fireAt`, return
  = "hook should commit once").** Chunk 5 replaces only the body. Recommend YES.
- **D7 — Telegraph is ephemeral overlay-only (lives in `state.armed`, never in
  `calibration.roadmap`); MD-only surface, interim gate `isOwner` but labelled "Local MD
  mode"** so it never implies relay authority before 3b (Codex (c)). Honors the
  never-write-back boundary. Recommend YES.

**Open Qs — resolved with Codex R1, no open chunk-4 decisions remain:** (a) keep `fireAt`
re-tap — adopted, now safe given the Block fix's validated bar source + song-end disable;
(b) surface immediate redirects now BUT target-constrained (enumerate valid targets, disable
inapplicable release/resetJump) — adopted, since "free" was untrue while invalid redirects
silently burn seq; (c) `isOwner` is an acceptable interim gate, labelled "Local MD mode" in
copy + state — adopted.

## 7. Test plan (pure controller — the gate stays lib-tested)

All assertions on `lib/conductor-session.ts` + `lib/conductor-targets.ts` (no jsdom); the
hook is a thin binding.

- **initSession:** epoch 0, seq 0, `vm = initVM`, `current = null`, `armed = null`,
  `clock = { tempoBpm: null, confidence: 0 }` (the canonical clock-ABSENT value — `clock`
  is required, not optional); `programHash` threaded; `updatedAt = now`.
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
- **armableTargets:** given `{ bars, sections, markers }`, **section-head targets carry the
  `CanonicalSection.label` + ordinal** and point at the section's first bar (the Block
  regression — a `compiled`-only enumeration could not produce these); named landmarks
  first; a To-Coda/Fine program offers `exit` ONLY when the target sits at/before the
  trigger (target-aware, not program-aware); a linear/section-less program yields bar
  targets only with no crash.
- **fireAt song-end guard:** at `vm.done` (or `cursor >= bars.length`) there is no default
  fireAt and arm is disabled (the controller/helper reports "no armable position").
- **shouldAutoFire:** returns `false` for every session (chunk-4 invariant — a guard test so
  chunk 5's change is visible and intentional). Contract test: an `advance` that lands
  `current.barId === armed.fireAt` still injects NO commit in chunk 4 (go-tap only), and the
  helper is evaluated post-advance.
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
