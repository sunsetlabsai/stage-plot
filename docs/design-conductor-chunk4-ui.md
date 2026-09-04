# Conductor Authority — Chunk 4 UI slice (`useConductorSession` + Perform transport)

**Build state:** tracked in `docs/INDEX.md`, not here. The pure controller (`lib/conductor-session.ts`) and the pure target/redirect
enumerators (`lib/conductor-targets.ts`) are **already built and Codex-green** (#101, main
`b5999ef`). This doc designs the **last** piece of chunk 4: the thin React binding and the
Perform-tab surface that drives it. No new wire types, no reducer changes, no lib changes —
this is the consumer the chunk-4 design (§5) named and deferred.

Parent: `docs/design-conductor-authority.md`. Chunk-4 spec: `docs/design-conductor-chunk4.md` §5
(the blueprint this implements). This doc is the *binding* contract — §5 left the hook body and
the page wiring open; everything below is that.

## 0. Scope & non-goals

- **In:** one hook (`useConductorSession`), its wiring into `PerformTab`, and an MD-only
  control cluster (Advance / Arm→Go / immediate redirects) that drives **this device's** local
  session. Single-device. The MD's own `ChartCalibration` is the identity layer (D0).
- **Out (unchanged this chunk):** any network/relay (3b), the clock (chunk 5), auto-fire
  (`shouldAutoFire` stays hard-`false`), and **every follower-facing pixel** — a non-MD viewer's
  Perform tab renders byte-identical to today.
