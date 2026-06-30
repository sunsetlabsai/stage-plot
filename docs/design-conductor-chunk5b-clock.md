# Conductor Authority — Chunk 5b: the clock layer + OQ-1 resolution (§5.1, §8.2-1)

**Status:** **v0.3 — DESIGN-ONLY, pre-Codex; all decisions locked.** Resolves epic open
item **§8.2-1** (`docs/design-conductor-authority.md:207` — *"Listener placement + clock
latency"*), the single decision fence on chunk 5b. Builds on chunk 5a (gated auto-fire on
arrival, SHIPPED to prod `de8e414`) and the epic §5.1 clock frame. **No code in this
pass.** v0.3 closes the §7 dialogue with Graham: MD-mic v1 / node UAT-deferred; clock
auto-advances the playhead (motion is the feature, MD align tap owns position); add
`song.bpm` + click + **tap-tempo**; tuning knobs defer-with-default (T ≈ 2 bars, bound ≈ 8
bars). Only node-placement specifics remain (UAT). Ready to flip the epic §8.2-1 status to
*resolved → this doc* and hand to Codex.

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
  downbeatPhase: number;     // [0,1) fraction into the current beat at sentAtMs
  confidence: number;        // [0,1], the detector's own self-report
  sentAtMs: number;          // listener's monotonic clock at emission (for Q2 transit math)
};
```

The MD validates, applies its own confidence policy (§5), and re-emits the authoritative
`ConductorState.clock` under `(epoch, seq)`. **If the listener IS the MD device, the same
path runs in-process — no wire hop, `sentAtMs` ≈ now.** One code path, two placements.

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

**The cheap safeguard — timestamp, don't trust receipt.** The listener stamps `sentAtMs`;
the MD dead-reckons phase from *emission* time, not *arrival* time (`elapsed = nowMs −
sentAtMs`, advance phase by `elapsed × tempo`). This makes transit latency *exactly*
compensable and removes even the 2.5 % without any clock-sync protocol. For the MD-mic
placement (A) this term is ~0. **No per-beat phase-correction protocol is needed.**

So Q2 resolves to: **latency is a non-issue for correctness at bar granularity; carry
`sentAtMs` so it's compensated rather than merely small.**

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
  `manual` is the only rung with no clock motion. What the §3.5 gate (§5) restricts is the
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

## 5. The full §3.5 confidence gate (what 5b ANDs onto the 5a gate)

5a's `shouldAutoFire` gate is: **armed ∧ `current.barId === armed.fireAt` ∧ `holding ==
null`**, fired on the rising edge (shipped). 5b ANDs the estimated-position conditions on
top, *without changing the `shouldAutoFire(session)` signature* (the seam is already shaped
— chunk-4 Codex R5 note):

- **position is trustworthy** — within the **bars-since-anchor bound** of the last MD
  align tap / section re-zero (dead-reckoning is only trusted near an anchor; far from one,
  the change waits for an MD tap), AND
- **the rung's confidence is met** — on `live`, **confidence ≥ HIGH**; on `static-bpm`,
  the MD's recent align tap *is* the position warrant (the click has no audio confidence),
  AND
- the 5a guards unchanged (armed ∧ `current.barId === fireAt` ∧ `holding == null`).

(Note: clock *motion* is NOT gated here — that runs on any non-manual rung, §4.2. This
gate is only the auto-*fire* of an armed structural change.)

This is where **`armedFireAtEligible` becomes genuinely load-bearing** (epic/5a note):
under dead-reckoning the playhead may *not* land on `fireAt` exactly, so the arm-time
forward-reachability check stops a dead marker from arming. (5a's note that `fireAtEligible`
may be upgraded to a bounded VM walk *without signature change* lands here.)

---

## 6. The on-switch: live source-quality validation (§5.1 precondition)

Audio-tempo is **designed-in now, turned on only after live source-quality validation** —
this pass keeps that gate explicit rather than letting a half-trustworthy clock ship:

- The **stated-BPM click and manual advance are always available** — they need no audio
  and carry no detection risk, so they ship unconditionally (§3, §4).
- The **`live` audio-track rung** is what the validation gate guards: a **validation mode**
  (not a production feature) runs the detector against the real source at a real gig, logs
  detected-vs-actual tempo + confidence over a set, and only promotes the audio rung to
  "trusted for auto-fire" once it clears a bar (sustained HIGH confidence, error < a beat
  fraction). Until then audio may still *flow* the redline (motion is cheap and re-trued by
  the MD), but the §5 gate keeps auto-*fire* of structural changes on the MD's tap.
- So MD-mic (A) ships immediately — click + manual now, audio motion now, audio auto-fire
  once the MD's source proves out in the field.

---

## 7. Decisions (S-current dialogue with Graham)

1. **Placement (Q1) — RESOLVED.** Ship **(A) MD-mic v1**; the seam stays placement-agnostic
   so **(B) listener-node is possible with no architecture change**, but its specifics are a
   **UAT question, deferred**. Clock engages only in MD-led mode (self-serve self-drives).
2. **Auto-advance (Q2) — RESOLVED.** The clock **auto-advances the playhead continuously
   (bar to bar at tracked tempo) — that motion IS the feature.** Audio = speed; the MD's
   **align/true-up tap = position** (seeds the start when there's no count-in, corrects
   drift, re-zeros at sections, forward only). My earlier "display-only / conservative"
   framing was wrong and is dropped. Only the auto-*fire* of armed structural changes is
   confidence-gated (§5), never the motion.
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
     clock will auto-*fire* a structural change before it refuses without a fresh tap.
     (Motion is never bounded — this gates only the commit.) The MD-true-up-every-section
     model keeps changes comfortably inside this window.

**Still open:** listener-node placement specifics — a **UAT** question (does MD-mic source
quality suffice, or is a clean-source node warranted). Everything else is locked.

---

## 8. Build outline sketch (after OQ-1 sign-off — NOT building)

Mirrors epic §9 item 5; gated commits, Codex per chunk.

0. **`song.bpm` migration + click + tap-tempo (§3):** add the stated-tempo field (Neon-safe:
   comment-free bundle, no advisory locks); read door + edit in the song/chart model; a
   click/metronome off the stated tempo; **tap-tempo** to set/adjust it live. Unblocks the
   static-BPM rung. Smallest first chunk; ships standalone value (the click) before any
   audio work.
1. **MD align/true-up tap + re-anchor (§1):** the position primitive — an MD gesture that
   seeds the start downbeat and re-zeros the clock at the current bar (forward, at section
   heads). This is the load-bearing half of "clock owns speed, MD owns place"; it stands
   alone atop the click even before audio.
2. **`ClockState` + ladder reducer (pure, tested):** the §4.1 state machine as a pure
   function of `(telemetry, now, lastAnchor)` → `{rung, tempoBpm, phase}`; continuous
   dead-reckoned advance on every non-manual rung; transit-time compensation (§3);
   re-anchor on align tap / boundary; re-acquire on recovery (§4.3). **Tests:** each rung
   transition; stale→coast→static→manual; motion-on-static-bpm; recovery-at-anchor;
   transit-compensation math.
3. **`shouldAutoFire` confidence-AND (pure, tested):** extend the gate (§5) behind the
   existing signature; `fireAtEligible` → bounded VM walk. **Tests:** within-bound+HIGH
   fires; low-conf / far-past-anchor refuses; static-bpm fires only just after an align
   tap; 5a manual path unchanged when clock absent.
4. **Telemetry ingest + MD re-emit + detector + validation mode (§6):** listener
   `TempoTelemetry` → MD validate → `clock` dispatch under `(epoch, seq)` (in-process for
   MD-mic); the actual beat-tracker; the logging/validation harness that promotes the
   audio rung to auto-fire-trusted. (Node placement depends on epic chunk-3 transport;
   MD-mic needs no wire.)
- *Deferred (post-v1):* listener-node placement (UAT-informed — §2.2).

---

## 9. What 5b is NOT

- **Not a positioner.** The clock never decides *place*; `advance` + anchors do (§1).
- **Not a second writer.** The listener is telemetry; only the MD writes `clock` (§1).
- **Not a new wire type.** `clock` / `ConductorState` / `shouldAutoFire(session)` are all
  frozen; 5b is additive (epic §5.1 / 5a seam note).
- **Not auto-jump.** Structural changes stay MD-armed (5a). The clock feeds motion only.
- **Not on-by-default.** Both placements sit behind §6 validation; the floor is 5a manual
  advance, which is shipped and correct.
