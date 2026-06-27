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

1. **Single-device, LOCAL-ID controller now; multi-device deferred to 3b.** Chunk 4 is the
   **MD-side UI driving the local chunk-3 reducer** + rendering the armed overlay on the MD's
   own chart. It operates entirely in the MD's **local chart id-space** (see D0). Cross-device
   broadcast is 3b — and **3b is NOT merely a transport swap (Codex R3 High-1):** because the
   state carries local `Bar` ids, another player's chart cannot consume those messages
   directly. 3b must add the **canonical translation boundary** the parent already mandates
   ("wire carries a `StructuralRef`; each frontend resolves to local coords" — the chunk-1
   `SongStructure`/`resolveRef` machinery). So the loopback (D2) is an honest seam for the
   *single-device state flow*, but the multi-device story needs transport **plus** local↔
   canonical translation, not transport alone.
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

**Identity layer (Codex R2 Block — pinned up front):** chunk 4, being single-device, runs
entirely on the MD's **local `ChartCalibration`** (local `Bar` / `SectionAnchor` ids — what
`compileRoadmap` already consumes). The **canonical** `SongStructure` layer is the chunk-1
**cross-chart** bridge and is a **3b** concern (resolving a `StructuralRef` to a *different*
follower's coords). Chunk 4 never crosses into the canonical namespace. See §2.

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
    NOT validate redirect targets. **Therefore redirect validity is enforced in the PURE layer,
    not the UI (Codex R3 Low / R2 High-2):** the pure `availableRedirects(compiled, vm)`
    enumerator (§5) is the single source of *applicable* redirects — it omits an inapplicable
    `release`/`resetJump`/held-repeat `hold`, the hook can render nothing else, and it is
    unit-tested. The MD can never fire a silent seq-burning no-op. (This is why open-Q (b)
    resolves to *target-constrained*.)
- **Loopback IS the single-device state seam (Codex R3 High-1 — scoped honestly).**
  `dispatch` = mint → `reduceConductor` → keep the new state. On one device 3b swaps "keep
  locally" for "broadcast + apply locally" with the **same** message contract and reducer.
  But that swap alone does NOT make followers consume these messages: the state carries
  LOCAL `Bar` ids, so 3b additionally needs the canonical translation boundary (§0.1 /
  parent "wire carries `StructuralRef`"). So the loopback is the genuine hand-off point for
  *this device's* state propagation — not a complete multi-device solution by itself.
- **Why a pure controller, not just a hook:** the seq/sentAt minting, the loopback, and
  the verb→payload mapping are all unit-testable in the lib gate (no jsdom). The hook
  becomes a ~30-line `useReducer` binding with nothing worth testing.

### 1.1 The verb surface the UI calls (thin wrappers over `dispatch`)

| MD verb | payload | effect (via chunk-3 reducer) |
|---|---|---|
| `advance()` | `{ kind: 'advance' }` | playhead steps one bar; `current` = emitted bar |
| `redirect(opt)` | `{ kind: 'redirect', directive }` | immediate VM redirect — NOT telegraphed. The chunk-3 reducer accepts any `Directive` (incl. `jumpTo`), but the chunk-4 hook exposes ONLY the `availableRedirects` set (anotherRound/hold/release/resetJump). `jumpTo` is the ARMABLE path (§2), never an immediate-redirect button (Codex R3 Med). |
| `arm(target, exit?)` | `{ kind: 'arm', armed }` | drop the telegraphed change marker; `exit` is re-checked against `target.exitOptions` and dropped if out-of-set (§2) before minting `Armed.directive` |
| `commit()` | `{ kind: 'commit' }` | go-tap: fire the armed jumpTo + step once |
| `disarm()` | `{ kind: 'disarm' }` | "never mind" — clear the marker |

`redirect` (immediate) vs `arm`→`commit` (telegraphed) is the §3.5 distinction: a
telegraphed change shows "pending → X" and waits for the go-tap; an immediate redirect
is the instant yank paired with the MD's own downbeat. Both already exist in chunk 3;
chunk 4 only surfaces them.

## 2. The armable target model — the picker

Per cut #3 the only **armable** change is a `jumpTo`. Its legal targets are the finite,
enumerable set of **local chart positions** in the MD's program (local `Bar` ids, per D0 —
NOT the canonical `SongStructure` layer, which is 3b; parent locked decision:
"redirect = jump to an EXISTING node; overlay, never edit"). No free-form bar entry, no
inventing a node.

