# Conductor Authority — Chunk 5b: the clock layer + OQ-1 resolution (§5.1, §8.2-1)

**Status:** **v0.6.1 — DESIGN-ONLY, post-Codex-R4; fork reframed by a buildability check.**
Resolves epic open item **§8.2-1** (`docs/design-conductor-authority.md:207` — *"Listener
placement + clock latency"*), the single decision fence on chunk 5b. Builds on chunk 5a (gated
auto-fire on arrival, SHIPPED to prod `de8e414`). **No code in this pass.** v0.3 closed the §7
dialogue; v0.4 folded Codex R1 (data shape + motion shell + cross-device honesty); v0.5 folded
Codex R2 (anchor-as-counter, single-advance tick, meter, telemetry order); v0.6 folded Codex
R3 (3 HIGH, 3 MEDIUM) + 3 of my own. **v0.6.1 folds Codex R4 (2 HIGH, 1 LOW)** — both HIGHs
were real and I should have caught them:
- **HIGH (R4) — tempo re-baseline stalled the motion counter.** v0.6.0 reset
  `anchorAtMs = now` on a tempo change while the §5.3 motion comparison read elapsed against
  that same timestamp vs. an unchanged `barsSinceAnchor` → ~5 bars of dead air before the next
  advance. **Fix (§5.1):** split the **trust axis** (`barsSinceAnchor`/`alignedAtMs`, resets
  only on an MD gesture) from the **motion axis** (`motionBaselineAtMs`/`barsAtMotionBaseline`,
  re-baselines on tempo change too). Motion reckons `expected = barsAtMotionBaseline +
  floor((now − motionBaselineAtMs)/barMs)`.
- **HIGH (R4) — α's backward re-seat assumed a `seek` primitive that doesn't exist.** The
  shipped reducer (`conductor-state.ts:221`) makes `redirect` move the *next-step seed only*;
  `current` is unchanged until the next advance. So α can't "snap the playhead to a head" on
  today's wire — it needs a **net-new `seek` directive** (own chunk). **Reframe (§5.4): ship
  β in v1** (forward-only, builds on the shipped wire, zero new reducer surface); **defer α**
  behind a future `seek` directive if UAT shows overrun is common. I had recommended α without
  checking the wire — corrected.
- **LOW (R4)** — build-outline drift still said "preserve latch"; aligned to "recompute" (§5.4).

The v0.6 findings still stand below — the design had drifted into trusting the clock to
validate itself:
- **HIGH (R3) — auto section-boundary re-zero defeated the trust bound.** A *clock-predicted*
  boundary must NOT refresh position trust (circular: the clock asserting its own
  correctness). Only an **MD gesture** re-anchors trust; a predicted head may re-zero display
  phase but not the bound (§1, §5.1, §5.3, §4.3).
- **HIGH (R3) — the 5b gate could break the shipped 5a manual floor.** A manual advance onto
  `fireAt` is exact and must fire even with the clock coasting/off. Fix (§5.2): pull the
  confidence-AND **out of `shouldAutoFire` (stays frozen 5a) into the clock *driver*** — only
  clock-driven advances consult confidence; manual taps use the verbatim 5a path.
- **HIGH (R3) — elapsed-bars formula off by 1000** (ms × bpm/60, not /60000). Fixed §5.3.
- **MEDIUM (R3)** — `barsSinceAnchor`/timestamps are **MD-local**, not on the wire, updated
  atomically with the advance (§5.1 wire-vs-local split); **MEDIUM (R3)** — re-seat
  *recomputes* eligibility (not blind-preserve), surfaces "re-arm needed" (§5.4);
  **MEDIUM (R3)** — node telemetry needs `listenerId` + `telemetryEpoch` for restart (§2.3).
- **MINE (Codex missed): (i)** a manual advance/redirect *while the clock runs* is an implicit
  re-anchor — the human just asserted place (§5.6-i); **(ii)** the closed-form bar count is
  invalid under varying tempo — must re-baseline on every accepted tempo change (§5.6-ii);
  **(iii)** smooth motion is MD-local; followers move at **broadcast/bar granularity** — a
  stated scope boundary, not a bug (§5.6-iii).

One product fork — *can the redline move backward on a re-anchor* — remains Graham's call
(§5.4 / Decision 5). The honest framing after R4: **β is buildable today; α is a separate
`seek` primitive (own chunk).** My corrected recommendation is **β for v1, α as a fast-follow
if UAT warrants** — but the v1 build is unblocked under β either way. Ready for R5.

> **The chunk-5a / chunk-5b split (do not blur it).** 5a auto-*fires* an armed change
> when the MD's *manual* advance lands on the fire bar — it reads **no clock** (D1).
> 5b adds the clock: dead-reckoned auto-*advance* between anchors, so the playhead can
> move without a tap. 5b is the only thing that makes the §3.5 *confidence* gate
> load-bearing. Everything below is about turning that clock on **honestly**.

---

## 0. The question (verbatim, §8.2-1)

> dedicated node vs. MD device; phase alignment across relay latency (likely invisible
> at bar granularity — confirm); clock behavior when the listener drops.

Three sub-questions: **(Q1)** where the listener runs, **(Q2)** whether relay latency
corrupts phase, **(Q3)** what happens when the listener dies. Plus the standing §5.1
spine each must honor: **degrade precision, never honesty**, and **source quality is the
whole ballgame** (audio-tempo designed-in now, on only after live validation).

---

## 1. What the clock is *for* (the frame that makes the answers fall out)

From epic §5.1, restated so the OQ-1 answers are forced, not invented:

- **Clock owns speed; MD owns place (the spine of all four answers).** Beat-tracking
  yields *tempo*, never *position*. So in follow mode the clock **auto-advances the
  playhead continuously — bar to bar, at the tracked tempo** (the redline moves on its
  own; that motion *is* the feature, not a display gloss). But the audio can only say *how
  fast*, never *where* — so **the MD seeds and re-trues position** with an **align/true-up
  tap** (same gesture as follow-me, confirming "we're here now," forward). **Position
  *trust* is refreshed only by that MD gesture** — never by the clock predicting it reached a
  section head (that would be the clock validating itself; §5.1 / R3 HIGH-1). A predicted head
  may tidy *display phase*, but the trust bound keeps climbing until a human re-anchors, so a
  band that true-ups every section keeps drift bounded *by gesture*, and a clock left
  un-trued is distrusted past one phrase. The two named failure points — **no count-in at
  start** and **drift over a span** — are both solved by the MD's align tap; the audio is a
  kick, the MD is the downbeat.
