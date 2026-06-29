# Conductor Authority — Chunk 5: gated auto-fire (§3.5) + the clock fence (§5.1)

**Status:** **DESIGN-ONLY** — review the spec, do NOT build. Branch
`opus/design-conductor-chunk5` off main `704f60a`.

**Parent:** `design-conductor-authority.md` §3.5 (change marker — telegraph + fire,
auto-fire **gated**) and §5.1 (the clock layer). This doc is the detailed design of
those two epic items. It does NOT touch the canonical `SongStructure` bridge (that
is the 3b cross-chart concern, design §0 / D0); like chunk 4, everything here runs on
the MD's **local** `ChartCalibration`.

**Companion (prerequisite):** `design-conductor-insert-return.md` reshapes the
`jumpTo` directive that auto-fire commits — a live backward/insert cue now carries
an optional `return` leg. Auto-fire commits that directive **unchanged** (it is the
same `commit` payload, §0.1 (b)); the return leg is a `stepVM` mechanic, transparent
to this chunk. The fire-point auto-align (Idea 1a) is folded into **D6** below.

**Predecessor:** chunk 4 shipped the single-device baton (`lib/conductor-session.ts`,
`lib/conductor-targets.ts`, `lib/use-conductor-session.ts`, `components/ConductorCluster.tsx`).
It left exactly one seam stubbed OFF for this chunk:

```ts
// lib/conductor-session.ts (chunk 4)
export function shouldAutoFire(session: ConductorSession): boolean {
  void session;   // chunk 5 reads session.current/armed/clock here
  return false;   // go-tap is the floor; auto-fire is a chunk-5, clock-gated luxury
}
```

and a documented hook contract:

```ts
if (armedFireAtEligible && shouldAutoFire(session)) commit();
```

This chunk fills that seam and wires the hook — without changing one wire type in
`conductor-state.ts` (chunk-3-frozen) or the `shouldAutoFire` / `fireAtEligible`
signatures (chunk-4-frozen).

---

## 0. The boundary — chunk 5 splits 5a (buildable now) / 5b (gated by §8.2-1)

The epic itself numbers these as **two separate items** (§8.2 chunk list): item 4 =
"change-marker UI + **gated commit** (§3.5)", item 5 = "**clock layer** + audio-tempo
listener (§5.1)". They are NOT the same feature, and only the second is blocked.

> **§8.2 OQ-1 (open, "gates chunk 5"):** listener placement + clock latency, phase
> alignment across relay latency, behaviour when the listener drops. Audio-tempo is
> *designed-in, turned on only after live source-quality validation* (§5.1).

So this doc mirrors the **3a / 3b precedent** (chunk 3 split a buildable pure reducer
from a transport layer gated on an undesigned protocol):

- **Chunk 5a — gated auto-fire on arrival (§3.5). BUILDABLE NOW.** The change marker,
  once armed, fires *itself* when the MD's manual advance lands on its fire bar —
  removing the second go-tap at the transition — behind a gate, opt-in, MD override
  always live. It depends on **nothing** §8.2-1 gates: there is no audio, no
  dead-reckoning, no auto-advance. Position truth is the MD's own advance tap.
- **Chunk 5b — the clock layer (§5.1). GATED by §8.2-1, NOT built here.** Live
  audio-tempo telemetry → MD re-emit → dead-reckoned auto-*advance* (the
  motion-smoother between anchors) + the full confidence/degrade ladder. §7 fences it
  precisely so the seam stays ready, but it ships only after the listener/source-quality
  open items close.