**Identity layer — chunk 4 runs on the LOCAL chart, NOT the canonical layer (Codex R2
Block).** This is the root of the R1 type mix-up, so pin it: the live VM compiles from the
MD's own `ChartCalibration` — `resolveRoadmap(cal)` = `compileRoadmap(barsInOrder(cal),
cal.roadmap)` (chart-calibration.ts:810). So **every id the session touches is LOCAL**:
`compiled.bars[].id` = `ChartCalibration.bars[].id` (types.ts `Bar`, `sectionId` →
`SectionAnchor.id`), and `Armed.directive.barId` is a local bar id. The canonical
`SongStructure` / `CanonicalBar` / `CanonicalSection` layer (song-structure.ts) is the
chunk-1 **cross-chart** bridge — it only matters once a `StructuralRef` must be resolved to
a *different* follower's coords, which is **3b**. Chunk 4, being single-device, never
crosses that boundary. Therefore `armableTargets` takes the **local** `ChartCalibration`
(its `sections: SectionAnchor[]` carry the `label`, types.ts:70), never `CanonicalSection`.

```ts
// lib/conductor-targets.ts
import type { ChartCalibration } from './types';      // impl body also pulls Bar/SectionAnchor/RoadmapMarker
import { barsInOrder } from './chart-calibration';
import type { CompiledRoadmap, ExitPolicy } from './roadmap-vm';

export interface JumpTarget {
  barId: string;                       // the Armed.directive.barId (a LOCAL bar id)
  label: string;                       // human label for the picker + telegraph badge
  kind: 'segno' | 'coda' | 'fine' | 'section' | 'repeatStart' | 'bar';
  exitOptions: ExitPolicy['kind'][];   // target-aware exit eligibility (High-1): which of
                                       // alCoda/alFine are MEANINGFUL from THIS target ([] = none)
}

