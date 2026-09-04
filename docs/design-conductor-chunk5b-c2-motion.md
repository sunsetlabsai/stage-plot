# Conductor 5b · chunk 2 — the static-BPM motion driver (the ladder + the loop)

**Status:** DESIGN — **Codex R4 GO** (R1 2 HIGH + 1 MEDIUM, R2 1 HIGH, R3 1 HIGH, R4 1 LOW — all
folded). Build state tracked in `docs/INDEX.md`, not here. **R4:** GO; one LOW — the §3.1 tick pseudocode used `session.vm.done`/
`session.current`; corrected to the shipped `session.state.vm.done`/`session.state.current` so the
build implements the real shape. **R3 fold:** the loop would dispatch *no-op* advances after song end — a done-`advance`
is `applied` (not `ignored`: `current: r.transition ?? state.current`, `conductor-state.ts:218`),
leaving `current`/`barsSinceAnchor` unchanged while bumping `seq`/`updatedAt`, so `owed` grows and
the loop churns every tick until an artificial stall. Fixed: `computeStaticRung` now takes
`done` (`vm.done`) and returns `manual` at song end (honest readout, idle loop), plus a
belt-and-suspenders `vm.done` guard in the tick before dispatch; added a song-end fake-timer
regression (no advance, no `seq` churn, no artificial stall). Corrected the §3.1 prose that wrongly
called a done-advance `ignored`. **R2 fold:** the §4 `prevBpm` tempo-rebaseline detector bypassed the R1 `driverRef`
invariant — it did a bare `setReckoning` while the authoritative driver kept the stale motion
baseline, so the next tick would compute `owed` off the old baseline with the new bpm (re-opening
the jump/stall bug). Fixed: the rebaseline is now itself a `driverRef` transaction (read
`driverRef.current.reckoning` → write `driverRef` synchronously → mirror `setReckoning`), making
the invariant uniform across **every** seam (manual / tick / reset / tempo detector). Added a
mid-clock `song.bpm`-change fake-timer regression (§10). **R1 folds:** HIGH-1 — the multi-tick batching race (a render-only `liveRef` doesn't gate
re-entrancy; two ticks before a commit double-bump `barsSinceAnchor`) → an authoritative
synchronously-written `driverRef` owning `{session,reckoning,stalled}` as the loop's source of
truth + re-entrancy gate (§3.2), with the two-due-ticks-in-one-`act` regression. HIGH-2 — the
`song.bpm` data path doesn't exist in Perform (route never selects `bpm`, `SetlistSong` lacks it)
→ chunk 2 widens the read path (route+type+map+page), and `barBeats` defaults 4 because `timeSig`
is stripped from Perform (non-4/4 = a noted follow-on) (§0/§1/§7/§10). MEDIUM — stall-clearing is
gated on an *actual* `current` re-anchor (`nextReckoning !== prev`), not the action name, so a
no-armed `commit` doesn't clear it (§6). Builds on chunk 1 (the
`ClockReckoning` + Invariant (P) chokepoint + the align/true-up tap, SHIPPED to main
`57b8890`) and chunk 0 (`song.bpm` + click + `lib/tempo.ts`, SHIPPED `3eae7ae`). Parent
authority: `docs/design-conductor-chunk5b-clock.md` v0.6.6 (Codex R9 GO). This is the build
spec for **§8 item 2** of that parent (the `ConductorClock` ladder + the motion shell),
**scoped to the static-BPM rung** — the only rung reachable before audio telemetry (item 4).
It does not reopen the parent (GO'd).

**One-line frame.** Chunk 2 makes the redline **move on its own** at the song's stated tempo:
a hook-owned loop that dead-reckons forward off `song.bpm`, seeded by the MD's chunk-1
"On the 1" tap and re-trued by align. This is the **visible payoff** chunk 1's substrate was
built for — "clock owns speed" lands here, atop "MD owns place." Audio-tracked tempo, the
`live`/`coasting` rungs, and clock-driven auto-*fire* are all **later chunks** (§9).

---

## 0. What chunk 2 is, and (sharply) what it is NOT

The parent §8 item-2 test list names behaviours that need machinery later chunks build
(audio telemetry → `live`/`coasting`; the confidence gate → clock auto-fire). Drawing the
fence honestly is, again, most of the review surface.

**Chunk 2 IS:**
- the **`ClockRung`** type (all four parent §4.1 values defined — the stable contract) + a
  pure **`computeRung`** that, in chunk 2, only ever returns **`static-bpm`** or **`manual`**
  (no telemetry input exists to reach `live`/`coasting`);
- the **motion shell** (parent §5.3): one hook-owned `setInterval` driver, **≤ 1 clock-driven
  `advance` per tick**, whole-bar quantised off `barMs = 60000·barBeats/bpm` (`lib/tempo.ts`),
  **≥ 2 bars owed in a tick ⇒ stall → `manual` (never fast-forward)**;
- the **two-axis motion math** (parent §5.1/§5.6-ii): `expected = barsAtMotionBaseline +
  floor((now − motionBaselineAtMs)/barMs)` vs `barsSinceAnchor`, with a **tempo re-baseline**
  primitive (`rebaselineMotion`) so a `song.bpm` change re-paces without a jump or a stall;
- **the real `song.bpm` data path into Perform** (Codex R1 HIGH-2): chunk 0 added `bpm` to the
  `songs` *table*, but the show GET route never selects it and `SetlistSong` never carries it, so
  the page cannot supply it today. Chunk 2 **widens the read path** — `songs` select + `SetlistSong`
  type + `hydrateFromEntries` map + the page→hook `bpm` arg — so the conducted song's stated tempo
  actually reaches the driver (chunk 1 left `baselineTempoBpm` null);
- **`barBeats` plumbed into the hook, defaulting to 4 in chunk 2.** `timeSig` is NOT currently
  exposed to Perform (a builder chart's `source_spec` is stripped to `is_builder`/`authored_key`
  at the route, and calibration charts carry no meter — §1), so chunk 2 dead-reckons at 4/4 (the
  common case) and **non-4/4 meter is a small noted follow-on** (pass the conducted chart's
  `source_spec.timeSig` through the route). The hook takes `barBeats` so that follow-on is a
  one-line wire, not a reshape;
- a **clock on/off** affordance (default OFF = the shipped 5a manual floor) + a **rung readout**
  in the cluster.

**Chunk 2 is NOT (later chunks — fenced in §9 with reasons):**
- **audio telemetry / tempo detection / the `live` & `coasting` rungs** — item 4. With no
  telemetry source, `computeRung` cannot reach them; chunk 2's only *driving* rung is
  `static-bpm` (off the stated tempo) and its floor is `manual`.
- **clock-driven auto-*fire*** — item 3 (`clockConfidenceOk`). **In chunk 2 a clock-driven
  arrival onto `fireAt` NEVER auto-commits — it always defers to the MD's manual "Go"** (§5).
  This is conservative-correct: the confidence machinery that would justify an auto-commit
  does not exist yet, and §6 of the parent keeps even audio shadow-only at v1. The 5a *manual*
  auto-fire path (chunk 1's `applyWithAutoFire`) is **untouched**.
- **the wire `ConductorClock` broadcast** (adding `rung` to `ConductorState.clock`) — deferred
  to item 4. There is no transport (epic chunk 3b) and no followers yet, so a broadcast field
  would be dead wire. Chunk 2 keeps the rung **MD-local** (hook state), exactly as chunk 1
  kept the reckoning local. **No change to `conductor-state.ts` / `conductor-session.ts`** —
  same clean fence as chunk 1.
- **backward re-seat** (`seek`) — deferred α chunk (parent §5.4). Chunk 2 is forward-only β:
  clock-overrun (which can't even happen without audio) is moot here; the static click can't
  run ahead of itself, and a `song.bpm` faster than the band is corrected by the MD's align.
- **smooth sub-bar redline glide** — post-v1 (parent §5.6-iii). Chunk 2 steps the redline
  **bar-to-bar** (ShowRunr redlines bars); the loop is a coarse interval, not an animation rAF.

---

## 1. Grounding (verified at `57b8890`)

| fact | where | use in chunk 2 |
|---|---|---|
| `current`-writers = manual `advance` / Go-now `commit` / chained auto-fire `commit`; `redirect` never moves `current` (`:223`) | `conductor-state.ts` | the clock adds a **fourth** writer: a *clock-driven* `advance` |
| `ClockReckoning` + `reckonAfter` (the `'clock'` provenance row is **already written + tested**, awaiting a caller) | `lib/conductor-clock.ts` | the loop is that caller: `reckonAfter(…, 'clock')` ⇒ `barsSinceAnchor+1`, `positionTrusted=false` |
| `alignReckoning` re-zeros both axes (`motionBaselineAtMs=now`, `barsAtMotionBaseline=0`) | `lib/conductor-clock.ts` | "align cancels pending motion" falls out for free (§6) |
| `barMs(bpm, barBeats)=60000·barBeats/bpm`, `DEFAULT_BAR_BEATS=4` | `lib/tempo.ts` | the loop's whole-bar quantiser (reuse, do not re-derive) |
| `song.bpm` lives on the `songs` *table* (chunk-0 migration 012) | `lib/types.ts:177` (`Song.bpm`) | the static-BPM tempo source; `null ⇒ manual` rung |
| **the show GET route never reads it:** `songs` select = `id,title,key,lead,notes` (no `bpm`); `SetlistSong` has no `bpm`; inline-config path has none either | `app/api/shows/[owner]/[show]/route.ts:25,32`; `lib/types.ts:156` | **chunk 2 widens the read path** (HIGH-2): add `bpm` to the select + `SetlistSong` + the `hydrateFromEntries` map; legacy inline songs ⇒ `bpm` undefined ⇒ `manual` (honest floor) |
| `timeSig.beats` (1..32) lives in a builder chart's `source_spec`, which the route **strips** to `is_builder`/`authored_key` (`:114`); calibration charts carry no meter | `lib/roadmap-spec.ts:21`; `route.ts:114` | so **`barBeats` is NOT exposed to Perform today** ⇒ chunk 2 defaults to **4**; honoring non-4/4 = a noted follow-on (pass `source_spec.timeSig` through the route) |
| hook args today: `{ enabled, sessionId, songRef, cal }` — **no bpm/meter** | `use-conductor-session.ts:64` | add `bpm` + `barBeats` (chunk 1 §2.1 flagged this as the chunk-2 plumbing) |
| `applyWithAutoFire` reckons `'manual'`, chains an `'autofire'` commit on the rising edge | `use-conductor-session.ts` | **left untouched**; the clock path is a *separate* thin driver (§5) |
| a `clock` payload exists (`:247`, writes `state.clock`, never `current`) | `conductor-state.ts` | **NOT used in chunk 2** (no broadcast); noted so the deferral is explicit |

**The chunk-1→chunk-2 seam: `baselineTempoBpm`.** Chunk 1 inits `baselineTempoBpm = null` and
never sets it (no bpm was plumbed). Chunk 2 is the first code with a tempo, so it is
responsible for establishing and maintaining it (§4). This is the *one* field chunk 1
deliberately left for here — not a reshape, a fill-in.

---

## 2. The rung ladder in chunk 2

The parent §4.1 ladder is **live → coasting → static-bpm → manual**. Chunk 2 defines the full
`ClockRung` value set (the stable contract item 4 extends) but, with **no telemetry input**,
can only *reach* the bottom two:

```ts
// lib/conductor-clock.ts (grows; still MD-LOCAL, never broadcast in chunk 2)
export type ClockRung = 'live' | 'coasting' | 'static-bpm' | 'manual';

// Chunk-2 rung resolution — pure. live/coasting are unreachable here (no telemetry arg),
// and are added by item 4 when a TempoTelemetry input exists. This is the WHOLE ladder
// chunk 2 can produce; it is not a stub of computeRung, it is computeRung's chunk-2 domain.
export function computeStaticRung(args: {
  clockOn: boolean;
  bpm: number | null;
  stalled: boolean;
  done: boolean;        // vm.done — song ended; nothing left to advance onto (Codex R3 HIGH)
}): ClockRung {
  if (!args.clockOn || args.bpm == null || args.stalled || args.done) return 'manual';
  return 'static-bpm';
}
```

- **`manual`** (clock off, or no stated bpm, or stalled, **or `vm.done`**): the loop emits nothing
  — the floor is shipped 5a, the MD's tap is the only motion. **Default.**
- **`static-bpm`** (clock on + a stated bpm + not stalled + not done): the loop dead-reckons
  forward off the stated tempo. This *is* the click made visible on the redline (parent §4.1/§3).

**Why `done` falls to `manual` (Codex R3 HIGH).** At song end `vm.done` is true and `current`
holds the last emitted bar. A clock-driven `advance` then is **not** `ignored` — the reducer
returns `applied` with `current: r.transition ?? state.current` (`conductor-state.ts:218`) and
`stepVM` yields no transition (`roadmap-vm.ts:412`), so `current` is unchanged BUT `seq`/`updatedAt`
are bumped. Worse, `reckonAfter('clock')`'s `sameStep` guard leaves `barsSinceAnchor` frozen, so
`owed` only *grows* with elapsed time → the loop would dispatch a no-op `advance` **every tick**
(seq churn now; broadcast churn once item 4 lands) until `owed ≥ 2` fires an *artificial* stall.
Gating the rung on `done` idles the loop cleanly and reads honestly ("manual" at song end, not a
phantom stall). A belt-and-suspenders `vm.done` guard also sits in the tick before dispatch (§3.1).

**Why a `clockOn` toggle, default OFF.** The feature must be opt-in so the shipped 5a manual
floor is the default and nothing auto-moves until the MD asks. It is **orthogonal to
`autoFireOn`**: clock motion (auto-*advance*) and auto-*fire* (auto-*commit* of an armed
change) are independent — the MD may want the redline to flow while still tapping "Go" for
every structural change (indeed, in chunk 2 that is the *only* option, §5).

**Falling to `manual` is never silent to the MD** (parent §4.1): the cluster shows the rung
("fixed tempo" / "manual") and a stall notice, so the MD always knows whether the playhead is
self-driving or waiting on a tap. *Degrade precision, never honesty.*

---

## 3. The motion shell — the driver loop (parent §5.3)

One hook-owned `setInterval`, MD device only, set up in an effect keyed on `[enabled, clockOn]`
(torn down on disable / clock-off). Period = a named constant **`CLOCK_TICK_MS`** small
relative to the shortest bar (at 400 bpm 4/4, `barMs = 600`; a ~80 ms tick resolves every bar
with margin). The redline is bar-granular (§0), so a coarse interval — not an animation rAF —
is the correct v1 mechanism; rAF smooth-glide is post-v1 (parent §5.6-iii).

### 3.1 The tick (the load-bearing logic)

```
on each tick (reads FRESH state from driverRef.current — §3.2; writes it back synchronously):
  if rung !== 'static-bpm'         → return          // clock off / no bpm / stalled / DONE / manual
  if session.state.current === null → return          // NOT YET SEEDED — wait for the MD's "On the 1"
  if session.state.vm.done         → return          // belt-and-suspenders: never dispatch a no-op advance at song end
  barMs    = barMs(bpm, barBeats)                     // lib/tempo.ts (60000·barBeats/bpm)
  expected = barsAtMotionBaseline + floor((now − motionBaselineAtMs) / barMs)
  owed     = expected − barsSinceAnchor
  if owed <= 0                     → return           // not time for the next bar yet
  if owed >= 2                     → STALL: set stalled=true; return  // loop was suspended — DO NOT fast-forward
  // owed === 1 : emit EXACTLY ONE clock-driven advance
  drive one advance (provenance 'clock')              // §5 — never chains an auto-commit in chunk 2
```

**Seed-gating (`current === null` ⇒ inert).** At the song head nothing has been emitted and
there is no count-in (parent §1). The clock must **not** auto-start; the MD's chunk-1 "On the
1" tap seeds bar 1 (a manual re-anchor that sets `motionBaselineAtMs = now`,
`barsSinceAnchor = 0`). *Only then* does dead-reckoning begin — the next bar fires one `barMs`
after the downbeat tap. This is "MD owns place" at the start: the human plants bar 1, the clock
carries it forward.

**≤ 1 advance per tick, always (parent §5.3 / Codex R2 HIGH).** The loop emits at most one
`advance` per turn and re-reads state next tick — it NEVER loops N advances. Looping is exactly
what could skip a `fireAt`, fire after passing it, or step past a fresh commit target. One
transition, always re-evaluated.

**≥ 2 owed ⇒ stall, not catch-up (parent §5.3).** In the foreground a bar is hundreds of ms
and a tick is ~80 ms, so seeing ≥ 2 bars owed means the loop was suspended (tab sleep, screen
lock, device throttle). Fast-forwarding the missed bars off a possibly-stale tempo is the
"confidently wrong" failure. Instead the clock **stalls → `manual`** and freezes the playhead
where it last legitimately was; the MD's next align tap re-seeds and clears the stall (§6).
`setInterval` keeps firing (throttled) in the background, so the *single* post-resume tick sees
the large `owed` and stalls — no replay. (`computeStaticRung` returns `manual` while
`stalled`, so the readout flips honestly and the loop idles until re-seeded.)

**The clock-driven advance is the reckoning's 4th `current`-writer.** It dispatches a normal
`{ kind: 'advance' }` (the *only* `stepVM` caller stays `advance`, parent §1), and on
`applied` stamps `reckonAfter(…, 'clock')`: `barsSinceAnchor + 1`, `positionTrusted = false`
(the *clock* placed this bar, not a human). The Invariant (P) `sameStep` guard keeps the
*reckoning* correct on a no-move (returns it untouched) — but a done-`advance` is still `applied`
and **churns `seq`/`updatedAt`** (`conductor-state.ts:218`), which is why song-end is gated at the
rung (`done ⇒ manual`, §2) *and* re-checked in the tick (above): **the loop never dispatches at
all once `vm.done`.** A genuinely `ignored` dispatch (e.g. a poison-pill `arm`, `:227`) likewise
just halts the tick to re-evaluate next turn — but the clock only ever dispatches `advance`.

### 3.2 The stale-closure AND the multi-tick batching race — one authoritative driver ref

A long-lived `setInterval` callback closes over the render in which the effect ran. If it read
`session`/`reckoning`/`bpm` from that closure it would act on **stale** state every tick after
the first. Re-creating the interval each render (deps = all of them) is wrong too — it resets
the timing baseline constantly.

**A render-updated `liveRef.current = live` alone is NOT sufficient** (Codex R1 HIGH-1). It is
only refreshed when React *commits a render*. If two interval callbacks fire before that commit
(two due ticks in one batch, a throttled-then-resumed timer, StrictMode), **both read the same
pre-tick `session`/`reckoning`** → both dispatch the *same* `advance` and both schedule a
functional `setReckoning(r => reckonAfter(r, barX, barX+1, 'clock'))`. The two functional
updaters compose on the *committed* reckoning, so `barsSinceAnchor` is incremented **twice** for
**one** bar — breaking the counter/`current` invariant. The render-mirror is too late to gate
re-entrancy.

**Resolution — an authoritative, synchronously-written driver ref that owns the atomic
transaction state** `{ session, reckoning, stalled }`. Refs are not subject to React batching, so
the ref — not committed React state — is the loop's source of truth and its re-entrancy gate:

```ts
// The transaction the loop reads AND writes synchronously. NOT blanket-overwritten by render.
const driverRef = useRef({ session, reckoning, stalled });
// A SEPARATE render-mirrored ref for non-transaction config (stale-by-a-tick is harmless;
// bpm/barBeats only affect barMs, which self-corrects, and clockOn/enabled also key the effect):
const cfgRef = useRef({ clockOn, bpm, barBeats });
cfgRef.current = { clockOn, bpm, barBeats };   // refs aren't reactive — safe during render
```

The driver ref is written **synchronously at the head of the same code path that schedules the
React setState — at every mutation site** (the chunk-1 manual seams `run` / `applyWithAutoFire` /
`align`, the resets, **and** the clock tick itself). So each writer does, in order: compute
`next{session,reckoning,stalled}` → **`driverRef.current = next` (synchronous)** → `setSession`/
`setReckoning`/`setStalled` (the render mirror). The clock tick becomes atomic:

```
tick (reads driverRef.current — fresh, post-any-prior-tick):
  { session, reckoning, stalled } = driverRef.current
  rung/seed/owed checks off reckoning + cfgRef bpm/barBeats
  if owed === 1:
    next = dispatch advance on session → reckonAfter('clock')
    driverRef.current = { session: next.session, reckoning: next.reckoning, stalled }  // SYNC, before any setState
    setSession(next.session); setReckoning(next.reckoning)
```

Now a **second tick firing before the React commit reads the already-advanced `driverRef`**,
computes `owed = 0`, and no-ops. One bar, one increment — race closed by construction. The
manual seams keep `driverRef` in lockstep so a human move and a clock tick can never disagree
about "where we are." The interval is still set up **once per `[enabled, clockOn]`** (no
per-render churn). **Required regression (vitest fake timers): two due ticks advanced inside one
`act()` ⇒ exactly ONE advance and `barsSinceAnchor` +1 exactly** (§10, 2b).

(Why a *separate* `cfgRef` rather than one `liveRef`: the transaction part must NOT be clobbered
by a blanket render assignment — an unrelated re-render between a tick's ref-write and its
setState commit would overwrite the advanced value with the stale render snapshot and re-open
the race. The driver ref is written *only* by mutation sites; render touches only `cfgRef`. If
lint disallows writing `cfgRef.current` during render, the fallback is a deps-free
`useEffect(() => { cfgRef.current = … })` — flagged §12-Q3.)

**Why the clock path does NOT route through `applyWithAutoFire` in chunk 2.** Because clock
arrivals deterministically *defer* here (§5), the clock tick needs none of the auto-fire inputs
(`autoFireOn`/`armedFireAtEligible`) — it is just *dispatch advance → `setSession` →
`setReckoning('clock')`*. Keeping it a separate thin `driveClockTick` (a) avoids reading the
auto-fire toggles from a long-lived closure entirely (sidesteps the worst of the stale-closure
trap), and (b) leaves chunk 1's GO'd `applyWithAutoFire` byte-for-byte untouched. **The chunk-3
seam:** when `clockConfidenceOk` exists, chunk 3 unifies the auto-fire decision across manual
*and* clock arrivals through the parameterised apply (reading the toggles via `cfgRef`/state),
gated by `positionTrusted || clockConfidenceOk(reckoning, rung)`. Chunk 2's deferral
is the `clockConfidenceOk ≡ false` special case of that gate — not a per-caller hack.

---

## 4. The two axes under a static tempo + the re-baseline (parent §5.1/§5.6-ii)

The **trust axis** (`barsSinceAnchor`, `alignedAtMs`) resets ONLY on a manual position gesture
(already true from chunk 1). The **motion axis** (`motionBaselineAtMs`, `barsAtMotionBaseline`,
`baselineTempoBpm`) re-baselines **also on a tempo change**, so the closed-form bar count stays
valid (parent §5.6-ii: `floor((now − baseline)/barMs)` assumes a *constant* tempo since that
baseline).

```ts
// lib/conductor-clock.ts — pure. Re-baseline the MOTION axis only; trust axis untouched
// (a band tempo change is a SPEED re-baseline, NOT the MD asserting position — parent §5.6-ii).
export function rebaselineMotion(r: ClockReckoning, newBpm: number, now: number): ClockReckoning {
  return {
    ...r,
    motionBaselineAtMs: now,
    baselineTempoBpm: newBpm,
    barsAtMotionBaseline: r.barsSinceAnchor,  // capture bars driven so far → past bars keep their true duration
  };
}
```

**Establishing `baselineTempoBpm` (the chunk-1 seam, §1) — and it MUST be a `driverRef`
transaction** (Codex R2 HIGH). A render-time prev-value detector (the chunk-0 `prevBpm` idiom,
*not* a setState-in-effect) re-baselines whenever the prop `bpm` changes — **including the first
transition from `null`/unset to a known bpm**. But a rebaseline is a *reckoning mutation*, so it
falls under the §3.2 invariant: **read from `driverRef.current.reckoning`, write `driverRef`
synchronously, then mirror with `setReckoning`** — exactly like the manual seams and the tick. A
bare `setReckoning((r) => rebaselineMotion(…))` would update React state while the *driver* kept
the stale `motionBaselineAtMs`/`baselineTempoBpm`, so the next tick (which reads
`driverRef.current.reckoning`, never React state) would compute `owed` off the old baseline with
the *new* `cfgRef.bpm` — re-opening the jump/stall bug R1 just closed:

```ts
const [prevBpm, setPrevBpm] = useState<number | null>(null);  // starts null so a known bpm fires once
if (bpm !== prevBpm) {
  setPrevBpm(bpm);
  if (bpm != null) {
    const next = rebaselineMotion(driverRef.current.reckoning, bpm, Date.now());
    driverRef.current = { ...driverRef.current, reckoning: next };   // SYNC — driver is authoritative
    setReckoning(next);                                              // render mirror
  }
}
```

This is a *targeted* driver write (conditional on a real tempo change, computed from the
authoritative reckoning), **not** the blanket `driverRef = live` overwrite §3.2 forbids — it
cannot clobber an in-flight tick (single-threaded; the tick already wrote its advance, and the
detector captures `barsAtMotionBaseline = barsSinceAnchor` *including* those clock bars).

**Why the driver uses the *prop* `bpm` for `barMs`, not `reckoning.baselineTempoBpm`.** Because
`motionBaselineAtMs` is reset on *every* tempo change (above) AND on every manual re-anchor
(chunk 1), the elapsed `now − motionBaselineAtMs` is **always** time accrued at the *current*
prop tempo — so `barMs(bpm, barBeats)` is exact. `baselineTempoBpm` is maintained as the
change-detector's record and the §10 assertion target (post-rebaseline it equals the prop bpm
by construction); the item-4 `live` rung, where tempo varies continuously, is its real
consumer. In chunk 2 a single stated tempo means the detector fires once (at first known bpm)
and again only if the MD edits `song.bpm` in the library — a real, testable path, not dead code.

**No jump, no stall on a tempo change.** `rebaselineMotion` sets `barsAtMotionBaseline =
barsSinceAnchor` and `motionBaselineAtMs = now`, so immediately after a change
`expected − barsSinceAnchor = floor(0/barMs) = 0` — the next advance lands one *new*-tempo bar
later, neither replaying nor idling ~N bars (the parent R4 HIGH-1 trap, closed by the two-axis
split chunk 1 already built).

---

## 5. The auto-fire fence — clock arrivals defer in chunk 2

`shouldAutoFire(session)` stays **verbatim 5a, frozen** (parent §5.2 / R3 HIGH-2): the exact
rising-edge arrival predicate, nothing more. What chunk 2 establishes is the *provenance* of a
clock-placed arrival and the rule that, **lacking the confidence machinery (item 3)**, such an
arrival never auto-commits:

- A **manual** advance / Go-now commit / release-over-a-manually-placed-`fireAt` keeps firing
  exactly as in 5a — `positionTrusted = true`, `applyWithAutoFire` untouched. **The shipped 5a
  floor is fully preserved.**
- A **clock-driven** advance sets `positionTrusted = false` and **does not chain a commit**
  (`driveClockTick` has no auto-fire branch). So if the clock drives `current` onto an armed
  `fireAt`, the marker **stays pending** and waits for the MD's manual "Go" (or a manual
  advance/release that legitimately fires it). Motion continues; only the *untrusted auto-commit*
  is withheld.

