# Conductor Authority — Chunk 5b: the clock layer + OQ-1 resolution (§5.1, §8.2-1)

**Status:** **v0.1 — DESIGN-ONLY, pre-Codex.** Resolves epic open item **§8.2-1**
(`docs/design-conductor-authority.md:207` — *"Listener placement + clock latency"*),
the single decision fence on chunk 5b. Builds on chunk 5a (gated auto-fire on arrival,
SHIPPED to prod `de8e414`) and the epic §5.1 clock frame. **No code in this pass.** On
sign-off: flip the epic §8.2-1 status to *resolved → this doc*, then Codex, then build.

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

- **Tempo ≠ position.** Beat-tracking yields *speed*, never *place*. So the clock is a
  **motion-smoother between anchors**, not a positioner. It dead-reckons the playhead
  forward at the detected tempo and **re-zeros at every section boundary + MD cue.** A
  band hits boundaries constantly, so drift is bounded by design — the clock is never
  trusted further than the next anchor.
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
seam (§1) is identical either way. So the design question is really *"which ships as the
default, and what is the contract between them?"*

### 2.1 The two placements

- **(A) MD-device mic — the zero-friction default.** The MD's phone listens to the room /
  its own monitor. Pros: no extra hardware, no extra setup, no extra relay traffic, no
  extra failure point; validates the whole dead-reckoning pipeline end-to-end with one
  device. Cons: the MD's phone is in a poor acoustic spot (stand, pocket), exposed to
  crowd/room noise and monitor bleed, and the MD is already busy tapping. **Source quality
  is marginal** — exactly the case §5.1 says to gate behind validation.
- **(B) Dedicated listener node — the "turn it on for real" path.** A second device taped
  near a **clean source** (DI split, a monitor send, the drummer's overhead). It sends
  telemetry to the MD over the same own-AP relay. Pros: clean source = the whole ballgame;
  detection quality jumps; frees the MD's device. Cons: extra device + setup, one more
  relay participant, one more thing that can drop (→ Q3).

### 2.2 Recommendation

**Support both behind one telemetry contract; ship (A) MD-mic as the v1 on-ramp, (B)
listener-node as a config option once a clean source exists.** Rationale: the architecture
makes them interchangeable, so building the telemetry seam *once* gets both. (A) lets us
validate dead-reckoning + the degrade ladder with no hardware ask; (B) is the quality
upgrade for venues with a clean feed. **Neither is on by default** — both sit behind the
§6 source-quality gate; the floor is always 5a manual advance.

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

- A dropped listener can only ever cost *auto-advance*, never togetherness: every device
  keeps its own offline redline (epic §5 per-device floor), and the MD can always advance
  manually (5a). The bottom rung **is** chunk-5a, which is shipped and correct.
- **Auto-advance runs only on `live`.** `coasting`/`static-bpm` are explicitly *display
  smoothers we don't bet a jump on*: they may animate the beat, but the §3.5 confidence
  gate (below) means auto-*fire* of an armed change requires `live` + HIGH confidence. The
  rungs below `live` degrade to "MD confirms the change with a tap" — i.e. 5a.
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

- **clock state `== live`** (rung 4.1), AND
- **confidence ≥ HIGH**, AND
- **bars/beats since last anchor ≤ a bound** (dead-reckoning is only trusted near an
  anchor; far from one, fall back to manual confirm), AND
- the 5a guards unchanged.

This is where **`armedFireAtEligible` becomes genuinely load-bearing** (epic/5a note):
under dead-reckoning the playhead may *not* land on `fireAt` exactly, so the arm-time
forward-reachability check stops a dead marker from arming. (5a's note that `fireAtEligible`
may be upgraded to a bounded VM walk *without signature change* lands here.)

---

## 6. The on-switch: live source-quality validation (§5.1 precondition)

Audio-tempo is **designed-in now, turned on only after live source-quality validation** —
this pass keeps that gate explicit rather than letting a half-trustworthy clock ship:

- A **validation mode** (not a production feature): run the detector against the real
  source at a real gig, log detected-vs-actual tempo + confidence over a set, and only
  promote a placement (A or B) to "auto-advance allowed" if it clears a bar (e.g.
  sustained HIGH confidence, error < a beat fraction). Until then the clock is **display
  only** — it can animate, but the §5 gate keeps auto-fire on the 5a manual floor.
- This makes (A) MD-mic shippable immediately as *display* (zero risk: it never moves a
  jump), and (B) listener-node the path that earns *auto-advance* once validated.

---

## 7. Open decisions for Graham (lock before Codex)

1. **Placement default (Q1):** agree **ship (A) MD-mic display-only first, (B) node behind
   validation** — or do you want to *start* with the node (clean source) and skip the
   marginal-mic rung entirely?
2. **Does the clock ever auto-*advance*, or is 5b "display-smoothing only" for v1?** The
   conservative cut: 5b ships the listener + ladder + display, but auto-advance stays
   behind validation indefinitely (auto-*fire* still requires `live`+HIGH). The aggressive
   cut: validated `live` may auto-advance the playhead. (Recommend conservative for v1.)
3. **Static-BPM source:** is a stated song BPM available in the chart/show model today, or
   does that rung need a BPM field added (and is tap-tempo wanted as a manual feeder, which
   D2 deferred)? Determines whether the `static-bpm` rung exists at v1 or is a no-op.
4. **`coasting` timeout *T* and the "bars-since-anchor" bound (§5):** pick now or defer to a
   build-time tunable with a sane default (recommend defer-with-default).

---

## 8. Build outline sketch (after OQ-1 sign-off — NOT building)

Mirrors epic §9 item 5; gated commits, Codex per chunk.

1. **`ClockState` + ladder reducer (pure, tested):** the 4.1 state machine as a pure
   function of `(telemetry, now, lastAnchor)` → `{rung, tempoBpm, phase}`; transit-time
   compensation (§3); re-anchor on boundary/cue; re-acquire on recovery (4.3). **Tests:**
   each rung transition; stale→coast; coast→static→manual; recovery-at-anchor; transit
   compensation math.
2. **`shouldAutoFire` confidence-AND (pure, tested):** extend the gate (§5) behind the
   existing signature; `fireAtEligible` → bounded VM walk. **Tests:** live+HIGH+near-anchor
   fires; low-conf / non-live / far-from-anchor refuses; 5a manual path unchanged when
   clock absent.
3. **Telemetry ingest + MD re-emit:** listener `TempoTelemetry` → MD validate → `clock`
   dispatch under `(epoch, seq)`; in-process path for MD-mic placement. (Depends on the
   epic chunk-3 transport for the node placement; MD-mic needs no wire.)
4. **Detector + validation mode (§6):** the actual beat-tracker (placement-agnostic) and
   the logging/validation harness that flips auto-advance on.

---

## 9. What 5b is NOT

- **Not a positioner.** The clock never decides *place*; `advance` + anchors do (§1).
- **Not a second writer.** The listener is telemetry; only the MD writes `clock` (§1).
- **Not a new wire type.** `clock` / `ConductorState` / `shouldAutoFire(session)` are all
  frozen; 5b is additive (epic §5.1 / 5a seam note).
- **Not auto-jump.** Structural changes stay MD-armed (5a). The clock feeds motion only.
- **Not on-by-default.** Both placements sit behind §6 validation; the floor is 5a manual
  advance, which is shipped and correct.