// Enumerate legal jumpTo targets from the MD's LOCAL chart. `cal` carries everything:
//   barsInOrder(cal) — the VM's TRAVERSAL order (chart-calibration.ts:304), to find a
//                      section's HEAD bar (first matching sectionId in this order, NOT min absNumber)
//   cal.sections — local SectionAnchor[] (id + label), for the label + ordinal
//   cal.roadmap  — local RoadmapMarker[], for segno/coda/fine + repeatStart landmarks
// `compiled.barPos` is the validity oracle (every emitted target is a present local bar).
export function armableTargets(compiled: CompiledRoadmap, cal: ChartCalibration): JumpTarget[];
```

- **Named landmarks first** (the calls an MD actually makes): Coda, Segno, Fine (from
  `cal.roadmap`), then **section heads** — each `SectionAnchor`'s first local bar in the VM's
  reading order: the first bar of `barsInOrder(cal)` (chart-calibration.ts:304 — the SAME
  order `compileRoadmap` runs on) whose `sectionId` matches, NOT min `absNumber` (Codex R3
  Med — `absNumber` is not guaranteed to track traversal order). Labelled by
  `SectionAnchor.label` + ordinal among same-`normalizeLabel(label)` anchors. `normalizeLabel`
  IS exported (song-structure.ts:101); `sectionOrdinals` is NOT (it is private) — so
  `conductor-targets.ts` **recomputes the ordinal locally** over `cal.sections` via the
  exported `normalizeLabel` (Codex R2 Low). Then repeat starts. Plain bars are available but
  de-emphasized (parent §locked "bar number = label + fine fallback ONLY"). A
  linear/section-less chart yields bar targets only (no crash on absent sections).
- **`exit` eligibility is computed PER TARGET in the pure helper (High-1 + Codex R2 Med).**
  `JumpTarget.exitOptions` is filled by `armableTargets`, so the React UI never recomputes it:
  - include `alCoda` iff **there EXISTS a To-Coda trigger at or after the target's bar
    position** — `compiled.toCodaAt` is a Map (a program may carry several To-Codas;
    `compileRoadmap` does not reject multiples), so the test is existential, not "the trigger";
  - include `alFine` iff there EXISTS a Fine at or after the target's position
    (`compiled.fineAt` is likewise a Set).
  A target with neither reachable → `exitOptions: []` (the picker offers no exit). Default
  (no exit selected) is always available.
- **`arm` RE-RESOLVES the target + enforces `exit` in the pure layer (Codex R3 High/Med).**
  The picker *offers* only legal exits, but the controller's `arm(t, exit?)` must not trust the
  passed `JumpTarget` AT ALL — a stale/spoofed object can carry both a bad `barId` AND a spoofed
  `exitOptions`, so checking `exit` against `t.exitOptions` would just trust the caller's own
  claim. Instead the `arm` wrapper **re-derives the target from scratch**: it looks up
  `armableTargets(compiled, cal)` by `t.barId`, and
  - if no current target has that `barId` → the arm is rejected (no `Armed` minted — the UI
    surfaces it as disabled, consistent with the §2 "validity at both ends" rule);
  - else it keeps `exit` ONLY if it is in the **recomputed** target's `exitOptions`, dropping an
    out-of-set exit (mints `jumpTo` with no exit) before building `Armed.directive`.
  So neither a stale `barId` nor a spoofed `exitOptions` can reach the reducer; the authoritative
  eligibility is always the fresh `armableTargets` computation, never the passed object.
  *(Note, Codex R5 Low: re-resolution is by `barId`, and `exitOptions` is position-based so it is
  identical for any targets sharing a bar — but the `label`/`kind` of two targets at the SAME
  `barId` may differ. That is safe for arming; only matters if a test asserts the recomputed
  target's label, so label-asserting fixtures use DISTINCT bar ids.)*
- **Validity is enforced at BOTH ends.** The picker only offers `compiled.barPos`-present
  targets; `arm` re-checks (chunk-3 reducer:227) and the controller surfaces an `ignored`
  as a disabled control. Defense in depth, no new reducer path.

## 3. `fireAt` + the telegraph overlay

`Armed.fireAt` is a `barId` — the position the change-pending badge sits at, and (chunk
5) the auto-fire trigger bar. In the **go-tap** world of chunk 4 it is **advisory display
only**: the MD taps Go to commit regardless of where the playhead is. So fireAt never
gates anything this chunk — it only places the badge.

- **Default fireAt = the next EMITTED bar, via a pure `stepVM` PEEK — NOT `bars[vm.cursor]`
  (Codex R5 High).** `vm.cursor` is only the next *candidate* index: `stepVM`'s Rule-1
  volta-entry-select loop (roadmap-vm.ts:396-418) advances the cursor PAST a pass-excluded
  ending span before recording a bar, so `compiled.bars[vm.cursor]` can be a bar the VM will
  SKIP. The honest "next downbeat" is whatever `stepVM` actually emits next, so:
  ```ts
  const peek = stepVM(compiled, vm);           // pure: clones, does not mutate vm
  const defaultFireAt = peek.transition?.barId; // the REAL next emitted bar (or undefined)
  ```
  **End-of-song guard (Codex R1 Medium, now subsumed):** when the peek yields no
  `transition` (`vm.done`, or the walk falls off the end / past the last group) there is no
  next emitted bar → no valid default fireAt → the Arm affordance is **disabled** (a jumpTo
  off the end of the song is meaningless, and `armed.fireAt` is a raw string the reducer does
  not position-validate). The MD MAY re-place fireAt by tapping another **real** bar (any
  `compiled.barPos`-present id); the re-tap target is validated the same way.
- **fireAt placement vs auto-fire eligibility — an ARM-TIME fact (Codex R2 Med + R3 Med).**
  Chunk-4 go-tap fires on the MD's tap regardless of where `fireAt` sits, so re-tap may point
  at ANY real bar — including one at or behind the current position. Harmless here. But it would
  leave a **dead marker** for chunk-5 auto-fire (a `fireAt` the playhead never reaches again
  never triggers). The rule — **a `fireAt` BEHIND the next emitted bar when armed is
  auto-fire-INELIGIBLE** — depends on the VM position *at arm time*, which a post-advance
  `shouldAutoFire(session)` cannot reconstruct (`Armed` stores only `{fireAt, directive}`,
  conductor-state.ts:44, and chunk 4 makes ZERO changes to that type). So eligibility is a
  **pure helper evaluated at arm/re-tap time**, not a post-hoc derivation:

  ```ts
  // lib/conductor-targets.ts — eligibility decided when the marker is placed
  export function fireAtEligible(compiled: CompiledRoadmap, vm: VMState, fireAt: string): boolean;
  // A FORWARD-POSITION check anchored to the REAL next emitted bar (Codex R5 High/Med):
  //   const peek = stepVM(compiled, vm);
  //   if (!peek.transition) return false;                 // vm.done / walks off the end
  //   const nextEmitPos = compiled.barPos.get(peek.transition.barId)!;
  //   const pos = compiled.barPos.get(fireAt);
  //   return pos !== undefined && pos >= nextEmitPos;
  // The floor is the PEEKED next-emit position, NOT raw vm.cursor: a pass-excluded volta bar
  // that stepVM skips sits at pos < nextEmitPos and is correctly INELIGIBLE; the DEFAULT
  // fireAt (= peek.transition.barId) is eligible by construction (pos === nextEmitPos). Unknown
  // bar → false; song end → false.
  //
  // SCOPE/HONESTY (Codex R5 Med): this is a forward-POSITION heuristic, NOT a full-traversal
  // reachability proof — repeats/jumps/Coda/Fine can revisit or skip bars, so `pos >= nextEmitPos`
  // does not PROVE the playhead reaches fireAt. It is sufficient for chunk 4 (advisory display)
  // and is the floor chunk-5 auto-fire ANDs with the §3.5 confidence gate; if chunk 5 needs true
  // reachability it upgrades this to a bounded VM walk (the SIGNATURE stays the same).
  ```
  Chunk 4 ships + tests this helper and uses it to flag an ineligible placement in the
  telegraph (advisory). **Honest correction to the chunk-5 claim (R3 Med):** auto-fire is NOT
  "swap only `shouldAutoFire`'s body" — chunk 5 must ALSO record this arm-time eligibility as
  **local hook state** (the wire `ConductorState` stays chunk-3-frozen) and AND it into the
  gate. Chunk 4 provides the pure primitive; chunk 5 owns the extra local state.
- **Telegraph render:** an **ephemeral, overlay-only** badge — "**→ {target.label}**" (e.g.
  "→ Coda") near `fireAt`, reusing the `RoadmapOverlayLayer` / `SectionMarker` visual
  vocabulary (page.tsx:1900, :1656) so it reads native. **Never persisted** — honors the
  parent boundary ("ephemeral by default; no write-back path from live state"). It lives
  in `ConductorState.armed`, not in the chart's `calibration.roadmap`.
- **Commit feedback:** on go-tap the badge clears and the redline lands on the **real
  emitted landing bar** — `current` after the commit's `applyOverride` + single `stepVM`
  (chunk-3 D2). This is NOT necessarily the armed `barId`: chunk 3 lets `stepVM` skip a
  pass-excluded target to the first reachable bar (Codex R2 Low), so "landing bar" is the
  honest term. On disarm the badge clears with no move.

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
- **Call shape — the arm-time eligibility is ANDed by the HOOK, OUTSIDE `shouldAutoFire`
  (Codex R5 Med).** `shouldAutoFire(session)` reads only the wire `ConductorState`; the §3
  `fireAtEligible` result is captured at arm time into **local hook state** (`armedFireAtEligible`),
  which `session` does not carry. So chunk 5's post-advance decision is composed in the hook,
  not inside the predicate:
  ```ts
  // chunk-5 hook, post-advance:
  if (armedFireAtEligible && shouldAutoFire(session)) commit();
  ```
  `shouldAutoFire`'s SIGNATURE is unchanged (still `(session) => boolean`); the eligibility AND
  lives in the hook because it is local, not wire, state.
- **Return = "the hook should now `dispatch({ kind: 'commit' })`."** `true` does NOT itself
  mutate state — it tells the hook to issue exactly ONE additional `commit` message (its own
  seq), so auto-fire flows through the identical reducer path as a go-tap. A normal advance
  with no match returns `false` and dispatches nothing extra (no spurious commit). Because
  `commit` clears `armed`, the predicate cannot re-fire on a later bar.
- **Same-tick handoff — render only the committed state (Codex R2 Med).** Auto-fire is two
  sequential reducer messages: the `advance` emits the `fireAt` bar, then the injected
  `commit` emits the landing bar. Without care a follower briefly paints the `fireAt` bar
  before the target. Pin it: when `shouldAutoFire` returns `true`, the hook issues the
  `commit` in the **same tick** as the advance and the UI renders **only the final committed
  `current`** (no intermediate paint of the `fireAt` bar). A go-tap, by contrast, is a real
  two-step gesture (the playhead sits at `fireAt` until the MD taps Go) and DOES paint both.
  The reducer is unchanged either way — this is a chunk-5 render-coalescing rule, recorded
  here so the seam is honest about the two-message shape.

```ts
// lib/conductor-session.ts
// Chunk 4: always false (go-tap only). The SIGNATURE + the post-advance / fireAt-match /
// "hook should commit" contract above are fixed now so chunk 5 keeps the SAME public API.
// HONEST scope (Codex R3 Med): chunk 5 is NOT a pure body-swap — it replaces this body
// with the §3.5 gate AND adds the arm-time eligibility (the §3 `fireAtEligible` result)
// as LOCAL hook state, ANDing it into the gate (the wire `ConductorState` stays frozen).
export function shouldAutoFire(session: ConductorSession): boolean {
  return false; // go-tap is the floor; auto-fire is a chunk-5, clock-gated luxury
}
```

The hook calls `shouldAutoFire` after each `advance`; while it returns `false` only the
explicit Go button commits, and an advance never injects a commit. The MD override (manual
Go / disarm) stays live regardless — parent §3.5 "with an MD override always live."

## 5. React binding — `useConductorSession` + the Perform transport surface

A thin hook wraps the pure controller; all logic that matters lives in §1.

**Redirect validity lives in the PURE layer, not React (Codex R2 High-2).** The reducer
deliberately admits + seq-burns an invalid redirect (§1), so "don't emit invalid ones"
cannot rest on React discipline. `lib/conductor-targets.ts` exports a pure enumerator that
is the single source of *applicable* immediate redirects given the current VM state; the
hook renders exactly its output and can emit nothing else. It is unit-tested (§7).

```ts
// lib/conductor-targets.ts — the only legal immediate redirects right now
export interface RedirectOption { label: string; directive: Directive; }

