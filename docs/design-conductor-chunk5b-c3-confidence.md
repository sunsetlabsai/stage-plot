# Conductor 5b · chunk 3 — the confidence gate (clock-driven auto-fire, the trusted slice)

**Status:** DESIGN — **pre-Codex**, DESIGN-ONLY (no code). Builds on chunk 2 (the static-BPM
motion driver + `driverRef`/`cfgRef` + the in-tick tempo reconcile, SHIPPED to main `9bbd1de`),
chunk 1 (`ClockReckoning` + Invariant (P) + `reckonAfter`/`alignReckoning`, SHIPPED `57b8890`),
and chunk 0 (`song.bpm` + click + `lib/tempo.ts`, SHIPPED `3eae7ae`). Parent authority:
`docs/design-conductor-chunk5b-clock.md` v0.6.6 (Codex R9 GO) — this is the build spec for that
parent's **§5.2 confidence gate** (the `positionTrusted` consumer), **scoped to the static-BPM +
manual rungs** — the only rungs reachable before audio telemetry (parent item 4). It does not
reopen the parent (GO'd).

**One-line frame.** Chunk 2 made the redline **move on its own**; chunk 3 lets a **trusted**
clock arrival **auto-commit an armed change** — and, just as importantly, makes an **untrusted**
one *decline* and defer to the MD's tap. "Clock owns speed" already landed; chunk 3 is the first
place "clock owns speed *within the bounds the MD's last truth licenses*" becomes a structural
commit. `shouldAutoFire` stays the verbatim 5a exact-arrival predicate — chunk 3 adds **one
gate** (confidence) and routes the clock advance through the **same** rising-edge chain.

---

## 0. What chunk 3 IS, and (sharply) what it is NOT

The parent §5.2 names behaviours whose full form needs machinery later chunks build (the `live`
rung's HIGH-confidence warrant needs audio telemetry; the backward `seek` re-seat is its own
chunk). Drawing the fence honestly is most of the review surface.

**Chunk 3 IS:**
- a pure **`clockConfidenceOk(reckoning, rung)`** + the **`CLOCK_CONFIDENCE_BOUND_BARS = 8`**
  const (parent §7-4 ≈ one phrase) in `lib/conductor-clock.ts` — unit-testable, timer-free;
- **one gate added to `applyWithAutoFire`**: an auto-fire commits only if the **arrival** was
  trusted (`positionTrusted`) **OR** `clockConfidenceOk(arrivalReckoning, rung)`. `shouldAutoFire`
  is untouched (verbatim 5a);
- **routing the clock-driven advance through the same `applyWithAutoFire` chain** — relaxing
  chunk 2's "clock arrivals DEFER auto-fire" (driveClockTick did a plain `dispatch(advance)`),
  with the confidence requirement falling out of `!positionTrusted` (parent §5.2);
- the **caller-agnostic** structure: the requirement keys on **how `current` arrived on
  `fireAt`** (the arrival's `positionTrusted`), NOT on which action is running — so `advance()`,
  the motion tick, and `release()` all pass the same expression and the answer falls out of the
  primary-leg `reckonAfter` provenance.

**Chunk 3 IS NOT:**
- **NOT** the `live`/`coasting` rungs. No telemetry exists (parent item 4), so
  `computeStaticRung` still only ever yields `static-bpm` or `manual`. `clockConfidenceOk`
  encodes the full ladder for forward-compat but `live` returns `false` here (it needs a
  HIGH-confidence input the wire can't yet produce) — see §3.
- **NOT** backward correction / the `seek` directive (parent §5.4, β recommended for v1; α is a
  separate chunk). Chunk 3 never moves position backward.
- **NOT** any change to `shouldAutoFire`, the reducer (`conductor-state.ts`), the broadcast wire,
  or follower behaviour. It is MD-local, like chunks 1–2.
- **NOT** a change to the chunk-2 stall logic (`owed >= 2 ⇒ stall`). The §7-4 bound is consumed
  **only** by `clockConfidenceOk`; the stall mechanism stays as shipped.

---

## 1. The gate keys on the ARRIVAL's provenance, not the caller (parent §5.2, grounded)

`shouldAutoFire(session)` stays verbatim 5a: `armed ∧ current.barId === fireAt ∧ holding == null`,
read on the rising edge `!shouldAutoFire(before) && shouldAutoFire(after)`. It is the *exact-arrival*
predicate, nothing more. Folding confidence into it would **regress 5a**: a manual tap onto `fireAt`
during a coasting/off clock must still fire.

The confidence requirement instead keys on `reckoning.positionTrusted` of the **arrival** — "how
did `current` get onto `fireAt`?" — NOT "what action am I running now?" (the per-action framing has
the parent-§5.2/Codex-R6 **release hole**: `release` is a manual redirect that does not *cause* the
arrival; it merely *opens* a gate over a position the **clock** may have placed). The clean form:

> An auto-fire commits **iff** `opened ∧ autoFireOn ∧ armedFireAtEligible ∧
> (arrivalReckoning.positionTrusted ∨ clockConfidenceOk(arrivalReckoning, rung))`.

Where **`arrivalReckoning` is the primary-leg `reckonAfter` result** — and that is what makes it
caller-agnostic. The three openers, all correct under one rule (verified §6):

| Opener | primary-leg provenance | `current` moves? | `arrivalReckoning.positionTrusted` | confidence required? |
|---|---|---|---|---|
| manual `advance()` onto `fireAt` | `manual` | yes (→ re-anchor) | **true** | no — fires (5a floor) |
| clock-driven advance onto `fireAt` (the tick) | `clock` | yes (`+1`, not-trusted) | **false** | yes — `clockConfidenceOk` |
| `release()` over a parked `fireAt` | `manual` | **no** (redirect leaves `current` put) | **inherited** from how `current` was placed | iff clock-placed |

The last row is the load-bearing one: `release` doesn't move `current`, so `reckonAfter` no-ops
(Invariant (P), `sameStep`) and returns the **incoming** reckoning unchanged → `positionTrusted`
is whatever placed `current`. A release over a **manually-placed** parked `fireAt` (the genuine
5a vamp-release) inherits `true` → fires unconditionally. A release over a **clock-placed**
`fireAt` inherits `false` → must pass `clockConfidenceOk`. **The hole is closed by construction,
not by special-casing.**

This is exactly parent §5.2's `applyWithAutoFire(before, res, { requireClockConfidence:
!reckoning.positionTrusted })`, but expressed as "compute the primary-leg reckoning with the
caller's provenance first, then the requirement is `!primaryReck.positionTrusted`."

---

## 2. The concurrency core: the motion tick cannot call the *closure*'s `applyWithAutoFire` (MINE)

This is the hazard the naive plan ("just call `applyWithAutoFire` from `driveClockTick`") would
ship, and it is the time-axis class I am sweeping for up front.

The motion driver interval is a layout effect keyed `[enabled, clockOn]` (set up once per toggle,
`use-conductor-session.ts:392`). Its `driveClockTick` callback is therefore **frozen at the render
that created the interval**. The shipped chunk-2 tick reads **only refs** (`driverRef`/`cfgRef`)
precisely so the stale closure is a non-issue. But the shipped `applyWithAutoFire`
(`:294`–`:334`) reads render-scoped state directly:

- `autoFireOn` (`:306`), `armedFireAtEligible` (`:306`) — **render state, stale in the frozen tick**;
- `rung` — render-scoped `const` (`:420`), **stale in the frozen tick**;
- `setOutcome`, `setArmedFireAtEligible`, `setSession`/`setReckoning` (via `writeDriver`) — `useState`
  setters, **stable across renders → safe even frozen**.

So if the frozen tick called the frozen `applyWithAutoFire`, it would gate on a **stale**
`autoFireOn`/`armedFireAtEligible`/`rung` (whatever they were when the MD last toggled the clock
on — wrong). The shipped chunk-2 tick avoids this only because it does NOT call `applyWithAutoFire`.

**Fix — make the two render-state toggles a ref, pass `rung`+`provenance` as args:**

- Add `gateRef = useRef({ autoFireOn, armedFireAtEligible })`, mirrored in a **layout** effect
  keyed `[autoFireOn, armedFireAtEligible]` (the cfgRef pattern, `:164`–`:167`). The ref *object
  identity* is stable, so the frozen closure dereferences a live `.current`. Layout (not passive)
  for the same reason cfgRef is: a due tick must never read a stale toggle across the
  commit→passive gap. `setArmedFireAtEligible(false)` after a fire still mirrors next commit — a
  one-tick (~80 ms) lag, and it **fails safe** (see §6-c).
- `applyWithAutoFire` reads `gateRef.current` for the two toggles (works for both the fresh event
  handlers and the frozen tick — refs are always current), and takes **`opts: { provenance:
  'manual' | 'clock'; rung: ClockRung }`**:
  - the primary-leg `reckonAfter` uses `opts.provenance` (was hardcoded `'manual'`);
  - the confidence check uses `opts.rung`.

`rung` does **not** need a ref: the manual callers (`advance`/`redirect`/`align`, fresh closures)
pass the live render `rung`; the tick passes the rung it computes from its own fresh refs (which is
provably `static-bpm` at the advance point — past the `b!=null`/`!stalled`/`!done`/`owed===1`
guards). `clockOn` likewise needs no ref: the interval only exists while `clockOn` was true, so the
frozen `true` is correct, and the layout cleanup tears the interval down in the same commit a
toggle-off lands.

---

## 3. `clockConfidenceOk` — pure, in `lib/conductor-clock.ts`

```ts
export const CLOCK_CONFIDENCE_BOUND_BARS = 8; // parent §7-4 ≈ one phrase