**Why auto-fire does not need the clock (the crux — D1).** §3.5 gates auto-fire on
"clock present AND … confidence high" because it imagines the *system* deciding *when*
to fire from an **estimated** position — and "a one-bar-early coda is worse than a tap."
In 5a the playhead only moves on the MD's **manual advance**, so when `current.barId ===
armed.fireAt` the position is **exact** (the MD literally tapped onto the fire bar,
confidence = 1 by construction). The dead-reckoning error §3.5 fears *cannot occur*
without auto-advance. The clock gate is therefore a **5b** concern (it guards estimated
position); 5a's "gate" is the arrival-is-exact invariant plus the §3.5 hold/vamp guard.
This is a strictly-safer subset of §3.5, not a weakening of it. See D1.

### 0.1 What chunk 5a IS and is NOT

**IS:** arm-then-coast. The MD telegraphs a jump (chunk-4 `arm`; followers already see
"change pending → Chorus"), then keeps advancing the beat normally; the armed jump
**executes on the manual advance that lands on its fire bar** — no separate, precise
go-tap at the moment of transition. The MD keeps the beat; the change rides the
bar-advance. Opt-in (default OFF = chunk-4 behaviour). Single device.

**Where does the fire bar land? — the structural-boundary model (Idea 1a, see D6).**
The fire point **auto-aligns to a structural boundary**, never a raw bar count. The
real gesture (Graham): an MD signals a change *at the top of the current bar* for it
to take effect *at the top of the next bar* — "signal at top of N → fire at top of
N+1." So the **default** fire bar is the **next bar downbeat** (`fireAt =
nextEmittedBarId`, exactly chunk 4's arm point). The **richer** option snaps the fire
to the **next section head** instead — the natural "make the change when we
hit the chorus" call — which can be several bars ahead. (Scope, Codex R3 MEDIUM: the
snap is to **section heads only** — `bar.sectionId` changes. It does **not** snap to
Coda/Segno/Fine/repeat marker heads unless one happens to coincide with a section
change; marker-head snap is out of 5a scope.) There is **no** raw "fire in N
bars" stepper; the only choices are *structural* (next bar | next section). D6 decides
whether 5a includes the section-snap option. The body is written for the **D6-YES
(boundary-snap)** shape and flags every spot the **D6-NO (next-bar-only)** fallback
simplifies.

**IS NOT:** (a) an audio/BPM motion engine — `advance` stays the only `stepVM` caller,
still MD-driven (that's 5b); (b) a *new* commit semantic — auto-fire dispatches the
exact same `commit` payload the go-tap already does, just triggered by arrival; (c) a new
wire type — `clock`/`commit`/`arm` are all chunk-3-frozen; (d) cross-song or multi-device
— still per-song, single-device (3b transport is §8.2-2-gated).

---

## 1. The fire decision lives in two places (per the frozen contract)

Chunk 4 deliberately split the auto-fire condition across the pure lib and the hook:

- **`shouldAutoFire(session)` — pure, evaluated POST-advance.** Reads only the session
  state: is something armed, is the playhead AT its fire bar, and is the §3.5 hold/vamp
  guard clear. Signature unchanged.
- **`armedFireAtEligible` — local hook state, captured at ARM time.** The frozen contract
  ANDs it in: `if (armedFireAtEligible && shouldAutoFire(session)) commit()`. It captures
  arm-time forward reachability of the fire bar (the chunk-4 `fireAtEligible` heuristic,
  `conductor-targets.ts:216`) stored in React because the chunk-3 `ConductorState` does
  NOT carry it — but see below: in 5a the fire bar is reachable by walk-construction, so
  the heuristic is not invoked.

**`armedFireAtEligible` — invariantly true in 5a (both D6 forms), load-bearing in 5b
(Codex R1 MEDIUM-1):** in 5a both fire bars come from an **actual forward `stepVM`
walk** (`nextEmittedBarId` for next-bar, `nextSectionBoundaryBarId` for next-section),
so the fire bar is forward-reachable **by construction** — the walk *is* the eligibility
proof. We therefore do **not** run the chunk-4 `fireAtEligible` raw-position heuristic on
the walk-derived bar (it would false-reject a boundary legitimately reached via a notated
backward jump, §3.1). The bit is set `true` when an arm succeeds, kept to honour the
frozen contract `if (armedFireAtEligible && shouldAutoFire(...))` and to stay the
genuinely load-bearing check in **5b** (dead-reckoning may miss `fireAt` exactly →
arm-time forward reachability matters; `fireAtEligible` then upgraded to a bounded
VM-walk per the chunk-4 Codex R5 note, §7).

Either way the AND stays verbatim. 5a does **not** add a *behind-the-cursor* re-tap
(firing at a bar already passed is incoherent); the only fire bars 5a offers are the
**next downbeat** and the **next section head ahead** of the cursor.

---

## 2. `shouldAutoFire` — the pure §3.5 gate for manual advance

```ts
// lib/conductor-session.ts — replaces the chunk-4 hard-OFF stub. SAME signature.
export function shouldAutoFire(session: ConductorSession): boolean {
  const s = session.state;
  const armed = s.armed;
  if (!armed) return false;                                   // nothing telegraphed
  if (!s.current || s.current.barId !== armed.fireAt) return false; // not yet at the fire bar
  if (s.vm.holding != null) return false;                     // §3.5: never auto-fire through an unresolved hold/vamp
  return true;                                                // arrival is exact (manual advance) → fire
}
```

Three guards, in order:

1. **`armed` present** — auto-fire only ever fires an *already-telegraphed* change. It
   never invents one.
2. **`current.barId === armed.fireAt`** — the playhead has *arrived* at the fire bar. This
   is the §3.5 position gate, satisfied by exact arrival rather than by a confidence
   estimate (D1). Before arrival → false (the marker stays pending, advisory display).
3. **`vm.holding == null`** — §3.5 verbatim: "no unresolved hold/vamp." If the MD is
   vamping on a repeat, the playhead is parked; auto-firing into a structural change
   mid-vamp is exactly the kind of guess §3.5 forbids. The MD must `release` (or go-tap)
   first. This is the one place the gate refuses a fire even at the right bar.

**Fires exactly once, by construction.** `commit` clears `armed` (chunk-3 reducer,
`conductor-state.ts` commit case). The next post-advance evaluation sees `armed == null` →
false. No latch, no de-dupe flag needed — idempotence is a reducer invariant, not a hook
responsibility.

**Clock is not read in 5a.** Per D1/D2, `session.clock` stays at its init value
`{ tempoBpm: null, confidence: 0 }`; 5b is the chunk that reads it. The chunk-4 stub
comment ("reads … clock here") is a forward note 5b honours.

---

## 3. The hook — synchronous advance → auto-commit chain (NOT an effect)

The chunk-4 page-turn-parity lesson (`performDisplayPage`, build review R1) is the
governing constraint: **never gate a frame-critical conductor transition on a deferred
effect.** Auto-fire is evaluated **synchronously inside the `advance` action**, chaining
the two pure dispatches on their returned sessions, with a **single** `setSession` at the
end:

```ts
// use-conductor-session.ts — advance action (chunk-5 form)
advance: () => {
  if (!session) return;
  const afterAdvance = dispatch(session, { kind: 'advance' }, Date.now());
  setOutcome(afterAdvance.outcome);
  if (afterAdvance.outcome !== 'applied') return;

  // gate is opt-in; armedFireAtEligible is local hook state (see §1)
  if (autoFireOn && armedFireAtEligible && shouldAutoFire(afterAdvance.session)) {
    const afterFire = dispatch(afterAdvance.session, { kind: 'commit' }, Date.now());
    setOutcome(afterFire.outcome);   // LOW-2: surface the COMMIT result, not the stale advance one
    setSession(afterFire.outcome === 'applied' ? afterFire.session : afterAdvance.session);
    return;
  }
  setSession(afterAdvance.session);
},
```

The auto-commit's `outcome` is reported (not left as the earlier `advance` result),
so a future transport path where `commit` is `ignored`/`needsSnapshot` surfaces the
right last-action (Codex R1 LOW-2). In 5a (single device) the commit always applies,
but the honest report costs nothing.

- **Two dispatches, one render.** `advance` then `commit` both run against the returned
  `ConductorSession` (a value, not React state) — no read-after-setState hazard, no effect
  loop. The MD made **one** tap; the followers converge on the post-commit state (chunk-3:
  reordered arm/clock/commit can't desync — every device just adopts the latest committed
  cursor).
- **`autoFireOn`** — the opt-in toggle (D3), local hook state, default `false`. When off,
  this collapses to the verbatim chunk-4 `advance`.
- **`armedFireAtEligible`** — local hook state set `true` when an `arm` succeeds (the
  fire bar is walk-proven reachable in 5a, §1/§3.1), cleared on
  `commit`/`disarm`/`redirect`/identity change. Invariantly true in 5a; the genuinely
  load-bearing check in 5b (§1, §7).
- **`shouldAutoFire(afterAdvance.session)`** — evaluated on the **post-advance** session,
  so `current` is the bar we just landed on. Exactly the contract's "post-advance,
  `current.barId === armed.fireAt`."

The surface adds two fields: `autoFireOn: boolean` and `setAutoFire: (on: boolean) => void`.
Under D6-NO nothing else on `ConductorSurface` changes.

### 3.1 boundary-snap arming (D6-YES only)

The fire bar is one of two **structural** boundaries ahead of the cursor:

- **`next-bar`** (the default) — the next downbeat, `nextEmittedBarId(compiled, vm)`,
  exactly chunk 4's arm point. The "signal at top of N → fire at top of N+1" gesture.
- **`next-section`** — the next **section head** ahead (a `bar.sectionId` change), which
  may be several bars away. **Section heads only** — not Coda/Segno/Fine/repeat marker
  heads (Codex R3 MEDIUM): the walk reads `bar.sectionId`, so a marker that does not
  coincide with a section change is not a snap target. The VM is section-blind, so this
  resolver lives in `conductor-targets.ts`
  (which already has `cal` + the section-head machinery of `armableTargets`). It walks
  `stepVM` forward — the deterministic preview of the bars the MD's advances will emit —
  until the emitted bar enters a **new, non-null** section (different from the one we're
  in now), and returns that boundary bar:

```ts
// lib/conductor-targets.ts — next SECTION head ahead (forward stepVM preview); section
// heads only (bar.sectionId change), not Coda/Segno/Fine/repeat marker heads.
// `currentBarId` = the last-emitted bar (session.state.current.barId); VMState itself
// carries no `current`, so the caller passes it. undefined currentBarId ⇒ pre-roll.
export function nextSectionBoundaryBarId(
  compiled: CompiledRoadmap,
  cal: ChartCalibration,
  vm: VMState,
  currentBarId: string | undefined,
): string | undefined {
  const ordered = barsInOrder(cal);
  const secOf = new Map(ordered.map((b) => [b.id, b.sectionId]));
  const here = currentBarId ? secOf.get(currentBarId) ?? null : null; // current section
  let cur = vm;
  // BOUNDED (Codex R1 HIGH-3): if vm.holding is set, stepVM loops the held repeat
  // forever (roadmap-vm.ts:405/457) and would never reach a new section → freeze.
  // Cap the walk by compiled.cap (the VM's own termination backstop); undefined if
  // no boundary is found within it (a vamp with no section change ahead).
  for (let i = 0; i < compiled.cap; i++) {
    const step = stepVM(compiled, cur);
    if (!step.transition) return undefined;           // off the song end → no boundary ahead
    const newSec = secOf.get(step.transition.barId) ?? null;
    // Codex R2 MEDIUM: only a NON-NULL section that differs is a boundary. A bar with
    // sectionId === null is a valid unassigned gap (types.ts:97; canVerify doesn't require
    // full assignment, chart-calibration.ts:136) — skip it so a gap between sections A and B
    // is not mistaken for "the next section". Walk on until a real labelled head.
    if (newSec != null && newSec !== here) return step.transition.barId;
    cur = step.state;                                  // same section / null gap → keep walking (pure; stepVM returns {transition, state})
  }
  return undefined;                                    // no section change within the cap (e.g. an active hold)
}
```

The hook's `arm` takes an optional `fireAt: 'next-bar' | 'next-section'` (default
`'next-bar'` = chunk-4 behaviour) — a **structural** choice, never a raw count.
**Order matters (Codex R1 HIGH-2):** resolve the boundary, resolve the arm, and only
THEN store the local eligibility bit + dispatch — never mutate `armedFireAtEligible`
before the arm is known to succeed (a rejected arm must not clobber the bit for the
*previous* armed marker):

```ts
arm: (t, exit, fireAt = 'next-bar') => {
  if (!compiled || !cal || !session) return;
  const fireBar = fireAt === 'next-section'
    ? nextSectionBoundaryBarId(compiled, cal, session.state.vm, session.state.current?.barId)
    : nextEmittedBarId(compiled, session.state.vm);
  if (!fireBar) return;                                  // no such boundary ahead — nothing to arm against
  const armed = resolveArm(compiled, cal, t.barId, exit, fireBar);
  if (!armed) return;                                    // reject FIRST — no local-state mutation yet
  setArmedFireAtEligible(true);                          // only after the arm succeeds (see eligibility note)
  run({ kind: 'arm', armed });
},
```

**Eligibility in 5a is satisfied by construction (resolves Codex R1 MEDIUM-1).** Both
resolvers return a bar drawn from an **actual forward `stepVM` walk** — the
authoritative preview of what `advance` will emit — so the fire bar is forward-reachable
*by the walk itself*. The chunk-4 `fireAtEligible` (`conductor-targets.ts:211`) is a
**raw-bar-position heuristic**; running it here would *false-reject* a legitimate
boundary reached via a notated backward jump (its position is behind the cursor though
the walk reaches it). So 5a does **not** call `fireAtEligible` on the walk-derived bar —
the walk is the eligibility proof. `armedFireAtEligible` is therefore **invariantly true
when an arm succeeds in 5a**; it is retained (set `true`) to honour the chunk-4 frozen
contract `if (armedFireAtEligible && shouldAutoFire(...))` and stays the genuinely
load-bearing bit in **5b**, where dead-reckoning means the playhead may *not* hit
`fireAt` exactly and the arm-time forward check matters (then upgraded to a bounded
VM-walk per the chunk-4 Codex R5 note, §7). If the MD `redirect`s between arm and fire
the marked bar may fall off the path → the marker lingers as advisory (D4).

---

## 4. The cluster — opt-in toggle, honest telegraph copy

`ConductorCluster` gains one control and one copy change. Default OFF preserves §3.5's
"go-tap is the default and the floor."

- **Auto-fire toggle** (new prop `autoFire: boolean` + `onToggleAutoFire: () => void`),
  placed in the mode header beside "Local MD mode." Label: `Auto-fire ⃝ / ⏻`. Off by
  default.
- **(D6-YES only) "fire at" structural choice** in the arm flow — a two-way selector
  `Next bar / Next section` (`onArm` gains `fireAt: 'next-bar' | 'next-section'`).
  Default `Next bar`. This is a **structural** pick, never a raw bar count. When the
  resolver finds **no boundary ahead** (`nextSectionBoundaryBarId` → `undefined` — e.g.
  the MD is vamping, or already in the last section), the `Next section` option disables
  with "no section ahead." (There is no "ineligible fire bar" state in 5a — the walk only
  ever returns a reachable bar; §3.1.) Under D6-NO this control is absent; arm is
  next-bar-only.
- **Armed-summary copy keys on the toggle + hold state:**
  - auto-fire ON, not holding → `→ Chorus · fires at bar 24` (it will commit on arrival).
  - auto-fire ON, holding → `→ Chorus · release to fire` (the §3.5 hold guard, surfaced).
  - auto-fire OFF → `→ Chorus @ bar 24 · tap Go` (chunk-4 copy, unchanged).
- **Go (`onCommit`) is always present** regardless of the toggle — the floor. The MD can
  still fire early (before the fire bar) or override at any time; auto-fire only *adds* the
  on-arrival path.
- **Disarm always present** — the live MD override (§3.5 "MD override always live").

The cluster stays a **pure presentational** component (chunk-4 discipline: render +
callbacks, no session/PDF/validity), so it remains jsdom-testable with no chart render.

---

## 5. Edge cases (no reducer changes)

- **Fire bar becomes unreachable after arming.** If the MD `redirect`s or holds past the
  fire bar, the playhead may never land on `armed.fireAt`. The armed marker then **lingers
  as advisory display** ("change pending"). We do **NOT** auto-clear it (that would mean a
  reducer change + a reachability proof the frozen VM doesn't expose). The MD sees it
  pending and `disarm`s — the always-live override. Acceptable: a pending telegraph the MD
  can see and cancel is honest; a silently-vanishing one is not. (Recorded as D4.)
- **MD go-taps Go before arrival.** `commit` fires immediately at the current position
  (chunk-3: applyOverride + stepVM-once). Auto-fire never gets the chance (armed cleared).
  Both paths coexist; go-tap wins by happening first.
- **Auto-fire toggled ON mid-arm.** Next `advance` that lands on the fire bar fires it.
  Toggled OFF mid-arm → reverts to needing a go-tap. The toggle is pure UI state; it never
  touches the wire.
- **Song end / `done`.** `advance` is already guarded (`canAdvance` false at `vm.done`);
  no advance ⇒ no auto-fire evaluation. A jump armed at the last bar fires on the advance
  that reaches it, then `done` follows normally.
- **Re-entrancy.** The two-dispatch chain is synchronous within one event handler; React
  batches the single `setSession`. There is no window where a second `advance` interleaves.

---

## 6. Decisions

- **D1 — auto-fire on arrival needs no clock in 5a (recommend YES).** Because 5a never
  auto-advances, `current === fireAt` is the MD's *exact* tapped position; §3.5's clock
  gate guards *estimated* position (5b). 5a's gate = exact-arrival + the §3.5 hold/vamp
  guard. Strictly safer than the case §3.5 fears. If Codex/Graham want literal §3.5
  ("clock present" required even here), 5a auto-fire would be inert until 5b ships a tempo
  — i.e. chunk 5 collapses to nothing buildable now. Recommend YES (the split).
- **D2 — defer ALL clock/tempo (manual tap-tempo, static BPM, and audio) to 5b
  (recommend YES).** A tempo earns its keep only by driving auto-*advance* (the
  motion-smoother), which is §8.2-1-gated. Manual-tempo-for-display alone is a weak feature
  and would leave a half-built clock read in `shouldAutoFire`. 5a reads no clock; 5b owns
  the whole clock layer coherently. Alternative: ship manual tap-tempo in 5a for the
  click/display only — more surface, little value, recommend against.
- **D3 — auto-fire is opt-in, default OFF (recommend YES).** §3.5: "go-tap is the default
  and the floor." The toggle is the MD's standing override; OFF reproduces chunk 4 exactly.
- **D4 — stale armed lingers as advisory, MD disarms; no auto-clear (recommend YES).**
  Keeps the reducer frozen and avoids an unreachability proof. A visible-and-cancellable
  pending marker is more honest than a silent vanish.
- **D5 — auto-fire evaluated synchronously in the `advance` action chain, never in a
  `useEffect` (recommend YES).** The chunk-4 parity lesson: no frame-critical conductor
  transition behind a deferred effect; chain the pure dispatches on returned values, one
  `setSession`.
- **D6 — the fire point is a structural boundary (Idea 1a, Graham); does 5a include the
  `next-section` snap, or only the `next-bar` default? (recommend YES — include it.)** The
  fire bar is *always* a structural boundary — never a raw bar count — because the real
  gesture is "signal at the top of this bar, change at the top of the next" (default) or
  "make the change when we hit the chorus" (section). This is the one real scope decision.
  - **D6-YES (boundary-snap, §3.1):** the MD picks `Next bar` (default) or `Next section`.
    The section option gives a real telegraph window aligned to musical structure and
    makes auto-fire meaningfully different from a go-tap. Cost: a `nextSectionBoundaryBarId`
    resolver (~14 lines, pure, section-aware, bounded by `compiled.cap`), an `arm` arg, and
    a two-way selector in the cluster. (`armedFireAtEligible` stays invariantly-true in 5a
    — the walk proves reachability — and becomes load-bearing only in 5b; §1.)
  - **D6-NO (next-bar-only):** auto-fire fires on the very next downbeat. Smallest possible
    build, but the telegraph window is one bar and `armedFireAtEligible` stays vestigial —
    auto-fire becomes "your next advance also commits the armed jump," a thin win over the
    go-tap.
  - **Lean:** YES. Next-bar-only undersells the feature and leaves a vestigial contract
    field; the section snap is the version worth shipping, is modest scope, and matches how
    MDs actually call a change. Flagging it as a decision because it is the difference
    between a coherent feature and a marginal one — your call on whether the extra surface
    is worth it now or deferred to a 5a-follow-on.

5b's open items are the §8.2-1 epic OQs (§7).

---

## 7. Chunk 5b — the clock layer (GATED, fenced here, not built)

Recorded so the seam stays ready; **do not build until §8.2 OQ-1 closes.**

- **Blocked on (epic §8.2 OQ-1):** listener placement (MD device vs. separable taped
  node); clock/phase latency across the relay (likely invisible at bar granularity —
  confirm); behaviour when the listener drops; and the live source-quality validation that
  §5.1 makes a precondition of turning audio-tempo on.
- **What 5b adds (no signature breaks):**
  - **Telemetry → MD re-emit.** A listener computes tempo/downbeat; it is *telemetry*, not
    a writer (epic finding 6). The MD ingests it and dispatches `{ kind: 'clock', clock }`
    under its own `(epoch, seq)` — the chunk-3 `clock` payload already exists and applies.
  - **Dead-reckoned auto-advance** (the §5.1 motion-smoother): between anchors the clock
    advances the playhead at tempo, **re-zeroed at every section boundary + MD cue**, so
    drift is bounded. This is the part that makes `advance` no longer purely manual — and
    the part that makes the §3.5 *confidence* gate load-bearing.
  - **The full §3.5 confidence gate in `shouldAutoFire`:** clock present AND
    bars/beats-since-last-anchor under a bound AND confidence ≥ HIGH AND no hold/vamp. The
    5a guards stay; 5b ANDs the estimated-position conditions on top. `armedFireAtEligible`
    becomes genuinely load-bearing (the playhead may not hit `fireAt` exactly under
    dead-reckoning → the arm-time forward check matters).
  - **Degrade ladder** (§5.1): live audio → last-known → static BPM → seek-only; coast at
    last-good tempo on a noisy mix, never jitter.
- **Why the seam is already shaped right:** `clock` payload, `ClockState`, and the
  `shouldAutoFire(session)` signature are all in place; `fireAtEligible` may be upgraded to
  a bounded VM walk *without changing its signature* (chunk-4 Codex R5 note). 5b is
  additive.

---

## 8. Test plan

Pure-lib (vitest node default), mirroring the chunk-4 seam tests:

- **`shouldAutoFire` (pure):**
  - nothing armed → false.
  - armed, `current.barId !== fireAt` (before arrival) → false.
  - armed, `current.barId === fireAt`, `holding == null` → **true**.
  - armed, at fireAt, `holding != null` (vamping) → false (§3.5 hold guard).
  - no `current` (fresh session) → false.
  - **fires once:** after a `commit` clears `armed`, a subsequent evaluation → false.
- **`dispatch` chain invariant (pure, controller-level):** `initSession` → `arm(default
  fireAt)` → advance until `current === fireAt`; assert that an `advance`-then-`commit`
  pair lands the committed jump cursor with `armed` cleared (the same end-state a go-tap
  produces) — the regression guard that auto-fire ≡ go-tap in outcome, differing only in
  trigger.
- **`nextSectionBoundaryBarId` (pure, D6-YES):** returns the first emitted bar whose
  `sectionId` is **non-null and differs** from the current section; mid-section cursor walks
  to the next head; **a null-`sectionId` gap between two labelled sections is skipped, not
  returned** — walking past unassigned bars to the real next head (Codex R2 MEDIUM);
  last section (no boundary ahead) → `undefined`; section-less / all-null `sectionId` chart →
  `undefined` (no snap, falls back to next-bar at the call site); across a repeat/volta the
  walked boundary matches the bars `advance` actually emits (walk-equivalence); a
  **pass-excluded volta on the way** is skipped by the walk → it returns the *real* next
  section bar (never an unreachable one — MEDIUM-1). **Vamping (`vm.holding` set) with no
  section change ahead → `undefined` within `compiled.cap`** (bounded-walk guard, HIGH-3),
  NOT an infinite loop.

Hook (jsdom, `// @vitest-environment jsdom`, `afterEach(cleanup)`, renderHook + act):