// Enumerate ONLY directives that are not a REDUCER/seq-burning no-op against THIS vm state.
// SCOPE (Codex R5 Med): the guarantee is "won't silently burn a seq for zero STATE change,"
// NOT "guaranteed musically audible." So anotherRound/hold are scoped to repeatStarts that
// compile to a REAL repeat (a body the directive can affect): rs with `compiled.times.get(rs) > 1`
// OR an ending group (`compiled.endingStartsByRepeat.has(rs)`). A lone/cosmetic repeatStart
// (times === 1, no ending group) is excluded — anotherRound clamps completedPasses to a value
// the exit edge never consults, so it is musically inert (Codex R5 Med).
//   anotherRound{rs}  — each real-repeat rs (per the scope above)
//   hold{rs}          — each real-repeat rs EXCEPT the one already vamping: hold sets
//                       vm.holding := rs, so hold{rs} when vm.holding === rs re-sets the
//                       same value and burns a seq for no change (Codex R3 High-2,
//                       roadmap-vm.ts:535) → exclude the currently-held repeat
//   release{rs}       — ONLY when vm.holding === rs (else a no-op)
//   resetJump{jumpId} — ONLY when vm.fired[jumpId] (re-arm an already-fired jump)
// jumpTo is the ARMABLE path (§2), not an immediate-redirect option here.
// LABELS (Codex R3 Low): RedirectOption.label for resetJump reads "Re-arm jump" (or
// "Re-arm {jump label}"), NOT "Reset" — "reset" misreads as resetting PLAYBACK, not the marker.
export function availableRedirects(compiled: CompiledRoadmap, vm: VMState): RedirectOption[];
```

```ts
// in app/[owner]/[show]/page.tsx (or a colocated hook file)
function useConductorSession(args): {
  state: ConductorState;
  current: TraversalStep | null;        // = state.current, the bar to redline
  armed: Armed | null;
  targets: JumpTarget[];                // armable jumpTo targets (§2), each w/ exitOptions
  redirects: RedirectOption[];          // applicable immediate redirects (pure-enumerated)
  advance: () => void;
  redirect: (opt: RedirectOption) => void;        // only ever an enumerated option
  arm: (t: JumpTarget, exit?: ExitPolicy['kind']) => void; // exit ∈ t.exitOptions
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
  at song end per §3); the picker exposes a target's `exitOptions` only (no invalid exit),
  plus, while armed, the §3 telegraph badge and a prominent **Go** (commit) / **Cancel**
  (disarm).