**This is the honest chunk-2 position:** until `clockConfidenceOk` exists (item 3) there is no
basis to auto-commit a structurally-significant change off a machine-placed arrival, so chunk 2
declines every one. It matches the parent's own posture (§6: even audio is shadow-only at v1)
and is strictly *more* conservative than the eventual gate — chunk 3 *relaxes* it (a HIGH-confidence,
recently-trued clock arrival may then auto-fire). No 5a behaviour regresses; no untrusted fire occurs.

---

## 6. Manual gesture mid-clock, and the redirect exclusion (carried from chunk 1)

These fall out of chunk 1's reckoning semantics + the seed-gated loop — chunk 2 adds no new
rule, only the loop that makes them observable:

- **A manual `advance` mid-clock re-anchors both axes.** `reckonAfter('manual')` sets
  `barsSinceAnchor = 0`, `motionBaselineAtMs = now`, `barsAtMotionBaseline = 0` → the next tick
  reckons `expected = 0` from the new baseline, no spurious owed advance. The MD stepping the
  playhead wins; the loop re-paces from there.
- **An align tap cancels pending motion and re-seeds.** Same re-anchor (`alignReckoning`), plus
  it **clears `stalled`** so a stalled clock resumes from the trued position. "Align cancels
  pending motion" (parent §8 item-2 test) = the re-baseline drops `owed` to 0.