- **Follow only exists in MD-led mode.** In self-serve mode every phone self-drives and
  there is no master clock to follow — the listener/clock simply does not engage. The
  clock layer is therefore inherently an MD-mode feature, which is why the MD's own device
  is the natural listener (§2).
- **One listener, one broadcast clock.** Detection runs on exactly **one device**; its
  output is **telemetry to the MD**, who re-emits an authoritative `clock` (tempo +
  downbeat phase + confidence) under its own `(epoch, seq)`. The listener is **never a
  second writer** (epic finding 6). This is already locked architecture — OQ-1 only
  decides *which device* and *how it degrades*, not *who writes*.
- **The clock can only ever make the playhead move; it can never make it jump.** A jump
  is a structural decision (an armed change), and that stays MD-authored (5a). The clock
  feeds `advance` and nothing else — `advance` remains the **only** `stepVM` caller
  (chunk-5a invariant, design-conductor-chunk5.md §107).

**Consequence:** a wrong clock degrades to *the MD tapping advance* (5a), which is always
present and always correct. That is the floor every OQ-1 answer falls back to.

---

## 2. Q1 — Listener placement: MD-mic vs. dedicated node

**This is a deployment choice, not an architecture choice** — the telemetry→MD→re-emit
seam (§1) is identical either way — and it only matters in MD-led mode (§1). So the design
question is really *"which ships as the default, and what is the contract between them?"*

### 2.1 The two placements

- **(A) MD-device mic — the v1, and the natural one.** The MD's phone listens to the room
  / its own monitor. In MD-led mode the MD's device is already the clock authority, so the
  ear and the writer are the same device — zero extra hardware, setup, relay traffic, or
  failure points; validates the whole dead-reckoning pipeline end-to-end. Cons: the MD's
  phone may sit in a poor acoustic spot (stand, pocket), exposed to crowd noise / monitor
  bleed — source quality is whatever the MD's position gives.
- **(B) Dedicated listener node — a UAT-deferred upgrade.** *A node is any spare device
  (an old phone/tablet) taped near a clean source* — a DI split, a monitor send, an
  overhead — **not a musician's playing device and not tied to any one player.** A
  dedicated ear in a good spot, sending telemetry to the MD over the same own-AP relay.
  Pros: clean source = the whole ballgame; detection quality jumps; frees the MD's device.
  Cons: extra device + setup, one more relay participant, one more thing that can drop
  (→ Q3).

### 2.2 Recommendation (RESOLVED — Graham)