- **Immediate-redirect controls** render one button per `redirects` entry — so an
  inapplicable `release`/`resetJump` is simply absent, never a disabled-on-faith control.
  No control can fire a silent seq-burning no-op (the enforcement is the pure enumerator,
  not the component).
- **Non-MD / no-session:** Perform renders exactly as today (zero change for followers
  this chunk; the telegraph is single-device until 3b).

## 6. Decisions (recommend YES unless noted)

- **D0 — Identity layer is the LOCAL `ChartCalibration`, not canonical (Codex R2 Block).**
  Single-device runs on the MD's own chart (local `Bar`/`SectionAnchor` ids, what
  `compileRoadmap` already consumes); the canonical `SongStructure` layer is the chunk-1
  cross-chart bridge and is purely a 3b concern. Every chunk-4 id is local. Recommend YES.
- **D1 — Pure lib core, React hook is a thin binding.** `lib/conductor-session.ts`
  (`initSession` / `dispatch` / `shouldAutoFire`) + `lib/conductor-targets.ts`
  (`armableTargets` + `availableRedirects`, the pure target/redirect enumerators that take
  the local `ChartCalibration` / `compiled`+`vm` so validity lives in the gate, not React).
  Keeps the live logic in the lib gate (no jsdom), mirrors chunks 1-3. Recommend YES.