- **A redirect does NOT touch trust or motion.** `anotherRound`/`hold`/`release`/`resetJump`
  leave `current` put (`:223`), so `reckonAfter('manual')` no-ops (chunk 1) and the motion
  timing is unchanged — the next clock advance simply reckons through the redirected VM. A
  redirect must never re-baseline or clear the stall (it is not a position assertion — parent
  §5.6-i / Codex R5).
- **Motion through a hold/vamp stays in lockstep** (parent §5.3, grounded `roadmap-vm.ts:440`):
  a `holding` vamp loops the body (`pass++`), so each clock advance writes a new `{barId,pass}`
  and `barsSinceAnchor`/`expected` advance together — no stall from the hold itself.

**Clearing `stalled` — gated on actual `current` movement, NOT on the action name** (Codex R1
MEDIUM). Set only by the loop (≥ 2 owed). Cleared **iff a manual gesture actually re-anchored** —
i.e. `reckonAfter('manual')` returned a *new* reckoning (`current` moved) or `alignReckoning`
ran (always re-zeros). Concretely: `align()` always clears; a manual `advance()` / Go-now
`commit()` clears **only when it moved `current`**. A **no-armed / stale / null-transition
`commit`** is `applied` *without* moving `current` (`reckonAfter` returns the input by identity,
chunk 1) → it must **NOT** clear `stalled`, exactly as Invariant (P) refuses to re-anchor it.
The disable/identity reset clears it (fresh reckoning). A redirect never clears it (no position
assertion). **Mechanism, not enumeration:** clear `stalled` in the *same* branch that detects the
re-anchor — `setStalled(s => nextReckoning !== prevReckoning ? false : s)` rides the existing
`reckonAfter` identity result, so "clear" and "re-anchor" are the *same* decision and cannot
drift. (Those re-anchoring actions reset `motionBaselineAtMs = now`, so the loop resumes
correctly from the trued position.) **Required test:** a no-armed `commit` while `stalled` leaves
`stalled` set.