**Ship (A) MD-mic as v1.** The seam is built once and is placement-agnostic, so (B) stays
*possible* with no architecture change — but its specifics (when a clean-source node earns
its keep over the MD's own mic) are a **UAT question, deferred**: we'll learn from real
gigs whether MD-mic source quality is good enough or whether a node is warranted. The
floor is always 5a manual advance; the listener/clock engages only in MD-led mode.

### 2.3 The telemetry contract (listener → MD)

The listener emits, the MD ingests + re-emits. *Telemetry is not state.* Proposed shape
(refines the epic's `clock`; final field set is a build detail):

```ts
type TempoTelemetry = {
  tempoBpm: number;          // detected beats/min
  downbeatPhase: number;     // [0,1) fraction into the current beat, as of the instant below
  confidence: number;        // [0,1], the detector's own self-report
  // freshness, NOT a cross-device timestamp (HIGH-1): the listener reports how long ago
  // (in its OWN monotonic frame) this estimate was taken — `ageMsAtSend = listenerNow −
  // measuredAt`. The MD reads it as "this was true `ageMsAtSend` before I received it,"
  // and dead-reckons from RECEIPT (its own clock), never by subtracting the listener's
  // clock from its own. See §3.
  ageMsAtSend: number;
  // ordering identity (R2 MEDIUM + R3 MEDIUM): per-listener monotonic seq for latest-wins
  // drop, scoped by a listener incarnation so a RESTART (which resets seq to 0) doesn't get
  // every future packet dropped. The MD keeps lastAcceptedSeq PER (listenerId, telemetryEpoch);
  // a higher telemetryEpoch is a fresh incarnation → reset the accepted-seq watermark.
  listenerId: string;        // stable id of the listening device
  telemetryEpoch: number;    // bumped on listener (re)start — the incarnation
  seq: number;               // monotonic WITHIN an incarnation
};
```

The MD validates, applies its own confidence policy (§5), and re-emits the authoritative
`ConductorState.clock` under its OWN `(epoch, seq)`. **If the listener IS the MD device (the
v1, §2.2), the whole path runs in-process — no wire hop, no relay, no reordering,
`ageMsAtSend` ≈ 0, and the clock the estimate was taken against IS the clock the MD reckons
against.** One code path, two placements.

**Telemetry ordering (Codex R2 + R3 MEDIUM — node-deferred).** On a degraded network a queued
*old* node packet can arrive late and, because the MD reckons from receipt, look "fresh
enough." So the **listener stamps `(listenerId, telemetryEpoch, seq)`**, and the **MD's ingest
is latest-wins per incarnation**: keep `lastAcceptedSeq` keyed by `(listenerId,
telemetryEpoch)`, accept only a strictly greater `seq` within the same incarnation, and treat
a higher `telemetryEpoch` as a fresh stream (reset the watermark) — so a **listener restart**
(seq → 0) is not silently dropped forever (R3 MEDIUM-3). Additionally reject a packet whose
recovered detection age (`ageMsAtSend` + measured one-way transit, bounded per §3) exceeds the
coasting timeout — a stale estimate must not masquerade as live. MD-mic v1 is in-process so it
cannot reorder or restart-mid-stream; this contract is the precondition that makes the
deferred node (§2.2) placement-compatible, and it ships *with* the node, not before.

---

## 3. Q2 — Phase alignment across relay latency (confirm "invisible at bar granularity")

**Confirmed: invisible, with one cheap safeguard.** The arithmetic:

- Own-AP WebSocket relay latency is single-digit to low-tens of **milliseconds** (LAN, no
  backhaul — the epic's whole transport premise).
- A beat at 120 BPM = **500 ms**; a 4/4 bar = **2000 ms**. Even a pessimistic **50 ms** of
  transit is **10 %** of a beat / **2.5 %** of a bar. At the bar granularity the redline
  cares about (we light *bars*, not sub-beats), that is well under the threshold of
  visible error.
- The clock re-zeros *display phase* at every section head + re-anchors trust on every MD
  cue (§1, §5.1), so transit error (a phase term) **cannot accumulate** — it is bounded to a
  single span and the phase reset is frequent. (Phase reset is cheap and self-asserted;
  *trust* is the thing that waits for the human — §5.1 R3 HIGH-1.)

**The cheap safeguard — carry freshness, reckon from receipt (HIGH-1 fix).** v0.3 proposed
the MD compute `nowMs − sentAtMs`. That is **invalid across devices**: monotonic clocks are
process-local with arbitrary epochs, so subtracting a listener node's timestamp from the
MD's own is meaningless without an offset sync. The correct, clock-sync-free form:

- **MD-mic (A, the v1):** listener == MD process, **one clock.** `ageMsAtSend ≈ 0`; the MD
  reckons from now. The transit term is genuinely ~0 and the math is exact — no protocol.
- **Dedicated node (B, deferred):** the listener reports `ageMsAtSend` in *its own* frame;
  the MD treats **receipt as now** and adds back `ageMsAtSend` to recover detection age,
  then carries the *one-way relay transit* as the only unmodelled term. That transit is the
  single-digit-to-50 ms bounded above — **the 2.5 %-of-a-bar that this section already
  proves invisible.** So even uncompensated, node transit lives under the visible-error
  threshold; the section-head phase re-zero (§1) keeps it from accumulating.
- **True cross-device sub-ms compensation** (an NTP-style offset handshake over the own-AP
  relay) is **deferred *with* the node** (§2.2) — it is an optimisation of an already-
  invisible term, not a correctness requirement.

So Q2 resolves to: **latency is a non-issue for correctness at bar granularity. In-process
(v1) it is exactly zero; cross-device (deferred) it is a bounded, already-invisible one-way
transit — reckon from receipt, never by subtracting a foreign monotonic clock.**

---

## 4. Q3 — Listener-drop behavior (the degrade ladder, made honest)

The §5.1 ladder — **live audio → last-known → static BPM → seek-only** — is the answer;
this pass makes each rung an explicit, *surfaced* clock state and binds it to the floor.

### 4.1 The clock-state ladder

| Rung | Trigger | Motion | UI must say |
|---|---|---|---|
| **live** | telemetry fresh + confidence ≥ HIGH | dead-reckon at detected tempo | (nothing — normal) |
| **coasting** | telemetry stale/low-conf < *T* sec | dead-reckon at **last-good** tempo | "holding tempo" |
| **static-bpm** | no telemetry, song has a stated BPM | dead-reckon at **stated** BPM | "fixed tempo" |
| **manual** | no telemetry, no BPM (or MD opts out) | **none — pure 5a manual advance** | "manual" |

Falling a rung is automatic and silent-to-the-band but **never silent to the MD**: the
clock state is shown so the MD always knows whether the playhead is self-driving or
waiting on a tap. **Degrade precision, never honesty.**

### 4.2 Drop never strands, never freezes

- A dropped listener can only ever cost *audio-driven motion*, never togetherness: every
  device keeps its own offline redline (epic §5 per-device floor), and the MD can always
  advance manually (5a). The bottom rung **is** chunk-5a, which is shipped and correct.
- **Motion runs on every non-manual rung; only auto-*fire* is gated.** The playhead
  auto-advances on `live`, `coasting`, AND `static-bpm` — `static-bpm` *is* the
  click/metronome guide (§3), driving the redline off the stated tempo even with no audio.
  `manual` is the only rung with no clock motion. *(This is the **validated** steady state.
  Until the `live` rung clears §6 validation for that source, it is **shadow-only** and
  drives nothing — the effective top driving rung is `static-bpm`. The ladder below is what
  runs once audio has earned the redline.)* What the §3.5 gate (§5) restricts is the
  auto-*commit of an armed structural change*: a jump auto-fires only when position is
  trustworthy (recently re-trued by an MD align tap / within the bars-since-anchor bound,
  and on `live` at HIGH confidence). Below that bar the change waits for the MD's tap —
  i.e. 5a. So a noisy or BPM-only clock still *flows* the redline; it just asks the MD to
  confirm structural changes.
- **No jitter/lurch:** coast at last-good rather than chase a noisy estimate (§5.1).

### 4.3 Re-arm on recovery

When telemetry returns to HIGH, the clock climbs back to the `live` **rung** at the next
clean phase point (a section head or an MD cue), not mid-span — recovery re-acquires tempo at
a downbeat rather than snapping the playhead, same discipline as initial acquisition. Note
this is a *rung* (audio-quality) recovery and a *phase* re-acquire; it does **not** by itself
refresh position **trust** — `barsSinceAnchor` keeps climbing until an MD gesture re-anchors
(§5.1 R3 HIGH-1). Regaining a clean tempo signal is not the same as a human confirming place.

---

## 5. The clock data shape, the gate, and the motion shell

v0.3 specified the *pure* layer (the §4.1 ladder, the gate below) but hand-waved (a) the
exact `clock` fields the frozen `shouldAutoFire(session)` reads, (b) the imperative driver
that actually ticks the playhead forward, and (c) the position-correction primitive. Codex
R1 flagged all three (HIGH-2, MEDIUM-2, MEDIUM-3). They are one thing — *the shell around
the pure clock* — so this section nails all three.

### 5.1 The clock data shape (HIGH-2 — frozen signature ≠ frozen field set)

The clock data splits in two — **what followers need to render motion (wire)** vs **what
only the MD needs to reckon and gate (local)**. Conflating them was the MEDIUM-1 skew bug.

**(a) Broadcast (additive to the existing `ConductorState.clock`,
`lib/conductor-session.ts:55` — re-emitted under `(epoch, seq)`).** Only what a follower
needs to draw the redline + show the clock state. NO MD-clock timestamps (a follower's clock
differs — they'd be meaningless) and NO counter:

```ts
type ConductorClock = {            // the WIRE shape — additive, no new top-level type
  rung: 'live' | 'coasting' | 'static-bpm' | 'manual';  // §4.1 ladder (so followers can show it)
  tempoBpm: number | null;         // current reckoning tempo (last-good on coast, stated on static)
  confidence: number;              // [0,1] MD-validated; static-bpm/manual report a sentinel low
};
// (`current` already travels in ConductorState — that IS the broadcast position. §5.6-iii.)
```

**(b) MD-local reckoning (NOT on the wire — lives beside `armedFireAtEligible`/`autoFireOn`
in the hook, MD device only).** The gate runs only on the MD (single writer), so the things
the gate reads live here, updated **atomically with the advance the driver emits** — never a
separate clock payload, so there is no cursor/counter skew (MEDIUM-1):

```ts
type ClockReckoning = {            // MD-LOCAL — never broadcast
  anchor: { barId: string; pass: number };  // FULL TraversalStep last TRUST-re-zeroed onto — NOT barId alone
  // ── trust axis (resets ONLY on a real MD gesture, §5.1 / R3 HIGH-1) ──
  barsSinceAnchor: number;         // advances DRIVEN since the last MD gesture; the gate's §7-4 bound reads THIS
  alignedAtMs: number | null;      // MD-clock instant of the last MD GESTURE (null ⇒ never trued)
  // ── motion axis (re-baselines on tempo change too, §5.6-ii / R4 HIGH-1) ──
  motionBaselineAtMs: number;      // MD-clock instant the CURRENT tempo baseline began (motion reckons elapsed from THIS)
  baselineTempoBpm: number;        // tempo in force at motionBaselineAtMs
  barsAtMotionBaseline: number;    // the value of barsSinceAnchor captured at motionBaselineAtMs
};
```

**Two axes, two zeroes (R4 HIGH-1).** The trust counter (`barsSinceAnchor`) and the motion
pacer must NOT share a clock. The gate's §7-4 bound counts bars since the last *human* anchor,
so it can only reset on an MD gesture. But the motion driver paces off *elapsed wall-clock at
the current tempo*, which must re-zero on every tempo change — otherwise (the R4 catch) a
re-baseline that sets `motionBaselineAtMs = now` while `barsSinceAnchor` stays at 4 makes the
driver wait ~5 fresh bars before the next advance. So motion reckons against its **own**
baseline pair: expected-bars = `barsAtMotionBaseline + floor((now − motionBaselineAtMs) /
barMs)`, compared to `barsSinceAnchor`. A tempo change captures `barsAtMotionBaseline =
barsSinceAnchor` and `motionBaselineAtMs = now` → expected − driven = 0, no stall, no jump. A
trust re-anchor (MD gesture) resets **both** axes (`barsSinceAnchor = 0`, `alignedAtMs = now`,
`motionBaselineAtMs = now`, `barsAtMotionBaseline = 0`).

**Why `barsSinceAnchor` is a counter, not graph math (R2 HIGH).** `VMState.cursor` is a
bar-*order* position the VM **revisits** — repeats/voltas/D.S. re-enter the same `cursor`,
`pass` increments each visit (`lib/roadmap-vm.ts` `passCount`), and there is **no monotonic
emitted-step index**. So "current ordinal − anchor ordinal" is ambiguous. The honest
distance is the **count of advances actually taken** — the clock takes them (§5.3), so it
maintains `barsSinceAnchor`: **+1 on every clock-driven advance**, immune to revisits.

**What resets it — only an MD gesture, NEVER a clock-predicted boundary (R3 HIGH-1).** v0.5
said "reset on align tap / section boundary." The boundary half is wrong and circular: if a
*clock-predicted* section head refreshed the trust counter, the clock would validate its own
correctness — drift could never accumulate past one section and a wrong clock could stay
"trusted for auto-fire" forever. So:

- **A trust re-anchor (resets `barsSinceAnchor = 0`, sets `alignedAtMs = now`) happens ONLY
  on a real MD gesture** — an align/true-up tap, a follow-me, an MD cue. The human is the
  only thing that can assert "we are *here* now."
- **A clock arriving at a section head re-zeros *display phase* only** (cosmetic — the redline
  sits cleanly on the downbeat). It does **not** touch `barsSinceAnchor`, `alignedAtMs`, or
  trust. So far from the last *human* anchor, the bound trips and auto-fire refuses even if
  the clock happens to be coasting through section heads.

The gate's "recently trued" test reads `alignedAtMs`; its position-trust test reads
`barsSinceAnchor` against the §7-4 bound.

> **Authority-doc amendment (Codex R2 LOW, merge step).** `docs/design-conductor-authority.md`
> §5.1 still shows the pre-5b compact clock `{ tempoBpm, downbeatAt?, confidence }`. This
> §5.1 supersedes it. **On merge of this doc to main, amend the authority §5.1 clock shape**
> (or mark it "pre-5b — see chunk-5b §5.1"). Not edited here (that doc is on main; this is a
> design branch).

### 5.2 The confidence gate lives in the DRIVER, not in `shouldAutoFire` (R3 HIGH-2)

v0.4/v0.5 said "AND the confidence conditions into `shouldAutoFire(session)`." **That breaks
the shipped 5a floor.** `shouldAutoFire` fires on *any* arrival onto `fireAt`; a **manual**
advance onto `fireAt` is **exact by construction** and must fire — even while the clock is
coasting, far past anchor, or off. If confidence were ANDed into `shouldAutoFire`, a manual
tap during a low-confidence clock would be *refused* — a regression of the live 5a behaviour.

The clean separation (and it keeps `shouldAutoFire` genuinely frozen — better than my earlier
plan):

- **`shouldAutoFire(session)` stays verbatim 5a** — `armed ∧ current.barId === fireAt ∧
  holding == null`, rising-edge. It is the *exact-arrival* predicate, nothing more.
- **The confidence gate is the *driver's* business.** Provenance is structural, not a flag in
  the session: a **manual** advance comes from the component's `advance()` (the 5a path) and
  auto-fires on `shouldAutoFire` **unconditionally** — the 5a floor, untouched. A
  **clock-driven** advance comes from the motion loop (§5.3), which BEFORE chaining the commit
  additionally requires `clockConfidenceOk(reckoning, rung)`:
  - `barsSinceAnchor ≤ bound` (§7-4), AND
  - rung confidence — `live`: `confidence ≥ HIGH`; `static-bpm`: `alignedAtMs` within the
    bound is the warrant (the click has no audio confidence); `coasting`: never auto-fires.
- So a noisy/low-confidence clock still **moves** the redline; it just declines to auto-commit
  a structural change — leaving the armed marker for the MD's manual tap, which fires via the
  plain 5a path. Motion is never gated; only the *clock-initiated* auto-commit is.

Concretely the existing helper gains a caller-supplied flag —
`applyWithAutoFire(before, res, { requireClockConfidence })` — manual `advance()`/`redirect()`
pass `false` (5a verbatim); the motion loop passes `true`. `shouldAutoFire`'s signature and
body are untouched.

This is where **`armedFireAtEligible` becomes genuinely load-bearing** (epic/5a note): under
dead-reckoning the playhead may *not* land on `fireAt` exactly, so the arm-time
forward-reachability check stops a dead marker from arming. (5a's note that `fireAtEligible`
may be upgraded to a bounded VM walk *without signature change* lands here.)

### 5.3 The motion shell — who actually ticks the playhead (MEDIUM-2)

The §4.1 ladder reducer is **pure**; something imperative must drive `advance` off it. The
contract for that single driver (a hook-owned `requestAnimationFrame`/timer loop, one
instance, MD device only):

- **At most ONE advance per tick, through the existing gate (Codex R2 HIGH).** Each tick the
  loop computes the bars that *should* have been emitted at the current tempo baseline. With
  `barMs = 60000 · barBeats / baselineTempoBpm` (§5.5; note **60000** — ms — not 60; the R3
  HIGH-3 off-by-1000), that is `expected = barsAtMotionBaseline + floor((now −
  motionBaselineAtMs) / barMs)` — reckoned from the **motion** baseline, NOT the trust anchor
  (R4 HIGH-1: the two desync on a tempo re-baseline). If `expected` exceeds the driven count
  `barsSinceAnchor` by **one**, the loop emits **exactly one** clock-driven `advance` — routed
  through the **same rising-edge `applyWithAutoFire` chain** with `requireClockConfidence: true`
  (§5.2) — increments `barsSinceAnchor`, and **stops for this tick**, re-reading state next tick. It NEVER loops N
  advances in one turn: that is what could skip a fire bar, fire after passing it, or advance
  again past a fresh commit target. The loop also halts immediately when the chain reports
  `commit` / `hold` / `done` / `ignored` — one transition at a time, always re-evaluated.
  `advance` stays the **only** `stepVM` caller (§1).
- **More than one bar owed in a tick ⇒ a stall, not catch-up.** In the foreground a bar is
  hundreds of ms and a tick is ~16 ms, so ≥2 bars owed means the loop was suspended (tab
  sleep, screen lock). The loop must **not** fast-forward the missed bars — a stale
  `tempoBpm` across an unknown gap is the "confidently wrong" failure. Instead: if elapsed
  exceeds the §7-4 bound (≈ one phrase) the clock **drops to `coasting` then `manual`** and
  waits for the MD's next align tap; the playhead freezes where it last legitimately was
  rather than lurching ahead. (Same bound that gates auto-fire, reused.)
- **A manual align tap cancels any pending motion and re-seeds.** The tap is a trust re-anchor:
  it writes a new `anchor`, sets `alignedAtMs = now`, resets `barsSinceAnchor = 0`, and resets
  the motion axis too (`motionBaselineAtMs = now`, `barsAtMotionBaseline = 0`); the next tick
  reckons from the *new* baseline. No queued advance survives a re-anchor.
- **ANY MD advance/redirect while the clock runs is an implicit re-anchor (MINE, §5.6-i).**
  If the clock is driving the playhead and the MD *also* manually advances or redirects, the
  human has just asserted place — and the loop's `barsSinceAnchor`/`motionBaselineAtMs` would
  otherwise desync from the cursor the MD just moved (the loop thinks fewer bars elapsed than
  the cursor shows). So a manual nav action during clock-on is a trust re-anchor onto the
  resulting `current` (`barsSinceAnchor = 0`, `alignedAtMs = now`, `motionBaselineAtMs = now`,
  `barsAtMotionBaseline = 0`). The MD is always the position authority; a tap never races the
  clock, it *becomes* the new anchor.
- **Manual rung = loop idle.** On `manual` the loop emits nothing; the floor is 5a, the
  MD's tap is the only motion.

### 5.4 Backward correction — the one genuine fork (MEDIUM-3, FLAGGED for Graham)

v0.3 called the align tap "forward only," but a dead-reckoned clock can over-run *ahead* of
the band — then truth is *behind* the playhead, and forward-only can't pull it back. 5a's
`advance` is forward-only (no backward `stepVM`), so this is a real design fork, not a detail.

**Buildability check first (R4 HIGH-2 — the blocker I missed).** v0.6.0 claimed α re-seats
backward "through the existing redirect/seek path." There **is no such path.** The shipped
reducer (`lib/conductor-state.ts:221`) makes `redirect` move the *next-step seed only* —
`current` is explicitly left unchanged until the following `advance`. Only `advance` and
`commit` write `current` (both via `stepVM`, both forward). So nothing in the wire today can
"snap the playhead to a head," and the parks-before/on/behind-`fireAt` rising-edge cases below
**cannot occur as written** — a redirect would leave `current` ahead of the head, not on it.
α is therefore **not buildable on the shipped protocol**; it needs a *new* directive. That
reframes the fork:

- **(β) No backward motion ever; clock-ahead degrades to manual — the v1-buildable option
  (NOW RECOMMENDED for v1).** If the clock runs ahead, the align tap can't pull it back; the
  clock drops to `manual` and the MD re-places using the **existing** structural controls
  (redirect → advance). Simpler invariant, *builds on the shipped wire with zero new reducer
  surface*. The felt cost: the redline can sit ahead until the MD's next manual gesture — but
  that gesture is one tap, and on a dead-reckoned clock the MD is watching anyway.
- **(α) Anchors may re-seat backward — DEFERRED, requires a new `seek` directive.** A
  section-head re-zero that *actually moves `current` backward* (and broadcasts it to
  followers) is a **net-new conductor directive**: a `seek`/`reSeat { to: TraversalStep }`
  that sets `current` (and re-seeds `vm.cursor`) atomically, plus follower handling and a
  snapshot path. That is real reducer + protocol work, not a v1 detail. Worth doing if UAT
  shows clock-overrun is common, but it should be its **own** chunk with its own review —
  **not smuggled into 5b under the word "seek."**

**My corrected recommendation: ship β in v1; file α (the `seek` directive) as a fast-follow if
UAT warrants.** This is a change from v0.6.0, where I recommended α without checking the wire
supported it. Still **Graham's call** — but the honest framing is now "β is buildable today, α
is a separate primitive," not "α vs β, pick one."

**The armed-marker rule — only relevant IF α's `seek` is later built (Codex R2 MEDIUM, kept
for that chunk).** β never moves position backward, so under β a marker armed before an
overrun simply stays pending or trips the §7-4 bound like any other — no special rule needed.
The recompute rule below is the spec for the *future* `seek` chunk, recorded here so it isn't
re-derived:

- A `seek` re-seat **keeps the armed marker** (it is a reposition, not a commit/disarm — the
  MD didn't cancel the change). But the **eligibility latch is RECOMPUTED, not blindly
  preserved** (R3 MEDIUM-2 — v0.5 contradicted itself by saying both "preserve the latch" AND
  "the reachability walk refuses"; both can't hold if the latch stays true). The rule: after
  the re-seat, re-run the chunk-3 forward-reachability walk for `armed.fireAt` from the new
  cursor and **set `armedFireAtEligible` to its result**.
- Because `seek` writes `current` directly, it routes through the **same rising-edge
  `applyWithAutoFire` chain** (§5.3) → the gate recomputes from `before`/`after`, consistent
  with 5a:
  - **parks before `fireAt`** (the normal case — a head earlier than the marker): still
    reachable → `armedFireAtEligible = true`, marker pending, fires later on genuine arrival;
  - **parks on `fireAt`** and that flips `shouldAutoFire` false→true: it **fires**, exactly
    as an advance-arrival would (the MD caused a real arrival);
  - **leaves `fireAt` behind the new cursor** (stranded): the reachability walk returns false
    → **`armedFireAtEligible = false`**, the gate cannot fire it, and the UI surfaces
    **"re-arm needed"** so the MD re-arms or disarms. No stale-open gate, no silent strand —
    and now the latch state and the gate agree.

**I recommend (α) with this rule** — it keeps the redline honest with the cheapest gesture,
bounds the one backward move to a structural anchor, and reuses the shipped 5a edge gate
verbatim. **Graham's call** before chunk 1 builds.

### 5.5 Bar duration — where `barBeats` comes from (Codex R2 MEDIUM)

§5.3 converts elapsed time → whole bars, which needs a bar length: `barMs = 60000 ·
barBeats / tempoBpm`. The codebase carries meter in exactly one place — a **song-level**
`timeSig: { beats, unit }` on the roadmap-spec (`lib/roadmap-spec.ts:21`); converter /
calibration charts carry **no meter at all**. So the honest v1 policy:

- **`barBeats` source, in order:** the song's `timeSig.beats` if it has a roadmap-spec; else
  **default 4** (4/4), surfaced to the MD as an assumption.
- **Constant meter is v1 scope.** The spec models one `timeSig` per song, so the clock treats
  `barBeats` as constant. **Mid-song meter changes, pickups, and partial bars are out of
  auto-scope** — the data doesn't carry them per-bar. They are not silently wrong: the
  whole-bar quantised motion re-zeroes at every section head (§1), so a meter shift at a
  section boundary is re-trued by the MD's align tap, and any within-section drift trips the
  §7-4 bound → drop-rung. A future per-bar meter field would lift this; not v1.
- **No meter + no `song.bpm`** ⇒ there is nothing to reckon from ⇒ `manual` rung (= 5a). The
  clock never invents a tempo or a meter.

### 5.6 Three things my own sweep caught that the Codex rounds did not

**(i) A manual nav action during clock-on is an implicit re-anchor.** Covered as a §5.3
bullet; restated here as a first-class rule because it is the seam between the two authorities.
The clock and the MD can both move the playhead; if they move it independently the loop's
reckoning desyncs from the cursor. Resolution: the MD always wins and *becomes* the anchor —
any manual `advance`/`redirect` while the clock runs is a trust re-anchor (`barsSinceAnchor =
0`, `alignedAtMs = now`) that also re-zeroes the motion axis (`motionBaselineAtMs = now`,
`barsAtMotionBaseline = 0`). There is no race because there is no contest: a human gesture is
definitionally the new truth ("MD owns place").

**(ii) The closed-form bar count is invalid under varying tempo — re-baseline the MOTION axis
on tempo change.** `floor((now − baseline) / barMs)` with a single `barMs` assumes the tempo
has been **constant since that baseline**. But on the `live` rung `tempoBpm` tracks the band
and updates mid-span. If the band goes 120→140 and we recompute total-bars with the *new*
tempo, we retroactively mis-count the bars already played at 120 — the playhead jumps. So the
driver must integrate piecewise, not recompute globally. The simplest correct form (no
per-tick integral to persist): **on every accepted tempo change, re-baseline the motion axis**
— set `motionBaselineAtMs = now`, `baselineTempoBpm = newTempo`, and **capture
`barsAtMotionBaseline = barsSinceAnchor`** (the bars driven so far). Future bars then reckon
from `now` at the new tempo via `expected = barsAtMotionBaseline + floor((now −
motionBaselineAtMs) / barMs)` (§5.3); past bars keep their true duration.

**The R4 HIGH-1 trap I first walked into (and Codex caught):** v0.6.0 wrote "set `anchorAtMs =
now` and carry `barsSinceAnchor` forward unchanged" while the §5.3 motion comparison read
`floor((now − anchorAtMs)/barMs)` against that same `barsSinceAnchor`. Re-baselining the
timestamp to `now` drops elapsed to ~0 while the driven count stayed at (say) 4 → the driver
idles ~5 fresh bars before the next advance. The cure is the **two-axis split** (§5.1): the
gate's trust counter (`barsSinceAnchor`, resets only on MD gesture) and the motion pacer
(`motionBaselineAtMs`/`barsAtMotionBaseline`, re-baselines on tempo change too) can no longer
share a zero. A tempo change is a *speed* re-baseline, **not** a trust re-anchor — it does
**not** reset `barsSinceAnchor` or `alignedAtMs` (the band speeding up is not the MD asserting
position). This keeps §5.1's "only an MD gesture resets trust" intact while making the
integrator correct under live tempo.

**(iii) Smooth motion is MD-local; followers move at broadcast (bar) granularity — scope,
not bug.** The MD's rAF loop animates a smooth redline locally. Followers do **not** run the
loop (single-writer); they receive `current` each time the MD broadcasts an advance, so on a
follower the redline **steps bar-to-bar as broadcasts arrive**, it does not glide. At the
bar granularity ShowRunr lights (we redline *bars*), that is the right v1 scope — and it is
exactly the epic's per-device-floor model. Sub-bar follower interpolation (a follower-side
coast off the broadcast `tempoBpm` + `rung`) is a deliberate **post-v1** option, called out
here so no one mistakes the per-bar follower step for a defect. The broadcast clock carries
`tempoBpm`/`rung` precisely so that interpolation *can* be added later without a wire change.

---

## 6. The on-switch: live source-quality validation (§5.1 precondition)

Audio-tempo is **designed-in now, turned on only after live source-quality validation** —
this pass keeps that gate explicit rather than letting a half-trustworthy clock ship:

- The **stated-BPM click and manual advance are always available** — they need no audio
  and carry no detection risk, so they ship unconditionally (§3, §4). *These are the only
  things that drive the redline before validation.*
- The **`live` audio-track rung is shadow-only until it validates (MEDIUM-1 fix).** v0.3
  said pre-validation audio could "still flow the redline" — that is wrong: an unvalidated
  detector that *moves the playhead* shows the MD and followers the **wrong place**, which
  violates "degrade precision, never honesty." So before validation the detector runs in
  **shadow mode**: it ingests, the MD logs detected-vs-actual tempo + confidence over real
  sets, but it **drives nothing** — the redline stays on `static-bpm` (click) / `coasting`
  / `manual`. Audio motion is *never* the live default until it clears the bar.
- A **validation mode** (not a production feature) is exactly this shadow run with the
  comparison logged; the audio rung promotes to *driving motion AND auto-fire* together,
  only once it clears a bar (sustained HIGH confidence, error < a beat fraction) for that
  MD's source.
- So MD-mic (A) ships immediately — **click + manual motion now; audio shadow-validates
  now; audio drives the redline (motion, then auto-fire) only after the MD's source proves
  out in the field.** No half-trusted clock ever moves the playhead.

---

## 7. Decisions (S-current dialogue with Graham)

1. **Placement (Q1) — RESOLVED.** Ship **(A) MD-mic v1**; the seam stays placement-agnostic
   so **(B) listener-node is possible with no architecture change**, but its specifics are a
   **UAT question, deferred**. Clock engages only in MD-led mode (self-serve self-drives).
2. **Auto-advance (Q2) — RESOLVED.** The clock **auto-advances the playhead continuously
   (bar to bar at tracked tempo) — that motion IS the feature.** Audio = speed; the MD's
   **align/true-up tap = position** (seeds the start when there's no count-in, corrects
   drift, re-zeros at sections). My earlier "display-only / conservative" framing was wrong
   and is dropped. Only the auto-*fire* of armed structural changes is confidence-gated
   (§5), never the motion. *(Whether the align tap may move the playhead **backward** when
   the clock has over-run is the one open fork — §5.4 / Decision 5.)*
3. **Static-BPM + tap-tempo (Q3) — RESOLVED.** **Add a `bpm` field to the song (DB
   migration)** as the fallback rung; it doubles as a **click/metronome** the MD runs off
   the stated tempo to guide the band, with the same section true-up. **Tap-tempo is IN**
   (overrides D2's deferral): the MD taps a few beats to set/adjust the click tempo live —
   a manual feeder for the static-BPM rung and an on-the-fly tempo align.
4. **Tuning knobs (§5) — RESOLVED: defer-with-default** (ship as named, surfaced constants,
   tune in UAT). Both fail safe (drop to click/manual rather than be confidently wrong):
   - **`coasting` timeout *T* ≈ 2 bars (a few seconds):** how long the clock glides at
     last-good tempo on a lost signal before dropping a rung. Long enough to ride a
     momentary dropout, short enough to catch a real stop within a phrase.
   - **bars-since-anchor bound ≈ 8 bars (one phrase):** how far past an MD align tap the
     clock will auto-*fire* a structural change before it refuses without a fresh tap. In
     normal play this gates only the commit, *not* motion — but it is **also** the
     sleep/stall ceiling (§5.3): if no anchor has refreshed within the bound (e.g. a
     backgrounded tab), the clock drops a rung rather than fast-forward a stale tempo. The
     MD-true-up-every-section model keeps changes comfortably inside this window.

5. **Backward correction on over-run (§5.4) — OPEN, flagged for Graham; reframed by R4.** A
   dead-reckoned clock can run *ahead* of the band; 5a's `advance` is forward-only. The R4
   buildability check changed the shape of this fork: **(β)** never move backward, clock-ahead
   degrades to `manual` — *the v1-buildable option (now recommended)*, zero new reducer
   surface; **(α)** section-head re-zeros re-seat the playhead backward — **requires a net-new
   `seek` directive** (the shipped `redirect` doesn't move `current`, `conductor-state.ts:221`),
   so it is its **own future chunk**, not a v1 detail. The α armed-marker rule (re-seat keeps
   the marker but **recomputes** `armedFireAtEligible`, reachable → pending/fires, stranded →
   false + "re-arm needed") is recorded in §5.4 *for that future `seek` chunk*. **The v1 build
   is unblocked under β regardless of Graham's eventual α decision.**

**Still open:** (a) the **backward-correction fork** (Decision 5 / §5.4) — Graham's pick, **β
recommended for v1** (α = a deferred `seek` chunk); does NOT block the v1 build either way;
(b) listener-node placement specifics — a **UAT** question (does MD-mic source quality
suffice, or is a clean-source node warranted), blocks nothing. Everything else is locked.

---

## 8. Build outline sketch (after OQ-1 sign-off — NOT building)

Mirrors epic §9 item 5; gated commits, Codex per chunk.

0. **`song.bpm` migration + click + tap-tempo (§3):** add the stated-tempo field (Neon-safe:
   comment-free bundle, no advisory locks); read door + edit in the song/chart model; a
   click/metronome off the stated tempo (driven at `barBeats` from §5.5 — `timeSig.beats`
   if present, else 4); **tap-tempo** to set/adjust it live. Unblocks the static-BPM rung.
   Smallest first chunk; ships standalone value (the click) before any audio work.
1. **MD align/true-up tap + re-anchor (§1 / §5.4):** the position primitive — an MD gesture
   that seeds the start downbeat and re-zeros the clock onto an anchor bar (writes the full
   `anchor {barId, pass}`, resets the trust axis `barsSinceAnchor = 0` / `alignedAtMs = now`
   and the motion axis `motionBaselineAtMs = now` / `barsAtMotionBaseline = 0`, §5.1).
   **Forward-only under β (the v1 build).** A free-span align tap is a forward true-up; an MD
   nav mid-clock is an implicit re-anchor (§5.6-i). Backward re-seat is NOT in this chunk — it
   needs the deferred `seek` directive (§5.4 R4 HIGH-2). This is the load-bearing half of
   "clock owns speed, MD owns place"; it stands alone atop the click even before audio.
   **Tests:** forward true-up; free-span tap stays forward; manual nav re-anchors both axes;
   align cancels pending motion; clock-overrun degrades to `manual` (β). *(The backward-re-seat
   + armed-marker-recompute tests move to the future `seek` chunk, §5.4.)*
2. **`ConductorClock` + ladder reducer + motion shell (pure where possible, tested):** the
   §4.1 state machine as a pure function of `(telemetry, nowMs, ClockReckoning)` → the §5.1
   `ConductorClock`; receipt-based reckoning + freshness (`ageMsAtSend`, §3); `barBeats` from
   §5.5; **trust re-anchor on MD gesture only** (phase-only re-zero at a predicted head — §5.1
   R3 HIGH-1); **motion-axis re-baseline on tempo change** (§5.1/§5.6-ii — distinct from the
   trust axis, R4 HIGH-1); re-acquire rung on recovery (§4.3).
   **The motion shell (§5.3):** the single rAF/timer driver, **≤1 advance per tick through
   the rising-edge chain**, whole-bar quantisation, ≥2-bars-owed ⇒ stall ⇒ drop-rung
   (never replay). **Tests:** each rung transition; stale→coast→static→manual with NO
   duplicate/stalled advance at a boundary; motion-on-static-bpm; recovery-at-anchor;
   receipt-based reckoning (no foreign-clock subtraction); **repeated-bar anchor: counter
   stays correct across a repeat/D.S./volta** (the R2 HIGH); **multi-bar tick: fireAt in the
   middle fires exactly once, never skipped/over-run**; **non-4/4 + missing-meter `barBeats`
   fallback**; **tempo change mid-span re-baselines without a playhead jump AND without a stall** — the next
   advance still lands on time, NOT ~N bars late (the R4 HIGH-1 trust/motion-axis split, §5.1);
   **a manual nav action mid-clock re-seats the anchor** (§5.6-i); **tab-sleep / long gap →
   drop rung, never fast-forward missed bars**.
3. **`clockConfidenceOk` in the driver + bounded `fireAtEligible` (tested):** `shouldAutoFire`
   stays **verbatim 5a, frozen** (R3 HIGH-2); the confidence gate is the driver's
   `clockConfidenceOk(reckoning, rung)` consulted only for **clock-driven** advances (§5.2);
   `fireAtEligible` → bounded VM walk, recomputed after a re-seat (§5.4). **Tests: a MANUAL
   advance onto `fireAt` fires even while coasting / far-past-anchor / clock off** (the 5a
   floor, R3 HIGH-2); clock-driven within-bound+HIGH fires; clock-driven low-conf /
   far-past-anchor refuses but **motion continues**; static-bpm clock-fires only just after an
   MD gesture; **a `fireAt` stranded behind the cursor (post backward re-seat) → eligibility
   recomputed false, refused, "re-arm needed"** (§5.4); 5a rising-edge parity under a
   clock-CREATED arrival; 5a manual path unchanged when clock absent.
4. **Telemetry ingest + MD re-emit + detector + validation/shadow mode (§6):** listener
   `TempoTelemetry` → MD validate → `clock` dispatch under `(epoch, seq)` (in-process for
   MD-mic). The detector ships **shadow-only** (drives nothing, logs detected-vs-actual);
   the validation harness promotes the audio rung to *driving motion AND auto-fire* only
   after it clears the bar (§6). **Tests:** shadow mode never moves the playhead;
   promotion gate; cross-device `ageMsAtSend` recovers detection age without offset sync;
   **stale/reordered node telemetry dropped via the listener `seq` latest-wins contract**
   (§2.3). (Node placement depends on epic chunk-3 transport; MD-mic needs no wire.)
- *Deferred (post-v1):* listener-node placement (UAT-informed — §2.2); cross-device offset
  handshake (an optimisation of an already-invisible transit term — §3).

---

## 9. What 5b is NOT

- **Not a positioner.** The clock never decides *place*; `advance` + anchors do (§1).
- **Not a second writer.** The listener is telemetry; only the MD writes `clock` (§1).
- **Not a new wire type.** The `ConductorState` envelope and the `shouldAutoFire(session)`
  *signature/body* are frozen; 5b is **additive** — it grows the existing broadcast `clock`
  sub-object with three render fields (`rung`/`tempoBpm`/`confidence`, §5.1a). The reckoning
  state + the confidence gate are **MD-local**, off the wire (§5.1b / §5.2). No new top-level
  message type, no new function signature.
- **Not auto-jump.** Structural changes stay MD-armed (5a). The clock feeds motion only.
- **Not on-by-default.** Both placements sit behind §6 validation; the floor is 5a manual
  advance, which is shipped and correct.