// Is a CLOCK-placed (untrusted) arrival on an armed fireAt confident enough to auto-commit?
// Consulted ONLY when the arrival is untrusted (positionTrusted === false). Motion is NEVER
// gated by this — only the structural auto-commit (parent §5.2: "degrade precision, never honesty").
export function clockConfidenceOk(r: ClockReckoning, rung: ClockRung): boolean {
  if (r.alignedAtMs === null) return false;                     // never trued (MINE — see below)
  if (r.barsSinceAnchor > CLOCK_CONFIDENCE_BOUND_BARS) return false; // past the trust horizon
  switch (rung) {
    case 'static-bpm': return true;   // the stated-BPM click IS the warrant (no audio confidence to read)
    case 'live':       return false;  // needs a HIGH-confidence telemetry input — arrives in item 4
    case 'coasting':   return false;  // last-known tempo: motion yes, auto-commit no
    case 'manual':     return false;  // 5a floor — nothing machine-placed to be confident about
  }
}
```

- **The `alignedAtMs === null` never-trued guard is MINE (no Codex round).** An unconfirmed start
  has `alignedAtMs === null` *and* `barsSinceAnchor === 0`, so the bound passes *vacuously* — a
  clock arrival within the first bars would auto-fire a position **no human confirmed**, violating
  "MD owns place." On the *shipped* wire this is essentially unreachable (the first placement of
  `current` is always a manual `advance`/align → `reckonAfter('manual')` → `alignedAtMs = now`), so
  it is **defensive / forward-compat** (a future broadcast follower or `seek` could place `current`
  without an align). Cheap, honest, kept.
- **`live` returns `false` in chunk 3 — by design, not a stub.** No telemetry exists, so the wire
  cannot produce a HIGH-confidence `live` warrant; the only honest answer is "not yet auto-fireable."
  Item 4 will extend the signature (add a `confidence` argument) so `live` can return `true` at
  sustained HIGH. Noting the signature **will** grow keeps this from being a hidden assumption.
- The bound is consumed **only** here. The chunk-2 stall (`owed >= 2`) is untouched.

---

## 4. Routing the clock advance through the chain (`driveClockTick`)

Chunk 2's `owed === 1` tail (`:373`–`:381`) is:

```ts
const res = dispatch(s, { kind: 'advance' }, now);
setOutcome(res.outcome);
if (res.outcome !== 'applied') return;
const nextReck = reckonAfter(r, s.state.current, res.session.state.current, 'clock', now);
driverRef.current = { session: res.session, reckoning: nextReck, stalled: st };
setSession(res.session); setReckoning(nextReck);
```

Chunk 3 replaces it with the single delegated call:

```ts
const res = dispatch(s, { kind: 'advance' }, now);
applyWithAutoFire(s, res, { provenance: 'clock', rung: 'static-bpm' });
```

- `applyWithAutoFire` already does `setOutcome` + the `outcome !== 'applied'` early-return, the
  primary-leg `reckonAfter` (now `'clock'`), the rising-edge gate (now with the confidence
  predicate), the chained commit, and the `writeDriver`. The clock path inherits all of it.
- **`rung: 'static-bpm'` is provably correct here**: the tick reaches the advance only past
  `b != null` (`:346`), `!stalled` (`:346`), seeded (`:347`), `!vm.done` (`:348`), and
  `owed === 1`. (Equivalently `computeStaticRung({ clockOn: true, bpm: b, stalled: false, done:
  false })` — the literal with this comment is honest and avoids re-reading state.)
- **`writeDriver`'s stall-clear is moot on this path.** `writeDriver` clears `stalled` iff the
  reckoning identity changed (`:177`); a clock advance produces a new reckoning, so it *would*
  clear — but `stalled` is already `false` here (the `:346` guard returns before the advance when
  stalled). So delegating to `writeDriver` (which chunk 2 deliberately avoided "because a clock
  advance must not clear a stall") is safe: the stall it must not clear cannot be set at this point.
  The design notes this explicitly so the chunk-2 comment's intent is preserved, not silently lost.
- The primary-leg `reckonAfter` reads `driverRef.current.reckoning`, which equals the tick's local
  `r` (the tempo-establish branch wrote them in sync, `:358`; otherwise unchanged) — no divergence.

The `applyWithAutoFire` body, after chunk 3 (shape, grounding the build):

```ts
const applyWithAutoFire = (
  before: ConductorSession,
  res: ReturnType<typeof dispatch>,
  opts: { provenance: 'manual' | 'clock'; rung: ClockRung },
) => {
  setOutcome(res.outcome);
  if (res.outcome !== 'applied') return;
  const now = Date.now();
  const primaryReck = reckonAfter(
    driverRef.current.reckoning, before.state.current, res.session.state.current, opts.provenance, now,
  );
  const { autoFireOn: afOn, armedFireAtEligible: elig } = gateRef.current;
  const opened = !shouldAutoFire(before) && shouldAutoFire(res.session);
  const confident = primaryReck.positionTrusted || clockConfidenceOk(primaryReck, opts.rung);
  if (afOn && elig && opened && confident) {
    const afterFire = dispatch(res.session, { kind: 'commit' }, Date.now());
    setOutcome(afterFire.outcome);
    const fired = afterFire.outcome === 'applied';
    const nextReck = fired
      ? reckonAfter(primaryReck, res.session.state.current, afterFire.session.state.current, 'autofire', now)
      : primaryReck;
    writeDriver(fired ? afterFire.session : res.session, nextReck);
    setArmedFireAtEligible(false);
    return;
  }
  writeDriver(res.session, primaryReck);
};
```

The three manual callers change only the call site:
`applyWithAutoFire(s, dispatch(...), { provenance: 'manual', rung })`.

---

## 5. The §5.2 writer table — what changes, what is preserved

`reckonAfter`'s three provenance arms are unchanged. The clock advance now stamps `'clock'`
(was: a direct `reckonAfter('clock')` in the tick), the auto-fire commit still stamps `'autofire'`
(flips `positionTrusted` only — counters left at the arrival's values, no R4 double-count), and a
**non-firing** clock arrival (low confidence / `autoFireOff` / not opened) falls to `writeDriver(res,
primaryReck)` with `positionTrusted = false` and `barsSinceAnchor + 1`. Invariant (P) is intact:
provenance/counters ride the actual `current`-write, never the action or the `applied` flag.

---

## 6. My own adversarial sweep (the time-axis + the edges, before Codex)

- **(a) Frozen-closure gate inputs** — §2. The tick calls the frozen `applyWithAutoFire`; the two
  render-state toggles MUST come from `gateRef` (live identity), `rung` is passed (computable
  fresh), setters are stable. Without `gateRef` the gate reads stale toggles. **Closed by gateRef.**
- **(b) Long-vamp defer falls out for free.** A `holding` vamp loops the body; the clock advances
  each loop (`reckonAfter('clock')` counts each new `{barId, pass}`), so `barsSinceAnchor` grows
  past the bound after a long vamp. A later `release` then inherits `positionTrusted = false` and a
  `barsSinceAnchor > 8` → `clockConfidenceOk` refuses → **deferred to the MD's tap** (parent §5.3).
  No special-casing — the bound + arrival-keyed provenance produce it.
- **(c) Stale-true `gateRef.elig` after a fire/commit/disarm cannot double-fire.** All of
  `arm`/`commit`/`disarm`/the auto-fire path set `armedFireAtEligible` *and* the session's `armed`
  in the same gesture; only `elig` lags (mirror next commit). After a commit the session's
  `armed === null`, so `shouldAutoFire(after) === false` → `opened === false` → the rising edge
  can't re-open. The session armed-state is the real backstop; `elig` is belt. Stale-**false**
  `elig` (just after `arm`, before mirror) merely refuses for ≤1 tick — conservative, and the clock
  cannot reach a fresh `fireAt` within 80 ms of arming anyway. **Fails safe both directions.**
- **(d) Strand-past-bound = the chunk-2 residual, strictly improved.** Past the bound (or
  auto-fire-off), a clock arrival on `fireAt` is refused, and the *next* tick's advance steps
  **off** `fireAt` (`shouldAutoFire`: `true → false`, not a rising edge → no fire), stranding the
  marker. This is exactly chunk-2's behaviour today (chunk 2 strands **every** clock arrival — it
  never auto-fires). Chunk 3 is strictly better: it fires within bound+confident, strands only past
  it. A manual `commit()` ("Go now") still jumps to the armed target regardless of `current`'s
  position, so **no state corruption, no lost marker** — the MD recovers it with one tap. UX-only
  follow-on (see §7).
- **(e) Manual advance between ticks re-anchors cleanly.** A manual `advance()` →
  `reckonAfter('manual')` re-zeros both axes (`positionTrusted = true`, `barsSinceAnchor = 0`,
  `motionBaselineAtMs = now`, `barsAtMotionBaseline = 0`, `baselineTempoBpm` carried). The next tick
  reckons from the new baseline; a subsequent clock arrival is untrusted again. No desync.
- **(f) `rung` at a release-over-clock-placed `fireAt` is the *current* rung** (fresh render rung
  in the `release` handler). If the clock has since stalled (`rung === 'manual'`) → refuse → defer.
  If still healthy `static-bpm` within bound → fire. Conservative-correct.
- **(g) Never-trued guard** — §3. Unreachable on the shipped wire (seed is always a manual
  placement → `alignedAtMs != null`), kept defensive for future broadcast/`seek`. Asserted as a
  pure unit, not relied on for an integration path that can't occur.
- **(h) JS is single-threaded** — the tick (macrotask) and the event handlers never run truly
  concurrently; the only hazard is stale *closure* reads, all of which route through refs. There is
  no read-after-`setState` hazard: every commit dispatches on a *value* (`res.session`) with a
  single `writeDriver`.

---

## 7. Decisions / open questions for Graham

1. **Bound = 8 bars** (parent §7-4 "≈ one phrase"). `CLOCK_CONFIDENCE_BOUND_BARS = 8`. Confirm, or
   pick another phrase length. (Reused only by the gate; the stall is separate.)
2. **`live` returns `false` this chunk** (no telemetry). Confirms scope = static-bpm + manual only.
   Item 4 extends the signature for the HIGH-confidence warrant. Agree?
3. **Strand-past-bound UX** (§6-d). The clock can step past an un-auto-fired marker past the trust
   bound; the MD recovers with a manual `commit()`. Recommend: **accept for v1** (strictly better
   than chunk 2, no corruption), file a UI "marker pending — past trust bound, tap to confirm" hint
   as a fast-follow. Agree, or want the hint in this chunk?
4. **β (no backward motion) stays the v1 stance** (parent §5.4). Chunk 3 never moves position
   backward; α/`seek` remains a separate future chunk. (No change asked — flagging that chunk 3
   does not touch it.)

---

## 8. Build outline (NOT to be built until Codex GO + Graham's go-ahead)

1. `lib/conductor-clock.ts`: add `CLOCK_CONFIDENCE_BOUND_BARS` + `clockConfidenceOk(r, rung)`
   (pure). **Tests:** never-trued (`alignedAtMs===null` ⇒ false), bound boundary (`8` ⇒ true, `9`
   ⇒ false), each rung (`static-bpm` true within bound, `live`/`coasting`/`manual` false).
2. `lib/use-conductor-session.ts`:
   - add `gateRef` + its layout mirror (`[autoFireOn, armedFireAtEligible]`);
   - `applyWithAutoFire` → `opts: { provenance; rung }`, read `gateRef`, add the `confident`
     predicate, primary-leg uses `opts.provenance`;
   - the three manual callers pass `{ provenance: 'manual', rung }`;
   - `driveClockTick` `owed===1` tail → `applyWithAutoFire(s, res, { provenance: 'clock', rung:
     'static-bpm' })`.
3. **Tests** (the fake-`setInterval` + `Date.now` spy pattern; assert post-commit invariants — RTL
   `act()` collapses the commit→passive window, so the gateRef mirror is deterministic under `act`):
   - **clock arrival auto-fires** within bound + trued + `autoFireOn` (current = target);
   - **clock arrival refuses** when `barsSinceAnchor > bound` (no fire; current steps past next
     tick; marker still armed; manual `commit()` recovers);
   - **clock arrival refuses** when `autoFireOn === false` (5a parity — clock never auto-commits);
   - **release over a clock-placed `fireAt`** refuses without confidence and **fires** with it
     (the R6 hole, both directions);
   - **manual advance onto `fireAt` fires unconditionally** with the clock coasting/off (5a floor);
   - **long-vamp defer**: vamp past the bound, then release ⇒ refused.
4. Gate: `npm test` + `npm run lint` + `npx tsc --noEmit` + `npm run build` (report the test-count
   DELTA). No new UI surface (the strand hint, if chosen, is its own item).

**Scope check.** No reducer change, no wire/broadcast, no follower change, no `shouldAutoFire`
change, no stall-logic change. One pure helper + one gate + one ref + one routing swap.
