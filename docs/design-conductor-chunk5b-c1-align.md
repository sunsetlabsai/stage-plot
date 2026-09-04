# Conductor 5b · chunk 1 — the MD align / true-up tap + re-anchor (the position primitive)

**Status:** **DESIGN-DONE — Codex R2 GO** (no HIGH/MEDIUM; one LOW wording nit folded — the
`anchor: null` gloss now reads "no human/trust anchor ever asserted", §2.1). Build state tracked in `docs/INDEX.md`, not here. Builds on chunk 0 (`song.bpm` + click +
tap-tempo, SHIPPED to prod `3eae7ae`) and the parent clock-layer design
`docs/design-conductor-chunk5b-clock.md` (v0.6.6, Codex R9 GO). This doc is the build spec for
**§8 item 1** of that parent; it does **not** reopen the parent (it is GO'd).

**R1 folds:** (MEDIUM — `anchor` semantics) the machine-placement rows (`autofire`/`clock`)
no longer overwrite `anchor`; it moves **only** on a manual re-anchor, so it unambiguously
means "last human anchor" (parent §5.1:341), `current` carries the machine-placed position,
and "chunk 2 adds a consumer, not a reshape" holds (§2.1/§2.2/§5.5). (LOW — test gap) added a
chained auto-fire **binding** test (advance-opened + release-opened) proving the final
reckoning gets the autofire stamp with no double-count (§7).

**One-line frame.** Chunk 1 builds the *position-authority machinery* — the MD-local
`ClockReckoning` state and the single **Invariant (P)** chokepoint that decides, on every
dispatch, whether position trust re-anchors — plus the **align / true-up tap**: the gesture
by which a human asserts *"we are here, on the downbeat, now."* It is **the load-bearing half
of "clock owns speed, MD owns place"** (parent §1). It stands alone atop the chunk-0 click,
**before any audio or motion driver exists**.

---

## 0. What chunk 1 is, and (sharply) what it is NOT

The parent epic threads one clock across four build chunks. The single most important thing
for a clean review is an honest fence, because the parent's §8 item-1 test list *names tests
that need machinery chunk 1 does not yet build*. Drawing that fence is most of this doc.

**Chunk 1 IS:**
- the `ClockReckoning` MD-local state object (parent §5.1b) + its init / reset lifecycle;
- **Invariant (P)** (parent §5.2) implemented as **one chokepoint** every dispatch flows
  through — *re-anchor iff the reduce produced a new `current`* — closing the R6/R7/R8
  per-caller-stale-trust class **by construction**, not by enumerating callers;
- the **align / true-up tap**: seed-the-start + correct-drift, **forward-only under β**,
  **MD-local / off the wire** (no `ConductorMessage`, no seq, no broadcast on a mid-song
  true-up);
- one thin UI affordance to reach the gesture.

**Chunk 1 is NOT (these are later chunks — fenced in §6 with reasons):**
- **the motion driver** (the rAF/timer loop that auto-*advances* the playhead). No loop
  exists in chunk 1. So *nothing reads* the motion axis yet, and **clock over-run cannot
  occur** → the parent's "clock-overrun degrades to `manual` (β)" and "align cancels pending
  motion" tests are **chunk 2**, not chunk 1 (§6).
- **the wire `ConductorClock`** (`rung`/`tempoBpm`/`confidence`) and the §4.1 ladder — chunk 2.
- **the confidence gate** (`clockConfidenceOk`, `!positionTrusted` consumption) — chunk 3.
  Chunk 1 *writes* `positionTrusted` correctly; chunk 3 is the first *reader*.
- **audio telemetry / detector / shadow mode** — chunk 4.
- **backward re-seat** (the `seek` directive) — deferred α chunk (parent §5.4).

So chunk 1 is mostly *substrate*: correct bookkeeping + the one human gesture that writes it.
The visible payoff lands in chunk 2 when the driver consumes the reckoning. We ship the
substrate first because Invariant (P) — the thing three Codex rounds (R6/R7/R8) bled over —
is far cheaper to get right *once*, in isolation, than to retrofit under a live motion loop.

---

## 1. Grounding: the shipped current-writers (the whole basis of Invariant (P))

Verified against `lib/conductor-state.ts` and `lib/conductor-session.ts` at `3eae7ae`:

| reduce payload | writes `current`? | line | note |
|---|---|---|---|
| `advance` | **maybe** | `:218` | `current: r.transition ?? state.current` — **null transition leaves `current` put** |
| `commit` (Go-now) | **maybe** | `:244` | same `?? state.current`; also `:234` no-armed and `:238` stale-clear return **without a step** |
| `redirect` | **never** | `:223` | moves `vm` seed only; `current` re-emits on the *following* advance |
| `arm` / `disarm` / `clock` | **never** | `:228`/`:231`/`:248` | |

So the **exhaustive** set of `current`-writes in chunk 1 is: a *manual* `advance`, a *manual*
"Go now" `commit`, and the *auto-fire* `commit` chained inside `applyWithAutoFire`
(`use-conductor-session.ts:149`). `seek` is the only future addition (parent §5.4). Every one
of these can also be a **no-op on `current`** (the `?? state.current` rows). This table is
exactly why Invariant (P) keys on *the `current`-write*, never on *the action* or *the
`applied` outcome* (parent §5.2, R8).

The hook's two dispatch seams (also `3eae7ae`):
- **`run(payload)`** — used by `arm()`, `commit()`, `disarm()`. Plain dispatch + `setOutcome`
  + `setSession` on `applied`.
- **`applyWithAutoFire(before, res)`** — used by `advance()`, `redirect()`. The rising-edge
  chain that *may* fire a chained `commit` on the same tick (`:144`–`:156`).

Both seams must update reckoning (§2). Note **Go-now `commit()` flows through `run`, not
`applyWithAutoFire`** — easy to miss, and it is a genuine `current`-writer.

---

## 2. The reckoning, and Invariant (P) as a single chokepoint

### 2.1 The chunk-1 reckoning shape

The parent §5.1b shape, with two honest **init-state refinements** (chunk 1 is the first code
to *hold* this state, so it must model "before anything was placed"):

```ts
// lib/conductor-clock.ts — MD-LOCAL, never broadcast (parent §5.1b, §9 "not a new wire type").
export type ClockProvenance = 'manual' | 'autofire' | 'clock'; // 'clock' reserved for chunk 2

export interface ClockReckoning {
  // The last TRUST (human) anchor — the step a MANUAL re-anchor last re-zeroed onto
  // (parent §5.1:341). It moves ONLY on a manual re-anchor (advance / align / Go-now /
  // future seek); a MACHINE placement (autofire / clock) NEVER writes it — `current`
  // (in ConductorState) already carries the machine-placed position, so anchor stays
  // unambiguously "last human anchor", in lockstep with alignedAtMs + barsSinceAnchor.
  // null ⇔ "no human/trust anchor ever asserted" — the §5.2 unconfirmed-start state, in
  // lockstep with alignedAtMs === null. (A machine placement can move `current` while anchor
  // stays null; it is `current`, not anchor, that tracks position.) Parent §5.1 shows the
  // STEADY-STATE (non-null) shape; chunk 1
  // adds the pre-first-anchor init form (refinement noted to Codex — §7-Q1).
  anchor: { barId: string; pass: number } | null;
  // ── trust axis (resets ONLY on a real MD position gesture) ──
  barsSinceAnchor: number;          // +1 per CLOCK-driven advance (chunk 2); 0 at re-anchor
  alignedAtMs: number | null;       // MD-clock instant of the last MD gesture; null ⇒ never trued
  // ── motion axis (re-baselines on tempo change too — chunk 2 reads/re-baselines) ──
  motionBaselineAtMs: number;       // re-zeroed by a position re-anchor; inert until chunk 2
  baselineTempoBpm: number | null;  // null in chunk 1 (no tempo plumbed yet — §6); chunk 2 fills
  barsAtMotionBaseline: number;
  // ── arrival provenance ──
  positionTrusted: boolean;         // true ⇒ current was MANUAL-placed; false ⇒ MACHINE-placed
}

export function initReckoning(now: number): ClockReckoning {
  return {
    anchor: null,
    barsSinceAnchor: 0,
    alignedAtMs: null,            // never trued
    motionBaselineAtMs: now,
    baselineTempoBpm: null,       // no tempo source in chunk 1
    barsAtMotionBaseline: 0,
    positionTrusted: false,       // nothing placed yet
  };
}
```

**Why the full shape now (not a half-shape that chunk 2 mutates).** The motion-axis fields are
*written* by an align re-anchor (parent §8 item 1 says align resets both axes) even though
*no reader exists until chunk 2*. Introducing the complete shape — and the write discipline —
**once** is the systemic-cheap path: Invariant (P) is defined and tested in one place, and
chunk 2 only adds a *consumer* (the driver) plus the `'clock'` provenance row, never a reshape.
This is the same "close the class once" reasoning the parent fought R6→R8 to reach.

**Why `baselineTempoBpm` is `null` in chunk 1.** The reckoning lives in the hook, which today
takes `{ enabled, sessionId, songRef, cal }` — **no `song.bpm`**. Plumbing bpm is a chunk-2
need (the driver reckons `barMs` from it). Chunk 1 inits it `null`, never sets it non-null, and
no code reads it. Deferring the plumbing keeps chunk 1 on *position*, not *tempo*.

### 2.2 The chokepoint: `reckonAfter` (this is the centerpiece)

The parent spent R6/R7/R8 learning **not to enumerate callers**. So chunk 1 implements
Invariant (P) as a *single pure function* every dispatch result flows through:

```ts
// lib/conductor-clock.ts — pure, now injected (mirrors dispatch's now-injection; testable
// in the lib gate, no jsdom).
function sameStep(a: TraversalStep | null, b: TraversalStep | null): boolean {
  if (a === null || b === null) return a === b;
  return a.barId === b.barId && a.pass === b.pass;   // {barId,pass} identity — NOT barId alone
}

export function reckonAfter(
  r: ClockReckoning,
  beforeCurrent: TraversalStep | null,
  afterCurrent: TraversalStep | null,
  provenance: ClockProvenance,
  now: number,
): ClockReckoning {
  // Invariant (P): mutate IFF the reduce produced a NEW current. Otherwise untouched —
  // this single guard is what makes "a redirect doesn't re-anchor", "a no-armed/stale
  // commit doesn't re-anchor", and "a dead advance at song end doesn't re-anchor" all
  // fall out for free (the R6/R7/R8 class, closed structurally).
  if (sameStep(beforeCurrent, afterCurrent)) return r;
  // current changed — afterCurrent is non-null here (a write only ever sets a real step).
  const cur = afterCurrent!;
  switch (provenance) {
    case 'manual':   // manual advance / Go-now commit / (future) seek: full re-anchor, both axes
      return {
        anchor: { barId: cur.barId, pass: cur.pass },
        barsSinceAnchor: 0,
        alignedAtMs: now,
        motionBaselineAtMs: now,
        baselineTempoBpm: r.baselineTempoBpm,   // a POSITION re-anchor carries tempo (only a
        barsAtMotionBaseline: 0,                //   TEMPO change re-baselines it — chunk 2/§5.6-ii)
        positionTrusted: true,
      };
    case 'autofire': // chained auto-fire commit: MACHINE-placed. Flips provenance ONLY —
      return {       //   anchor / barsSinceAnchor / alignedAtMs (the whole TRUST axis) and the
        ...r,        //   motion axis are ALL left at the arrival's values (no double-count
        positionTrusted: false,  //  stall, parent §5.2). anchor stays the last HUMAN anchor (§2.1).
      };
    case 'clock':    // reserved for chunk 2's driver — not emitted in chunk 1. Counts ONE
      return {       //   clock-driven bar SINCE the human anchor; anchor + alignedAtMs untouched.
        ...r,
        barsSinceAnchor: r.barsSinceAnchor + 1,
        positionTrusted: false,
      };
  }
}
```

**Why `{barId, pass}` and not `barId`.** `cursor` is revisited (repeats/voltas/D.S.); the same
`barId` re-emits with an incremented `pass` (`roadmap-vm.ts` `passCount`, `:462`). So a genuine
re-emit of the same bar *does* change `current` by `{barId, pass}` and *should* re-anchor; only
the `?? state.current` null-transition rows leave `{barId, pass}` identical and correctly
no-op. This is the parent's R2/R8 reasoning, made operational.

**Why this closes the class.** Rather than "advance re-anchors, redirect doesn't, no-armed
commit doesn't, …" (the enumeration that leaked across three rounds), every seam calls
`reckonAfter(before, after, provenance)` and the `sameStep` guard decides. A `redirect`
(`:223`, `current` unchanged) → `sameStep` true → untouched. A no-armed `commit` (`:234`) →
untouched. A dead advance at song end (`:218` null transition) → untouched. The **only**
per-caller input is `provenance`, and it is *consulted only when `current` actually moved*.

### 2.3 Wiring the chokepoint into the two hook seams

`reckonAfter` is applied at **every** dispatch, threading a single `nextReckoning` so the
chained auto-fire commit composes (one `setReckoning`, no read-after-set hazard — the same
discipline `applyWithAutoFire`'s single `setSession` already uses):

- **`advance()`** → `applyWithAutoFire`. Apply `reckonAfter(before.current, res.current,
  'manual')`. If the gate opened and a `commit` chains, apply `reckonAfter(res.current,
  afterFire.current, 'autofire')` on top. Single `setReckoning(nextReckoning)`.
- **`redirect()`** → `applyWithAutoFire`. The redirect leg is `'manual'` provenance but
  `current` never moves (`:223`) → `reckonAfter` no-ops it (**this is the "a redirect does NOT
  re-anchor" guarantee, for free**). A chained `release`-opened auto-fire `commit` *does* move
  `current` → `'autofire'` stamp applies.
- **`commit()`** (Go-now) → `run`. Apply `reckonAfter(before.current, after.current,
  'manual')`. A no-armed/stale commit (`:234`/`:238`) or null-transition (`:244`) leaves
  `current` put → no re-anchor (**the R8 guarantee, for free**).
- **`arm()` / `disarm()`** → `run`. `current` never moves → `reckonAfter` no-ops. (They still
  set `armedFireAtEligible`, which is orthogonal.)

> **Provenance assignment is the whole per-caller surface, and it is tiny:** `manual` for
> `advance`/`commit`/`redirect`-leg, `autofire` for the chained commit. `clock` is unused in
> chunk 1. Because the `sameStep` guard gates everything, mis-tagging a *non-moving* seam is
> harmless — only a moving write reads the tag.

---

## 3. The align / true-up tap (the new gesture)

A single MD gesture meaning **"we are on the current bar's downbeat, now."** Two mechanics by
state, both ending in a full manual re-anchor (`positionTrusted = true`, both axes zeroed):

- **Seed the start (`current === null`).** Top of the song, no count-in: the gesture **emits
  bar 1** by dispatching the first `advance` (the *only* way to place `current` on the shipped
  wire — `stepVM` from `initVM`). That advance is a `'manual'` write → `reckonAfter`
  re-anchors onto bar 1. So *align-at-start is mechanically identical to a manual advance*
  (parent §1: "no count-in at start is precisely the MD's align tap").
- **Correct drift mid-song (`current !== null`).** The playhead is already on the right bar;
  only the *timing baseline* is stale. The gesture **re-zeros the reckoning onto the existing
  `current`** with **no VM change, no dispatch, no seq, no broadcast** — it touches *only* the
  MD-local `ClockReckoning`. This is the purest expression of "MD owns place, off the wire"
  (parent §5.1b / §9):

```ts
export function alignReckoning(r: ClockReckoning, current: TraversalStep, now: number): ClockReckoning {
  return {                                   // re-zero ONTO current — never moves it (β: forward-only,
    anchor: { barId: current.barId, pass: current.pass },  //  and a non-moving re-zero is trivially
    barsSinceAnchor: 0,                                     //  neither forward NOR backward)
    alignedAtMs: now,
    motionBaselineAtMs: now,
    baselineTempoBpm: r.baselineTempoBpm,
    barsAtMotionBaseline: 0,
    positionTrusted: true,
  };
}
```

Hook action:
```ts
align: () => {
  if (!session) return;
  if (session.state.current === null) { advance(); return; }   // seed = the first manual advance
  setReckoning((r) => alignReckoning(r, session.state.current!, Date.now()));  // mid-song re-zero
},
```

**Forward-only under β, by construction.** Mid-song align never moves `current` (neither
forward nor backward); seed-align moves `null → bar 1` (forward). There is no path in chunk 1
that moves `current` backward — backward re-seat is the deferred `seek` directive (parent
§5.4). So β holds trivially here; the β *over-run-degrade* behaviour belongs to chunk 2 (§6).

**Degenerate guards.** Empty chart (`vm.done` at init) → seed-align dispatches an advance that
emits nothing → `current` stays null → `reckonAfter` no-ops → align is inert (honest).

---

## 4. Where it lives

- **`lib/conductor-clock.ts` (NEW, pure):** `ClockReckoning`, `ClockProvenance`,
  `initReckoning`, `reckonAfter`, `alignReckoning`, `sameStep`. Pure, `now`-injected, unit-
  tested in the lib gate (no jsdom). This is the clock layer's home; chunk 2 grows it with the
  `ConductorClock` wire shape, the §4.1 ladder, and the motion driver. **No change to
  `conductor-state.ts` or `conductor-session.ts`** (reckoning is MD-local, never wire — §9).
- **`lib/use-conductor-session.ts` (thin edit):** one `useState<ClockReckoning>` beside
  `armedFireAtEligible`; reset it in the **same two places** that reset `armedFireAtEligible`
  (the disabled/teardown branch `:96`–`:106` and the init resolve callback `:109`–`:113`),
  via `initReckoning(Date.now())` — same deferred/microtask discipline (lint
  `react-hooks/set-state-in-effect`). Thread `reckonAfter` through `run`/`applyWithAutoFire`
  (§2.3). Add the `align` action and surface `reckoning` (read-only) on `ConductorSurface`.
- **`components/ConductorCluster.tsx` (thin edit):** one **"On the 1"** (align) button beside
  Advance, wired to `onAlign`. Minimal — the reckoning is internal; the MD has no need to *see*
  `barsSinceAnchor`/`positionTrusted` until the chunk-3 gate refuses an auto-fire. (Open
  question §7-Q2: ship the button in chunk 1 for gesture-cohesion, or defer to chunk 2 when
  motion makes it observable. Recommend chunk 1 — the primitive and its trigger ship together.)

---

## 5. Worked traces (grounding the bookkeeping)

1. **Cold start, align on the 1.** `current=null`, reckoning=init (anchor null, untrusted).
   Align → advance emits `{b1,1}` → `reckonAfter('manual')`: anchor `{b1,1}`,
   `barsSinceAnchor=0`, `alignedAtMs=now`, motion zeroed, `positionTrusted=true`. ✓
2. **Mid-song drift true-up.** `current={b9,1}`, anchor `{b1,1}`. Align → `alignReckoning`
   onto `{b9,1}`, no dispatch, no seq. ✓ ("free-span tap stays forward.")
3. **A redirect does NOT re-anchor.** `current={b5,2}`, trusted. `redirect(anotherRound)` →
   `:223` moves `vm` seed only, `current` unchanged → `reckonAfter('manual')` sees `sameStep`
   → reckoning **untouched** (anchor, `alignedAtMs`, `positionTrusted` preserved). ✓
4. **Manual Go-now re-anchors; no-armed Go-now does not.** Armed + `current={b5,1}` ≠ fireAt.
   `commit()` jumps + steps → `current={b8,1}` (`:244`) → `reckonAfter('manual')` re-anchors
   onto `{b8,1}`. ✗-case: nothing armed → `commit()` returns `base` (`:234`), `current`
   unchanged → **no re-anchor** (R8). ✓
5. **Release-opened auto-fire (5a path) stamps autofire.** `current={b6,3}` placed by a prior
   *manual* advance, so `anchor={b6,3}`, trusted, `barsSinceAnchor=0`; `holding≠null`, armed at
   `b6`. `redirect(release)`: leg `'manual'` but `current` unchanged → reckoning untouched; gate
   opens → chained `commit` writes `current={b7,1}` → `reckonAfter('autofire')`: **only**
   `positionTrusted→false`. **`anchor` stays `{b6,3}`** (the last human anchor — NOT the
   machine-placed `b7`), `barsSinceAnchor` stays `0`, `alignedAtMs` unchanged, motion untouched.
   ✓ The machine-placed position lives in `current={b7,1}` (which travels in `ConductorState`);
   `anchor` never duplicates it. The chunk-3 gate later reads `positionTrusted` — here the stamp
   is honest; no gate consumer exists in chunk 1.

---

## 6. Scope fence — tests/behaviours that are deliberately NOT chunk 1

Each parent §8 item-1 phrase, placed honestly:

| Parent §8 item-1 phrase | Chunk | Why |
|---|---|---|
| forward true-up; free-span tap stays forward | **1** | align mechanics (§3) |
| manual advance/align re-anchors both axes AND sets `positionTrusted` | **1** | `reckonAfter('manual')` / `alignReckoning` |
| a redirect does NOT re-anchor | **1** | `sameStep` no-op chokepoint (§2.2) |
| **align cancels pending motion** | **2** | no motion loop exists in chunk 1 — nothing to cancel |
| **clock-overrun degrades to `manual` (β)** | **2** | over-run requires the driver; the β *policy* is stated (parent §5.4), its *exercise* needs motion |

Also explicitly out: the wire `ConductorClock`/rung (chunk 2), `clockConfidenceOk` consumption
of `positionTrusted` (chunk 3), `song.bpm` plumbing into the hook (chunk 2), backward `seek`
(deferred α). Chunk 1 *writes* `positionTrusted`; it has no *reader* — that is correct and
intentional, and the trace in §5.5 shows the write is right ahead of the chunk-3 reader.

---

## 7. Build outline + tests (chunk 1 only)

**Files:** `lib/conductor-clock.ts` (new, pure) · `lib/use-conductor-session.ts` (thin) ·
`components/ConductorCluster.tsx` (one button) · `tests/conductor-clock.test.ts` (new, pure) ·
`tests/use-conductor-session.test.tsx` (+align-binding cases). No `conductor-state.ts` /
`conductor-session.ts` change. Branch off main `3eae7ae`; Codex at the stable ref before merge.

**Pure tests (`conductor-clock.test.ts`):**
- `initReckoning` = unconfirmed-start (anchor null, `alignedAtMs` null, `positionTrusted` false).
- `reckonAfter('manual')` on a real move → full re-anchor both axes + `positionTrusted=true`.
- `reckonAfter` with `sameStep(before, after)` (incl. both null) → **returns input untouched**
  (the redirect / no-armed-commit / dead-advance class).
- `reckonAfter` distinguishes a genuine repeat re-emit (`{b,1}`→`{b,2}`) as a *move* (re-anchors)
  vs a null-transition (`{b,2}`→`{b,2}`) as a no-op.
- `reckonAfter('autofire')` → **only** `positionTrusted=false`; the whole trust axis (`anchor`,
  `barsSinceAnchor`, `alignedAtMs`) AND the motion axis are **unchanged** (anchor stays the
  last human anchor; no double-count — parent §5.2 / §2.1).
- `reckonAfter('clock')` → `barsSinceAnchor+1`, `positionTrusted=false`, `anchor`/`alignedAtMs`
  unchanged (the chunk-2 row, asserted here so chunk 2 adds a consumer, not a reshape).
- `alignReckoning` re-zeros onto the passed step, `positionTrusted=true`, never moves `current`.

**Hook-binding tests (`use-conductor-session.test.tsx`):**
- align at start (`current=null`) seeds bar 1 + reckoning trusted (anchor `{b1,1}`).
- align mid-song re-zeros onto `current` with **no `outcome`/seq change** (no dispatch).
- a manual `advance` mid-session sets `positionTrusted=true`, `barsSinceAnchor=0`.
- a `redirect` (anotherRound/hold/release/resetJump) leaves reckoning **untouched** (anchor +
  `alignedAtMs` + `positionTrusted` preserved).
- a no-armed `commit()` does **not** re-anchor (Invariant (P) / R8).
- **a chained auto-fire through `applyWithAutoFire` (the riskiest wiring path):** arm at the
  next bar with `autoFire` on, `advance()` onto `fireAt` → assert the **first** dispatch
  (manual advance) re-anchored AND the chained `commit` then applied the **autofire** stamp
  (`positionTrusted=false`, trust axis left at the manual arrival's `barsSinceAnchor`/`anchor`),
  with a **single** final reckoning value (no double-count, no intermediate-state leak). Mirror
  with a **release-opened** auto-fire (vamp hold → `redirect(release)`) for the §5.5 #5 path.
- reckoning resets to `initReckoning` on identity change (new `sessionId`/`cal`) and on disable.

**Report the test-count delta** on the build PR (per the standing rule).

---

## 8. Open questions for Graham (small)

1. **`anchor` nullable at init.** Parent §5.1 types `anchor` non-null; chunk 1 needs a
   pre-first-anchor form, so I model `anchor: {barId,pass} | null` (null ⇔ `alignedAtMs===null`
   ⇔ the §5.2 unconfirmed-start the parent itself added). Confirm this refinement (vs a
   sentinel) — I believe nullable is the honest model and consistent with the existing
   `alignedAtMs: number | null`.
2. **Align button now or in chunk 2.** Recommend **now** (primitive + trigger ship together);
   the alternative is to land the lib/hook in chunk 1 and the button in chunk 2 when the driver
   makes it visibly do something. Either is fine — flagging because chunk 1's button has no
   *visible* effect until chunk 2.
3. **`baselineTempoBpm: null` in chunk 1** (no bpm plumbed to the hook yet; chunk 2 adds it
   with the driver). Confirm deferring the bpm-plumbing to chunk 2 rather than threading it now.