---

## 7. Where it lives

- **`lib/conductor-clock.ts` (grows, still pure / MD-local):** `ClockRung`,
  `computeStaticRung`, `rebaselineMotion`, and a small `expectedClockBars(reckoning, now,
  barMs)` helper (the `floor` math, extracted pure so the loop is a one-liner and the math is
  unit-tested without timers). **No wire/broadcast addition** (item 4).
- **`lib/use-conductor-session.ts` (thin):** add `bpm` + `barBeats` to `UseConductorArgs`; a
  `clockOn` + `stalled` `useState`; the `prevBpm` re-baseline detector (§4); the `driverRef` +
  `cfgRef` (§3.2, written synchronously at every mutation seam); the `setInterval` driver effect
  (`driveClockTick`); clear `stalled` **gated on an actual re-anchor** (`nextReckoning !==
  prevReckoning`, §6) in the manual seams; reset `clockOn`?/`stalled` + interval teardown in the
  same two identity/disable spots chunk 1 resets reckoning. Surface `clockOn`, `setClockOn`, `rung`
  (= `computeStaticRung(...)`), `stalled` on `ConductorSurface`. **`applyWithAutoFire`
  untouched.**
- **`components/ConductorCluster.tsx` (thin):** a **Clock** on/off toggle (beside Auto-fire,
  default off) + a **rung readout** ("fixed tempo" / "manual") + a stall notice when `stalled`.