- **Non-goal — do not touch the pure lib.** If the wiring wants something the lib doesn't expose,
  that is a finding to raise, not a reason to edit `conductor-session.ts` / `conductor-targets.ts`
  in this chunk (they're frozen + reviewed).

### 0.1 Where this sits in the ladder (read before reviewing — what it is, and is NOT yet)

This slice delivers exactly **the MD's own manual baton on one screen** — nothing more. Read it
against the full epic (`design-conductor-authority.md`) so neither reviewer nor builder expects
follower or auto-follow behavior that lives in later chunks:

- **What chunk 4 IS:** on the MD's *own* device, a per-song session whose redline the MD **advances
  by manual tap** (the "go-tap is the floor," §3.5 — the baton, digitized), plus armable
  change-markers and immediate redirects, all single-device. No network, no clock, no automatic
  motion.
- **Followers do NOT opt in here.** Chunk 4 is single-device, MD-only; a non-MD Perform tab is
  byte-identical to today. The follower opt-in (an *aligned/verified* chart joins the band-owned
  relay room and **mirrors** the MD's VM; detach = private override + one-tap resync) is the **3b
  transport** chunk — and its join/discovery protocol is **§8.2-2, still OPEN** (gates 3b).
- **It does NOT "follow along" by tempo or audio.** The redline moves **only when the MD taps
  Advance.** The BPM/audio clock is **chunk 5** (§5.1) — and even there tempo is a dead-reckoned
  *motion-smoother between anchors* re-zeroed at every section boundary + MD cue, gated on
  **§8.2-1 (listener/latency), also OPEN** — never unconditional auto-play.
- **Scope is per-SONG, not per-show.** A session wraps one VM = one compiled roadmap = one chart
  (`songRef`). A show is a *sequence* of per-song sessions; **cross-song advance for the band is
  NOT modeled in conductor state** — today it's the existing per-device Perform "Prev/Next Song."
  That seam (who moves the whole band to the next setlist song) is an acknowledged, deliberately
  out-of-scope gap for a later chunk, not something this slice covers.

The ladder: **chunk 4 = MD's manual baton (here)** → 3b = followers mirror it (needs §8.2-2) →
chunk 5 = audio-tempo auto-motion between the MD's cues (needs §8.2-1).

## 1. The integration crux — one redline, two drivers

`PerformTab` ALREADY has a bar-level redline driven by a **self-drive** seek
(`page.tsx:2863-2900`): `traversal` (resolved played order) + `barSeekIdx` → `seekIdx` →
`currentStep` → `currentBar`/`currentSystem` → `barRedline`, stepped by `stepNextBar`/`stepPrevBar`
and `seekBarAt`. That is the surface the conductor session **replaces as the driver** when a
session is live, without forking the renderer.

The conductor session produces `state.current: TraversalStep | null` — *the bar the VM last
emitted*. That is exactly the shape `currentStep` already is. So the wiring is a **driver swap,
not a render rewrite**:

```
                       barRedline (renderer — UNCHANGED)
                              ▲
              currentBar / currentSystem  (derive from currentStep — UNCHANGED)
                              ▲
                        currentStep
            ┌─────────────────┴──────────────────┐
   session OFF: traversal[seekIdx]      session ON: conductor.current
   (today's self-drive)                 (the VM's emitted step)
```

**Decision UI-1 (recommend YES):** when a conductor session is active, `currentStep` resolves
from `conductor.current` and the existing `barSeekIdx` self-drive is **suppressed** (Prev/Next/clear
hidden, replaced by the conductor cluster). One redline, one source at a time — never both. The
derivation below `currentStep` (`currentBar`, `currentSystem`, page-turn on system change,
`barRedline`) is reused verbatim. This keeps the renderer the single source of truth for *how* a
bar is drawn and makes the session purely a *which-bar* driver.

Page-turn parity: the self-drive turns the page in `seekToIndex` when the target system is on
another page. The session path must do the same — when `conductor.current`'s bar lands on a system
whose `page !== pageNum`, set the page. (Mechanism TBD in build: a derived value at render time, NOT
a setState-in-effect — see §4, the forked-Next.js mount-fresh rule.)

## 2. The hook — `useConductorSession`

A thin binding over the pure controller. **All logic that matters already lives in the lib**
(§5/D1); the hook holds the one piece of React state (the `ConductorSession`) and exposes the
`initSession`/`dispatch` seam + the pure enumerators as memoized reads.

```ts
// colocated in app/[owner]/[show]/page.tsx (or a sibling hook file)
interface UseConductorArgs {
  enabled: boolean;                 // isOwner && a performable bar-cal is loaded (see §3 gate)
  sessionId: string;                // stable per chart-in-show (TBD source — see Q1)
  songRef: string;                  // the chart/song identity for this session
  programHash: string | null;       // loader-computed hash of the EXACT compiled program;
                                    //   null until the async hash resolves (⇒ active === false)
  compiled: CompiledRoadmap | null; // compileRoadmap(barCal); null ⇒ no session
  cal: ChartCalibration | null;     // the MD's LOCAL chart (D0) — armableTargets source
}

function useConductorSession(args: UseConductorArgs): {
  active: boolean;                       // a session exists (enabled && compiled && programHash)
  state: ConductorState | null;
  current: TraversalStep | null;         // = state.current — the bar to redline (§1)
  armed: Armed | null;
  targets: JumpTarget[];                 // armableTargets(compiled, cal) — memoized
  redirects: RedirectOption[];           // availableRedirects(compiled, vm) — memoized on vm
  advance: () => void;                   // dispatch advance
  arm: (t: JumpTarget, exit?: ExitPolicy['kind']) => void;  // routes through resolveArm (§2.1)
  commit: () => void;                    // dispatch commit (Go)
  disarm: () => void;                    // dispatch disarm (Cancel)
  redirect: (opt: RedirectOption) => void;                  // only ever an enumerated option
  outcome: ReduceOutcome['status'] | null;  // last dispatch status (for the 'ignored' affordance)
};
```

- **State:** one `useState<ConductorSession | null>`. Built by `initSession(...)` once
  `programHash` is non-null (it's async — until then `active === false`, surface renders nothing).
  `programHash` MUST be the hash of the EXACT same inputs `compiled` came from — i.e. either the
  caller passes `programHash: string | null` computed from the same `compileRoadmap` source, or the
  hook owns `await programHash(barsInOrder(cal), cal.roadmap ?? [])` itself; do not let `compiled`
  and `programHash` derive from divergent inputs (the reducer fails closed on a hash mismatch).
  Mint-fresh on identity change (new chart / new programHash) — the cross-chart reset already
  modeled at `page.tsx:2921` (`resetCalState`) is the precedent; a stale session must never bleed
  across charts.
- **dispatch wrappers:** `advance`/`commit`/`disarm`/`redirect` each call `dispatch(session, payload,
  Date.now())` and `setSession` on `applied`; on `ignored` they keep the session and surface
  `outcome` so the control can show the dead-tap honestly (D3). `now = Date.now()` is injected at the
  callsite (the lib takes `now`; determinism lives in the lib tests, the hook is the impure edge).
- **memoized reads:** `targets = useMemo(() => compiled && cal ? armableTargets(compiled, cal) : [],
  [compiled, cal])`; `redirects = useMemo(() => compiled ? availableRedirects(compiled, state.vm) :
  [], [compiled, state?.vm])`. Validity lives in the pure layer; the hook renders exactly its output
  (§5, Codex R2 High-2) — it can emit nothing else.

### 2.1 `arm` MUST route through `resolveArm` (Codex forward-carry constraint, #101)

The Codex review of #101 banked an explicit forward-carry: the UI **must** build the `Armed` payload
via `resolveArm(compiled, cal, barId, exit, fireAt)` (`conductor-targets.ts:234`), NOT by hand-rolling
an `arm` payload. `resolveArm` enforces `exit ∈ exitOptions` and validates the bar/fireAt against the
compiled program **in the pure layer**, returning `Armed | null`. The hook's `arm(t, exit)`:

1. resolve fireAt default = next emitted bar (`nextEmittedBarId(compiled, vm)`; **disabled at song
   end** per §3 guard — D5);
2. `const armed = resolveArm(compiled, cal, t.barId, exit, fireAt)`; if `null`, no-op (the picker
   never offered an invalid combo, but the pure check is the guarantee, not the picker);
3. `dispatch(session, { kind: 'arm', armed }, now)` — the payload nests the resolved `Armed` under
   the `armed` key (`ConductorPayload` = `{ kind: 'arm'; armed: Armed }`, conductor-state.ts:72); do
   NOT spread it (`{ ...armed }` would flatten `fireAt`/`directive` onto the payload and fail to
   typecheck — Codex R1 Block).

The component never constructs a directive. This is the one hard constraint this chunk inherits.

## 3. The Perform surface (MD-only, "Local MD mode")

Additive to `PerformTab`, rendered only when `conductor.active`. Interim gate is `isOwner` (already a
`PerformTab` prop), but **all copy + the mode label say "Local MD mode"** (D7 / Codex R1(c)) — it
drives only this device and must not imply relay authority (there is no transport until 3b).

Placement: replaces the existing **Perform bar transport** block (`page.tsx:3454-3487`) when the
session is active; when inactive (non-owner, or owner with no bar-cal), that block renders exactly as
today. The two are mutually exclusive by `conductor.active` (UI-1).

Three control groups, in the §5 order:

1. **Transport readout + Advance.** Current bar + pass ordinal — reuse the exact markup at
   `page.tsx:3464-3473` (`Bar <absNumber>` · `passOrdinal(pass)`), fed by `conductor.current` instead
   of `currentStep`. Primary **Advance** button = `conductor.advance()` (tap → next emitted bar).
   At song end the VM emits `done`; Advance disables (the readout shows the final bar).
2. **Change-marker (Arm → Go/Cancel).** An **Arm** affordance opens the §2 target picker over
   `conductor.targets` — named landmarks first, plain bars de-emphasized (D4); each target exposes its
   `exitOptions` only (alCoda/alFine appear iff existentially valid — already computed per target). Arm
   is **disabled at song end** (§3 guard). Picking → `conductor.arm(target, exit)` (§2.1). While
   `conductor.armed`: show the telegraph badge (the armed target + exit + advisory fireAt) and two
   prominent controls — **Go** = `commit()`, **Cancel** = `disarm()`. fireAt is **advisory display
   only** this chunk (D5); re-tap to retarget a real bar is allowed but earns its keep in chunk 5.
3. **Immediate redirects.** One button per `conductor.redirects` entry, label straight from the
   option (`Another round` / `Vamp (hold)` / `Release vamp` / `Re-arm jump`). Inapplicable directives
   are simply **absent** (the pure enumerator already dropped the no-ops — there is no disabled-on-faith
   button, and no control can fire a silent seq-burning no-op). Tap → `conductor.redirect(opt)`.

**`ignored` affordance (D3):** if a `commit`/`arm` dispatch returns `ignored`, the control briefly
reflects the dead tap (e.g. a transient "not available" rather than a phantom state change). `redirect`
never returns `ignored` from the UI because only enumerated options are offered.

## 4. Forked-Next.js / render-purity rules (must-follow)

- **No setState-in-effect.** The page-turn on a session-driven bar change (§1) derives at render
  (mount-fresh pattern) like the rest of `PerformTab`, NOT a `useEffect` that sets `pageNum`. If a
  derived-at-render page can't be made to work cleanly, that's a design finding — raise it, don't
  reach for an effect.
- **`now` at the edge.** `Date.now()` is read in the hook's dispatch wrappers only; the lib stays
  deterministic (its tests inject `now`). Don't thread a clock into the lib.
- **AGENTS.md:** read `node_modules/next/dist/docs/` for the relevant API before writing the hook —
  this fork has breaking changes vs. stock Next.

## 5. Test plan

The pure gate is already covered (conductor-session + conductor-targets, no jsdom). This chunk adds the
**binding** tests under the client-component harness (jsdom + RTL, per-file docblock, react-dom subpath
aliases — the existing `PerformTab` test infra):

- session-OFF: Perform renders today's self-drive transport; conductor cluster absent (non-owner AND
  owner-without-session).
- session-ON driver swap: `conductor.current` drives the redline; self-drive Prev/Next/clear suppressed
  (UI-1); page turns when the emitted bar is on another page.
- Advance: tap advances the readout; disabled at song end (`done`).
- Arm→Go: picker offers only `targets`/`exitOptions`; arm routes through `resolveArm` (assert no
  hand-built directive); Go commits, Cancel disarms; Arm disabled at song end.
- redirects: exactly `conductor.redirects` rendered, inapplicable ones absent; tap dispatches.
- `ignored` surfaces the dead-tap affordance, no phantom state change.

**Gate:** full local gate before any push — `npx tsc --noEmit` + `npm run lint` (eslint) + `npm test` (report the test-count
delta) + `build`. ShowRunr conductor chunks land ff-merge after Codex-green.

## 6. Decisions for Graham

- **UI-1 — driver swap (one redline, session OR self-drive, never both); session suppresses the
  `barSeekIdx` transport.** Recommend YES.
- **Q1 — `sessionId` source.** What's stable-per-(chart-in-show)? Candidate: derive from the chart file
  id + show slug. Need your call on identity grain (per chart? per chart-in-this-show?) since 3b will key
  the relay off it. *Recommend: chart-file-id + show-slug; confirm.*
- **Q2 — Entry control.** How does the MD turn Local MD mode ON? Options: (a) auto-on whenever
  `isOwner && barMode` (the session is just "the owner's perform driver"); (b) an explicit toggle in the
  Perform header. *Recommend (b)* — explicit, so the owner can still use today's free self-drive seek to
  rehearse without minting/advancing a session, and it reads honestly as a distinct "I'm conducting" act.
- **Q3 — Where the cluster sits.** Replace the existing bar-transport strip in place (recommended), or a
  separate panel? *Recommend in-place replacement* (§3) — same screen real estate, mutually exclusive.

No other open questions; everything else is pinned by the chunk-4 spec (D0-D7) and the #101 forward-carry.

## 7. Build order (after GO)

1. `useConductorSession` hook (state + dispatch wrappers + memoized enumerator reads + resolveArm
   routing) — pure-ish, testable first.
2. Driver swap in `PerformTab` (`currentStep` source + page-turn parity).
3. The MD control cluster (3 groups) replacing the transport strip under `conductor.active`.
4. Binding tests (§5) + full gate.
5. Commit a stable ref → hand to Codex for adversarial review before merge.

*(Build state is tracked in `docs/INDEX.md`, not here. This line asserted the doc was
unbuilt and pending sign-off long after both had happened.)*