- **D2 — The MD is its own relay on one device: `dispatch` = mint → `reduceConductor` →
  loopback.** The loopback is the single-device state seam (swap "keep locally" for
  "broadcast + apply"); reducer + message contract unchanged FOR THIS DEVICE. 3b additionally
  owns the local↔canonical translation so other charts can consume the stream (Codex R3
  High-1) — the loopback is not, by itself, the whole multi-device story. Recommend YES.
- **D3 — `dispatch` is the sole seq-issuer** (`seq+1`, `epoch` held, `sentAt = now`
  injected). Single-device never produces `needsSnapshot`. Two invalid-payload behaviors
  (§1): `arm`/`commit` self-validate → `ignored` → disabled control; `redirect` always
  admits + burns seq, so redirect validity is enforced by the **pure** `availableRedirects`
  enumerator (Codex R2 High-2) — the UI can only emit an enumerated option. Recommend YES.
- **D4 — Armable = jumpTo only (carry D6); `armableTargets(compiled, cal: ChartCalibration)`
  (Codex R2 Block — local chart, not canonical); named landmarks first, plain bars
  de-emphasized; `JumpTarget.exitOptions` computed per target (Codex R2 High-1) — include
  `alCoda`/`alFine` iff a To-Coda/Fine EXISTS at-or-after the target (existential over the
  Map/Set, not "the trigger"; Codex R2 Med); the `arm` wrapper enforces `exit ∈ exitOptions`
  in the pure layer and drops an out-of-set exit before minting `Armed.directive` (Codex R3
  Med).** No free-form bar entry. Recommend YES.