- **`app/api/shows/[owner]/[show]/route.ts` + `lib/types.ts` (the HIGH-2 data path):** add `bpm`
  to the `songs` select (`:25`), to `SetlistSong` (`:156`), and to the `hydrateFromEntries` map
  (`:32`). Inline-config (non-migrated) songs have no `bpm` ⇒ undefined ⇒ `manual` (honest). No
  `timeSig` widening in chunk 2 (follow-on).
- **`app/[owner]/[show]/page.tsx` (thin):** pass `bpm` (the conducted `SetlistSong`'s stated
  tempo, now hydrated) and `barBeats` (default 4 — `timeSig` not exposed yet); wire the new
  toggle + readout props.
- **`lib/conductor-state.ts` / `lib/conductor-session.ts`:** **NO change** (same fence as
  chunk 1 — the clock is MD-local until item 4 broadcasts it).
- **Tests:** `tests/conductor-clock.test.ts` (+ pure rung/rebaseline/expected cases);
  `tests/use-conductor-session.test.tsx` (+ driver cases, vitest fake timers);
  `tests/conductor-cluster.test.tsx` (+ Clock toggle + rung readout).

---

## 8. Worked traces

1. **Seed → dead-reckon.** `current=null`, clock on, bpm 120, 4/4 (`barMs=2000`). Loop idle
   (unseeded). MD taps "On the 1" at `t0` → bar 1 emitted, manual re-anchor (`motionBaselineAtMs
   =t0`, `barsSinceAnchor=0`). At `t0+2000` a tick: `expected=floor(2000/2000)=1`, `owed=1` →
   one clock advance → bar 2, `barsSinceAnchor=1`, `positionTrusted=false`. ✓
