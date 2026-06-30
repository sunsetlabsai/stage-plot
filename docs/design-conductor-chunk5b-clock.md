# Conductor Authority — Chunk 5b: the clock layer + OQ-1 resolution (§5.1, §8.2-1)

**Status:** **v0.4 — DESIGN-ONLY, post-Codex-R1; all decisions locked except one flagged
fork.** Resolves epic open item **§8.2-1** (`docs/design-conductor-authority.md:207` —
*"Listener placement + clock latency"*), the single decision fence on chunk 5b. Builds on
chunk 5a (gated auto-fire on arrival, SHIPPED to prod `de8e414`) and the epic §5.1 clock
frame. **No code in this pass.** v0.3 closed the §7 dialogue with Graham (MD-mic v1 / node
UAT-deferred; clock auto-advances the playhead; add `song.bpm` + click + tap-tempo; tuning
knobs defer-with-default). **v0.4 folds Codex R1** (2 HIGH, 3 MEDIUM): the common thread was
that v0.3 nailed the *pure* layer (ladder reducer, the gate) but under-specified the
*imperative shell* and *the data the pure gate reads* — see the new **§5** (clock data shape
+ motion shell), which closes HIGH-2 / MEDIUM-2 / MEDIUM-3 together; plus a cross-device
clock-honesty fix (§3, HIGH-1) and a shadow-only-before-validation fix (§6, MEDIUM-1). One
genuine product fork — *can the redline move backward on a re-anchor* — is flagged for
Graham (§5.4). Ready to hand to Codex R2.

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
  tap** (same gesture as follow-me, confirming "we're here now," forward). The clock
  re-zeros at every section boundary + MD cue; a band hits boundaries constantly, so
  drift is bounded by design and the clock is never trusted past the next anchor. The two
  named failure points — **no count-in at start** and **drift over a span** — are both
  solved by the MD's align tap; the audio is a kick, the MD is the downbeat.
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
};
```

The MD validates, applies its own confidence policy (§5), and re-emits the authoritative
`ConductorState.clock` under `(epoch, seq)`. **If the listener IS the MD device (the v1,
§2.2), the whole path runs in-process — no wire hop, no relay, `ageMsAtSend` ≈ 0, and the
clock the estimate was taken against IS the clock the MD reckons against.** One code path,
two placements.

---

## 3. Q2 — Phase alignment across relay latency (confirm "invisible at bar granularity")

**Confirmed: invisible, with one cheap safeguard.** The arithmetic:

- Own-AP WebSocket relay latency is single-digit to low-tens of **milliseconds** (LAN, no
  backhaul — the epic's whole transport premise).
- A beat at 120 BPM = **500 ms**; a 4/4 bar = **2000 ms**. Even a pessimistic **50 ms** of
  transit is **10 %** of a beat / **2.5 %** of a bar. At the bar granularity the redline
  cares about (we light *bars*, not sub-beats), that is well under the threshold of
  visible error.
- The clock re-zeros at every section boundary + MD cue (§1), so transit error **cannot
  accumulate** — it is bounded to a single inter-anchor span and reset constantly.

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
  threshold; the section-boundary re-zero (§1) keeps it from accumulating.
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

When telemetry returns to HIGH, the clock climbs back to `live` at the **next anchor**
(section boundary or MD cue), not mid-span — recovery re-anchors rather than snapping the
playhead, same discipline as initial acquisition.

---

## 5. The clock data shape, the gate, and the motion shell

v0.3 specified the *pure* layer (the §4.1 ladder, the gate below) but hand-waved (a) the
exact `clock` fields the frozen `shouldAutoFire(session)` reads, (b) the imperative driver
that actually ticks the playhead forward, and (c) the position-correction primitive. Codex
R1 flagged all three (HIGH-2, MEDIUM-2, MEDIUM-3). They are one thing — *the shell around
the pure clock* — so this section nails all three.

### 5.1 The clock data shape (HIGH-2 — frozen signature ≠ frozen field set)

`shouldAutoFire(session)` cannot decide what it cannot read. The function **signature**
stays frozen (it takes a whole `session`); what 5b adds is **additive fields on the
`ConductorState.clock` sub-object** the session already carries — no *new* top-level wire
type, which is what §9 means by "not a new wire type." The gate reads exactly these, all
MD-authoritative, all re-emitted under `(epoch, seq)`:

```ts
// additive to the EXISTING ConductorState.clock — not a new type
type ConductorClock = {
  rung: 'live' | 'coasting' | 'static-bpm' | 'manual';  // §4.1 ladder
  tempoBpm: number;            // current reckoning tempo (last-good on coast, stated on static)
  phase: number;               // [0,1) into the current bar at the anchor instant
  confidence: number;          // [0,1] MD-validated; static-bpm/manual report a sentinel low
  anchorBarId: string;         // the bar the clock was last re-zeroed onto (§1)
  anchorAtMs: number;          // MD-clock instant of that re-zero (motion + bound both reckon from here)
  alignedAtMs: number | null;  // MD-clock instant of the last MD align tap (null ⇒ never trued)
};
```

`barsSinceAnchor` is **derived** (not stored): `(current.barId's ordinal) − (anchorBarId's
ordinal)` over the VM order — so it can't drift out of sync with `current`. The gate's
"recently trued" test reads `alignedAtMs`; its position-trust test reads the derived
`barsSinceAnchor` against the §7-4 bound.

### 5.2 The §3.5 confidence gate (what 5b ANDs onto the 5a gate)

5a's gate is **armed ∧ `current.barId === armed.fireAt` ∧ `holding == null`**, fired on the
rising edge (shipped). 5b ANDs, reading only §5.1 fields:

- **position is trustworthy** — derived `barsSinceAnchor ≤ bound` (§7-4); far from an
  anchor the change waits for an MD tap, AND
- **the rung's confidence is met** — on `live`, `clock.confidence ≥ HIGH`; on `static-bpm`,
  `alignedAtMs` within the bound *is* the warrant (the click has no audio confidence); on
  `coasting`/`manual`, the audio rung never auto-fires, AND
- the 5a guards unchanged (armed ∧ `current.barId === fireAt` ∧ `holding == null`).

Clock *motion* is **not** gated here — it runs on any non-manual rung (§4.2 / §5.3). This
gate restricts only the auto-*fire* of an armed structural change.

This is where **`armedFireAtEligible` becomes genuinely load-bearing** (epic/5a note):
under dead-reckoning the playhead may *not* land on `fireAt` exactly, so the arm-time
forward-reachability check stops a dead marker from arming. (5a's note that `fireAtEligible`
may be upgraded to a bounded VM walk *without signature change* lands here.)

### 5.3 The motion shell — who actually ticks the playhead (MEDIUM-2)

The §4.1 ladder reducer is **pure**; something imperative must drive `advance` off it. The
contract for that single driver (a hook-owned `requestAnimationFrame`/timer loop, one
instance, MD device only):

- **Single owner of forward motion.** Exactly one loop computes, each tick, how many *whole
  bars* have elapsed since `anchorAtMs` at `tempoBpm` (`floor((now − anchorAtMs) ×
  tempoBpm / barBeats) − barsAlreadyEmitted`) and calls `advance` that many times. `advance`
  stays the **only** `stepVM` caller (§1). Whole-bar quantisation means sub-bar phase never
  emits — no double-advance from rounding.
- **Wake from sleep / a long stall → re-anchor, never replay.** A backgrounded tab (screen
  lock, app switch) can leave a multi-second gap. The loop must **not** fast-forward the
  missed bars — a stale `tempoBpm` across an unknown gap is exactly the "confidently wrong"
  failure. Instead: if `now − anchorAtMs` exceeds the §7-4 bound (≈ one phrase), the clock
  **drops to `coasting` then `manual`** and waits for the MD's next align tap — the playhead
  freezes where it last legitimately was rather than lurching ahead. (This is the same
  bound that gates auto-fire, reused.)
- **A manual align tap cancels any pending motion and re-seeds.** The tap writes a new
  `anchorBarId`/`anchorAtMs`/`alignedAtMs`; the loop's next tick reckons from the *new*
  anchor with `barsAlreadyEmitted = 0`. No queued advance survives a re-anchor.
- **Manual rung = loop idle.** On `manual` the loop emits nothing; the floor is 5a, the
  MD's tap is the only motion.

### 5.4 Backward correction — the one genuine fork (MEDIUM-3, FLAGGED for Graham)

v0.3 called the align tap "forward only," but a dead-reckoned clock can over-run *ahead* of
the band — then truth is *behind* the playhead, and forward-only can't pull it back. 5a's
`advance` is forward-only (no backward `stepVM`), so this is a real design fork, not a
detail. Two honest options:

- **(α) Anchors may re-seat backward; free-span taps stay forward-only (RECOMMENDED
  default).** A **section-head re-zero** snaps the playhead *to that head* even if the clock
  had overrun past it — a **bounded** backward move (only ever to a structural anchor, never
  arbitrary), routed through the existing redirect/seek path (not `stepVM`), so the
  forward-only advance invariant is untouched. A **free-span** align tap (not at a head)
  stays a forward true-up only. This matches the MD's real gesture ("we're at the top of the
  chorus now") and bounds any backward motion to anchor granularity.
- **(β) No backward motion ever; clock-ahead degrades to manual.** If the clock runs ahead,
  the align tap can't correct it; the clock drops to `manual` and the MD re-places using
  existing structural controls (redirect). Simpler invariant, worse felt UX (the redline
  sticks ahead until the MD manually intervenes).

**I recommend (α)** — it keeps the redline honest with the cheapest gesture and bounds the
one backward move to a structural anchor. **Graham's call** before this chunk builds.

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

5. **Backward correction on over-run (§5.4) — OPEN, flagged for Graham.** A dead-reckoned
   clock can run *ahead* of the band; 5a's `advance` is forward-only. **(α)** section-head
   re-zeros may re-seat the playhead backward to the head (bounded, via redirect/seek, not
   `stepVM`), free-span taps stay forward-only — *recommended*; **(β)** never move backward,
   clock-ahead degrades to manual. Needs Graham's pick before chunk 1 builds.

**Still open:** (a) the **backward-correction fork** (Decision 5 / §5.4) — Graham's pick,
α recommended, blocks chunk 1; (b) listener-node placement specifics — a **UAT** question
(does MD-mic source quality suffice, or is a clean-source node warranted), blocks nothing.
Everything else is locked.

---

## 8. Build outline sketch (after OQ-1 sign-off — NOT building)

Mirrors epic §9 item 5; gated commits, Codex per chunk.

0. **`song.bpm` migration + click + tap-tempo (§3):** add the stated-tempo field (Neon-safe:
   comment-free bundle, no advisory locks); read door + edit in the song/chart model; a
   click/metronome off the stated tempo; **tap-tempo** to set/adjust it live. Unblocks the
   static-BPM rung. Smallest first chunk; ships standalone value (the click) before any
   audio work.
1. **MD align/true-up tap + re-anchor (§1 / §5.4):** the position primitive — an MD gesture
   that seeds the start downbeat and re-zeros the clock onto an anchor bar (writes
   `anchorBarId`/`anchorAtMs`/`alignedAtMs`, §5.1). **Blocked on Decision 5** (α/β): under α,
   a section-head re-zero re-seats backward via the existing redirect/seek path; free-span
   taps stay forward-only. This is the load-bearing half of "clock owns speed, MD owns
   place"; it stands alone atop the click even before audio. **Tests:** forward true-up;
   (α) backward re-seat to a head; free-span tap stays forward; align cancels pending motion.
2. **`ConductorClock` + ladder reducer (pure, tested):** the §4.1 state machine as a pure
   function of `(telemetry, nowMs, anchor)` → the §5.1 `ConductorClock`; continuous
   dead-reckoned advance on every non-manual rung; receipt-based reckoning + freshness
   (`ageMsAtSend`, §3); re-anchor on align tap / boundary; re-acquire on recovery (§4.3).
   **Plus the motion shell (§5.3):** the single rAF/timer driver, whole-bar quantisation,
   sleep/stall → drop-rung-not-replay, align cancels pending. **Tests:** each rung
   transition; stale→coast→static→manual with NO duplicate/stalled advance at a boundary;
   motion-on-static-bpm; recovery-at-anchor; receipt-based reckoning (no foreign-clock
   subtraction); reordered/stale telemetry via `(epoch, seq)`; **tab-sleep / long gap →
   drop rung, never fast-forward missed bars.**
3. **`shouldAutoFire` confidence-AND (pure, tested):** extend the gate (§5.2) behind the
   existing signature, reading the additive §5.1 `clock` fields; `fireAtEligible` → bounded
   VM walk. **Tests:** within-bound+HIGH fires; low-conf / far-past-anchor refuses;
   static-bpm fires only just after an align tap; **motion continues while bars-since-anchor
   disables auto-fire**; 5a rising-edge parity under a clock-CREATED arrival; 5a manual path
   unchanged when clock absent.
4. **Telemetry ingest + MD re-emit + detector + validation/shadow mode (§6):** listener
   `TempoTelemetry` → MD validate → `clock` dispatch under `(epoch, seq)` (in-process for
   MD-mic). The detector ships **shadow-only** (drives nothing, logs detected-vs-actual);
   the validation harness promotes the audio rung to *driving motion AND auto-fire* only
   after it clears the bar (§6). **Tests:** shadow mode never moves the playhead;
   promotion gate; cross-device `ageMsAtSend` recovers detection age without offset sync.
   (Node placement depends on epic chunk-3 transport; MD-mic needs no wire.)
- *Deferred (post-v1):* listener-node placement (UAT-informed — §2.2); cross-device offset
  handshake (an optimisation of an already-invisible transit term — §3).

---

## 9. What 5b is NOT

- **Not a positioner.** The clock never decides *place*; `advance` + anchors do (§1).
- **Not a second writer.** The listener is telemetry; only the MD writes `clock` (§1).
- **Not a new wire type.** The `ConductorState` envelope and the `shouldAutoFire(session)`
  *signature* are frozen; 5b is **additive** — it grows the existing `clock` sub-object with
  the §5.1 fields the gate reads (frozen signature ≠ frozen field set). No new top-level
  message type, no new function signature (epic §5.1 / 5a seam note).
- **Not auto-jump.** Structural changes stay MD-armed (5a). The clock feeds motion only.
- **Not on-by-default.** Both placements sit behind §6 validation; the floor is 5a manual
  advance, which is shipped and correct.