- **D5 — `fireAt` = advisory display only this chunk; default to the next bar (disabled at
  song end — §3 guard), optional re-tap to any real bar.** Precise placement earns its keep
  in chunk 5 when auto-fire makes the bar a trigger. Recommend YES (keep re-tap — Codex (a)
  concurs, gated on the validated bar source the Block fix provides + song-end disable).
- **D6 — `shouldAutoFire` ships hard-`false`; the seam is the only auto-fire surface, with
  its evaluation contract pinned now (post-advance, `current.barId === armed.fireAt`, return
  = "hook should commit once").** Chunk 5 keeps this API but is NOT a pure body-swap — it
  replaces the body with the §3.5 gate AND adds the §3 arm-time eligibility as local hook
  state ANDed into the gate (the wire state stays frozen — Codex R3 Med). Recommend YES.
- **D7 — Telegraph is ephemeral overlay-only (lives in `state.armed`, never in
  `calibration.roadmap`); MD-only surface, interim gate `isOwner` but labelled "Local MD
  mode"** so it never implies relay authority before 3b (Codex (c)). Honors the
  never-write-back boundary. Recommend YES.

**Open Qs — resolved across Codex R1-R5, no open chunk-4 decisions remain:** (a) keep
`fireAt` re-tap — adopted (chunk-4 unconstrained; a fireAt at/behind the cursor is
auto-fire-ineligible in chunk 5, §3); (b) surface immediate redirects now BUT enforced by
the pure `availableRedirects` enumerator (not React discipline) — adopted; (c) `isOwner`
interim gate labelled "Local MD mode" — adopted.

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
- **arm target re-resolution + exit enforcement (Codex R3 High/Med):** `arm(t, exit)` re-derives
  the target from `armableTargets(compiled, cal)` by `t.barId` — a passed `t` with a `barId` no
  current target has → rejected (no `Armed` minted); a passed `t.exitOptions` that is SPOOFED (lists
  an exit the recomputed target does not) → the spoofed exit is dropped (mints `jumpTo` with no
  exit); an `exit` in the RECOMPUTED target's `exitOptions` is preserved verbatim. Pins that
  eligibility comes from the fresh computation, never the passed object.
- **disarm:** clears `armed`, `current`/`vm` unchanged.
- **self-invalid arm/commit:** `arm` at a bar not in `compiled.barPos` → outcome
  `ignored`, session UNCHANGED (the UI disables the control); commit on a corrupt armed
  target (injected) → `armed` cleared, no step.
- **armableTargets (local `ChartCalibration`):** **section-head targets carry the
  `SectionAnchor.label` + locally-recomputed ordinal** and point at the section's head bar
  by `barsInOrder(cal)` traversal order, NOT min `absNumber` (Codex R3 Med — a fixture whose
  `absNumber` disagrees with traversal order pins this); a `compiled`-only or canonical
  enumeration is the Block regression;
  named landmarks first; a linear/section-less chart yields bar targets only with no crash;
  every `barId` is a `compiled.barPos`-present local id.