2. **Not-yet-owed tick.** At `t0+900`: `expected=floor(900/2000)=0`, `owed=0` → nothing. ✓
3. **Tab sleep.** Tab backgrounded `t0→t0+9000` (no ticks fire). On resume one tick:
   `expected=floor(9000/2000)=4`, `owed=4 ≥ 2` → **stall**, rung→`manual`, playhead frozen at
   bar 1, no replay. MD taps "On the 1" → re-seed, `stalled=false`, dead-reckon resumes. ✓
4. **Manual advance mid-clock.** Dead-reckoning at bar 5 (`barsSinceAnchor=4`). MD taps Advance
   → manual re-anchor onto bar 6 (`barsSinceAnchor=0`, `motionBaselineAtMs=now`). Next tick
   `expected=0`, `owed=0` → loop re-paces from bar 6, no double-step. ✓
5. **Tempo change (library edit).** Dead-reckoning at 120; MD edits `song.bpm`→140. `prevBpm`
   detector fires `rebaselineMotion(r,140,now)`: `barsAtMotionBaseline=barsSinceAnchor`,
   `motionBaselineAtMs=now`, `baselineTempoBpm=140`. Next bar lands at `now+ (60000·4/140)` ms
   — no jump, no stall; bars already played at 120 keep their duration. ✓