- auto-fire OFF: advance onto the fire bar leaves `armed` set (no auto-commit) — chunk-4
  parity.
- auto-fire ON: advance onto the fire bar auto-commits in the **same** act (single
  `setSession`); `armed` cleared, cursor jumped.
- auto-fire ON but `holding`: advance onto the fire bar does **not** fire (gate refuses);
  dispatch the Release vamp redirect (which clears `holding`), then the next advance fires.
- toggle OFF mid-arm → reverts to go-tap.

Cluster (jsdom, RTL): toggle renders + flips `onToggleAutoFire`; armed-summary copy keys
on `autoFire` + holding (three variants); Go + Disarm always present.

`page.tsx` wiring (the toggle prop + surface threading) stays **manual-UAT** per the
chunk-4 precedent — the pure seam (`shouldAutoFire` + the dispatch chain) carries the
regression guard.

---

## 9. Build outline (5a only)

1. **`shouldAutoFire` body** (`lib/conductor-session.ts`) — replace the stub with §2;
   pure tests.
2. **(D6-YES) `nextSectionBoundaryBarId`** (`lib/conductor-targets.ts`) — §3.1 section-head
   forward preview; pure tests. (Skip under D6-NO.)
3. **Hook** (`lib/use-conductor-session.ts`) — `autoFireOn`/`setAutoFire` state,
   `armedFireAtEligible` capture-at-arm/clear-on-fire-or-disarm, the synchronous
   advance→auto-commit chain (§3), and (D6-YES) `arm(fireAt: 'next-bar' | 'next-section')`
   via `nextSectionBoundaryBarId` (§3.1); hook tests.
4. **Cluster** (`components/ConductorCluster.tsx`) — `autoFire` + `onToggleAutoFire` props,
   toggle in the header, hold-aware armed-summary copy (§4), and (D6-YES) the "fire at"
   Next bar / Next section selector; cluster tests.
5. **Wire `page.tsx`** (manual-UAT) — thread `autoFire`/`setAutoFire` from the hook surface
   into the cluster; no other page changes (single device, no transport).

Net: zero changes to `conductor-state.ts` (frozen) and zero signature changes to
`shouldAutoFire` / `fireAtEligible` (frozen). 5b (§7) is a separate, §8.2-1-gated chunk.