- **JumpTarget.exitOptions (target-aware, existential):** a target with a To-Coda at/after
  it → `exitOptions` includes `alCoda`; with NONE after it → excludes it; **multiple To-Coda
  markers** are handled (existential over `compiled.toCodaAt`, not "the trigger"); `alFine`
  likewise over `compiled.fineAt`; a target with neither → `[]`.
- **availableRedirects (pure, the High-2 safety net):** lists `anotherRound`/`hold` only for a
  **real repeat** (`compiled.times.get(rs) > 1` OR an ending group) — a lone/cosmetic repeatStart
  (times 1, no endings) is excluded (Codex R5 Med, musically inert); `hold{rs}` additionally
  **EXCLUDES the currently-held one** (`vm.holding === rs` → re-holding burns a seq for no change —
  Codex R3 High-2); `release{rs}` ONLY when `vm.holding === rs`; `resetJump{j}` ONLY when
  `vm.fired[j]`; excludes a `release`/`resetJump`/held-repeat-`hold`/cosmetic-repeat that would
  no-op against the given `vm` (regression: an inapplicable redirect can never be enumerated →
  never emitted → never burns seq).
- **fireAt song-end guard:** at `vm.done` (or `cursor >= bars.length`) there is no default
  fireAt and arm is disabled (the controller/helper reports "no armable position").
- **default fireAt = next EMITTED bar (Codex R5 High):** in a fixture where `vm.cursor` sits on a
  **pass-excluded volta span** (stepVM Rule-1 skips it, roadmap-vm.ts:396-418), the default fireAt
  is the PEEKED `stepVM(compiled, vm).transition.barId` — the bar actually emitted next — NOT the
  skipped `compiled.bars[vm.cursor]`. (The regression a raw-`vm.cursor` default would introduce.)
- **fireAtEligible (Codex R3 Med + R5 High — explicit tests):** the DEFAULT next emitted bar
  (peek `transition.barId`) → **eligible** (`pos === nextEmitPos`, the `>=` boundary the case
  strict-`>` would wrongly fail); a **pass-excluded volta bar at raw `vm.cursor`** (skipped by
  stepVM) → INELIGIBLE (`pos < nextEmitPos` — the R5 High regression); a bar behind the next-emit
  position (already emitted) → ineligible; an unknown bar id (barPos miss) → false; at song end
  (`vm.done` / no peek transition) → false.
- **shouldAutoFire:** returns `false` for every session (chunk-4 invariant — a guard test so
  chunk 5's change is visible and intentional). Contract test: an `advance` that lands
  `current.barId === armed.fireAt` still injects NO commit in chunk 4 (go-tap only), and the
  helper is evaluated post-advance.
- **redirect equivalence:** `redirect(opt)` yields a `vm` equal to a direct chunk-2
  `applyOverride` on `opt.directive` (the controller adds nothing but seq/sentAt).

Target: `tests/conductor-session.test.ts` + `tests/conductor-targets.test.ts` companions
(~24 assertions total), gate green, test-count delta reported on the build PR.

## 8. What this unblocks / what it does NOT do

- **Unblocks:** chunk 5 (clock) — (a) replaces `shouldAutoFire`'s body with the §3.5 gate,
  (b) records the §3 arm-time `fireAtEligible` result as **local hook state** ANDed into that
  gate (the wire `ConductorState` stays chunk-3-frozen — Codex R3 Med, NOT a pure body-swap),
  and (c) feeds the `clock` directive through `dispatch`; the §3.5 gate has a home. Linkage
  step 6 may slot around here per the locked sequence (confirm with Graham).
- **Explicitly NOT in chunk 4:** any network / relay (3b); multi-device telegraph;
  auto-fire enablement; armable `anotherRound`; persisting an arrangement variant
  (deliberate separate owner action, never from live state). These stay gated where the
  parent put them.