6. **Clock drives onto an armed fireAt (the chunk-2 defer).** Auto-fire ON, clock ON, marker
   armed at the next bar. The clock advance lands `current` on `fireAt` → `shouldAutoFire`
   true, but `driveClockTick` chains **no** commit → marker **stays pending**. MD taps "Go" →
   manual commit fires it (re-anchor). ✓ (Chunk 3 will let a confident clock arrival auto-fire.)
7. **Clock off = pure 5a.** `clockOn=false` → rung `manual` → loop idle; every advance/arm/
   commit/redirect behaves byte-for-byte as shipped. ✓
8. **Song end (Codex R3).** Clock drives onto the last bar; the advance sets `vm.done`. Now
   `computeStaticRung(done=true)=manual` → the next tick returns at the rung check (and the
   `vm.done` guard backstops it): no further `advance`, no `seq`/`updatedAt` churn, rung reads
   "manual", no artificial stall. The MD may align/advance into an encore (re-anchor re-seeds). ✓

---

## 9. Scope fence — parent §8 item-2 phrases, placed honestly

| Parent §8 item-2 phrase | Chunk | Why |
|---|---|---|
| motion-on-static-bpm | **2** | the driver (§3) |
| ≤1 advance/tick; multi-bar tick ⇒ stall, never replay | **2** | §3.1 |
| repeated-bar anchor: counter correct across repeat/D.S./volta | **2** | `reckonAfter('clock')` `{barId,pass}` (chunk-1 tested; re-asserted under the loop) |
| missing-meter `barBeats` fallback (→ 4) | **2** | `barBeats` arg defaults 4 (§1, §4) |
| honor a stated non-4/4 meter | **follow-on** | `timeSig` is stripped from Perform at the route (`:114`); chunk 2 takes the `barBeats` arg so this is a one-line wire later, not a reshape (§0) |
| tempo change re-baselines without a jump AND without a stall | **2** | `rebaselineMotion` (§4) |
| manual advance mid-clock re-anchors both axes; a redirect does NOT | **2** | §6 (chunk-1 semantics under the loop) |
| tab-sleep / long gap ⇒ drop rung, never fast-forward | **2** | §3.1 stall |
| align cancels pending motion | **2** | §6 (re-baseline ⇒ owed 0; clears stall) |
| each rung transition; stale→coast→static→manual at a boundary | **4** | `coasting`/`live` need telemetry; chunk 2 has only static↔manual |
| recovery-at-anchor; receipt-based reckoning; `ageMsAtSend` | **4** | telemetry machinery |
| clock-driven auto-*fire* (within-bound+HIGH fires; low-conf refuses; the R6 release repro; unconfirmed-start refusal) | **3** | `clockConfidenceOk` — chunk 2 *defers all* clock fires (§5), strictly more conservative |
| β clock-overrun → drops to `manual` | **3/4** | overrun needs a clock that can run *ahead of the band* = audio (item 4); the static click cannot out-run itself |

---

## 10. Build outline + tests

**Recommend an internal two-PR split** (each small, each Codex-reviewed at a stable ref) so the
pure math lands and is proven before the timer-driven hook edit:

**2a — pure (`lib/conductor-clock.ts` + `tests/conductor-clock.test.ts`):** `ClockRung`,
`computeStaticRung`, `rebaselineMotion`, `expectedClockBars`. Tests:
- `computeStaticRung`: off/no-bpm/stalled/**done** → `manual`; on+bpm+!stalled+!done → `static-bpm`.
- `expectedClockBars`: `floor((now−baseline)/barMs)` + `barsAtMotionBaseline` offset; 0 before
  one bar elapses; exact at the boundary; honours non-4/4 `barMs`.
- `rebaselineMotion`: sets `motionBaselineAtMs`/`baselineTempoBpm`, captures
  `barsAtMotionBaseline=barsSinceAnchor`, **leaves the trust axis untouched** (no `barsSinceAnchor`/
  `alignedAtMs`/`positionTrusted` change); post-rebaseline `expected−barsSinceAnchor=0`.

**2b — the driver + data path (`use-conductor-session.ts` + the show GET route + `types.ts` +
cluster + page + their tests, vitest fake timers):**
- **data path (HIGH-2):** `bpm` flows `songs` select → `SetlistSong` → `hydrateFromEntries` →
  page → hook; route test asserts a hydrated song carries `bpm` (and a legacy/inline song yields
  `bpm` undefined ⇒ `manual`).
- unseeded (`current=null`): no advance though time passes (seed-gating).
- after seed: one advance per `barMs` elapsed; **never >1 per tick**.
- **two due ticks inside one `act()` ⇒ exactly ONE advance, `barsSinceAnchor` +1 exactly**
  (the HIGH-1 batching-race regression — `driverRef` gate, §3.2).
- `owed ≥ 2` (advance timers by ≫ `barMs` in one step) ⇒ `stalled`, rung `manual`, **no
  advance**; a subsequent `align()` clears `stalled` and resumes.
- **a no-armed `commit` while `stalled` leaves `stalled` set** (the MEDIUM — clear is gated on an
  actual re-anchor, not the action name, §6).
- a manual `advance` mid-clock re-anchors (next tick no spurious advance).
- a `redirect` mid-clock leaves the reckoning untouched and does not clear a stall.
- a `song.bpm` prop change **mid-clock** re-baselines *through `driverRef`* (Codex R2 HIGH): the
  next tick does **not** advance or stall until exactly one *new-tempo* bar elapses — proving the
  driver, not just React state, saw the rebaseline (**no jump, no multi-bar catch-up, no stall**).
- clock ON + auto-fire ON, clock drives onto `fireAt` ⇒ marker **stays armed** (chunk-2 defer);
  a manual `commit` then fires it.
- **song end (Codex R3):** clock reaches the last emitted bar; after another `barMs` elapses
  **no advance is dispatched, no `seq`/`updatedAt` churn, and no artificial stall** (rung →
  `manual` on `vm.done`).
- `clockOn=false` ⇒ loop idle, all 5a hook tests still green (parity).
- cluster: Clock toggle fires `setClockOn`; rung readout renders "fixed tempo"/"manual";
  stall notice shows when `stalled`.

**Report the test-count delta** on each PR (standing rule). Branch each PR off the prior stable
ref; Codex per chunk.

---

## 11. My own adversarial sweep (pre-empting Codex)

- **(a) Stale closure in the interval — the #1 risk.** Addressed by the synchronously-written
  `driverRef` + render-mirrored `cfgRef` (§3.2); the clock path needs none of the auto-fire
  toggles (it defers), shrinking the captured surface to the fresh driver transaction +
  `bpm`/`barBeats`. Flagged the lint fallback (§12-Q3).
- **(b) Double-advance from a multi-tick batch (Codex R1 HIGH-1, FOLDED).** Closed by making
  `driverRef` the synchronously-written source of truth + re-entrancy gate (§3.2): a tick writes
  the advanced `{session,reckoning}` to the ref **before** any setState, so a second tick firing
  before the React commit reads the advanced ref and computes `owed = 0`. Functional setReckoning
  alone was insufficient — both updaters would compose the same `'clock'` transition off the
  committed reckoning and double-bump `barsSinceAnchor`. Locked regression: two due ticks in one
  `act()` ⇒ exactly one advance, `+1` exactly (§10, 2b). (`CLOCK_TICK_MS` no longer load-bearing
  for correctness, only for resolution — §12-Q2.)
- **(c) `barMs` from prop vs `baselineTempoBpm`.** Justified in §4: every tempo change resets
  `motionBaselineAtMs` *through `driverRef`* (R2 fix), so elapsed-since-baseline is always at the
  prop tempo. `baselineTempoBpm` is bookkeeping + the change-detector record. (If Codex prefers
  the driver read `reckoning.baselineTempoBpm` for self-containment, that's a one-line swap once
  §4's first-known-bpm rebaseline guarantees it non-null — noted §12-Q1.) **The rebaseline is now
  itself a `driverRef` transaction (R2 HIGH), so EVERY reckoning/session/stalled mutation seam —
  manual run/applyWithAutoFire/align, the tick, the reset, AND the tempo detector — writes the
  authoritative ref before mirroring to React state. That uniformity IS the invariant.**
- **(d) Seed-gating vs an empty chart, AND song end (Codex R3 HIGH, FOLDED).** `current` stays
  null on an empty chart ⇒ inert. A chart that *plays to the end* leaves `current` on the last bar
  with `vm.done` true — a done-`advance` is `applied` (not `ignored`), churning `seq` while
  `current`/`barsSinceAnchor` stay put and `owed` only grows. Closed by `done ⇒ manual` in
  `computeStaticRung` (§2) plus a tick-level `vm.done` guard (§3.1): the loop dispatches nothing at
  song end. Regression in §10.
- **(e) Clock on + never seeded.** Loop idle until "On the 1". No auto-start, no count-in
  invented — matches parent §1.
- **(f) Frozen surfaces.** `shouldAutoFire`, `applyWithAutoFire`, the reducer, and the wire are
  all untouched; chunk 2 is additive hook state + a pure-math grow + one loop. The clock `'clock'`
  provenance row (chunk-1, already tested) gets its first caller — no reshape.
- **(g) Interval lifecycle / leaks.** Effect keyed `[enabled, clockOn]`; cleanup clears the
  interval on toggle-off, disable, identity change, unmount. No orphaned timer.

---

## 12. Open questions for Graham (small)

1. **`barMs` source — prop `bpm` vs `reckoning.baselineTempoBpm`.** I use the prop (§4/§11-c);
   both are equal post-rebaseline by construction. Confirm, or prefer the self-contained read.
2. **`CLOCK_TICK_MS` value.** Recommend ~80 ms (resolves every bar to 400 bpm with margin).
   No longer load-bearing for *correctness* (the `driverRef` gate closes the batching race
   regardless of tick rate, §3.2) — it's a resolution knob only. Tune in UAT (defer-with-default).
3. **`cfgRef` write site.** `ref.current = …` during render (idiomatic) vs a deps-free effect.
   I'll use whichever the repo's lint accepts; flagging in case there's a house preference. (The
   `driverRef` is written at mutation seams, not during render, so it's unaffected.)
4. **Clock toggle persistence.** Per-session local state (resets on chart change) — or should
   "clock on" persist across charts in a show? Recommend per-session for v1 (simplest, safe).
5. **Two-PR split (§10) acceptable**, or land item-2-static as one PR? Recommend the split.
