# Conductor 5b — chunk 4: the live audio-tempo rung (detector → telemetry → ladder)

**Status:** DESIGN, pre-Codex. Build-level spec for parent §8 **item 4** (`docs/design-conductor-chunk5b-clock.md:836`). Grounded against shipped code at main `5f58fd2` (chunks 0–3 merged). **Staged 4a (shadow, non-driving) → 4b (driving, after validation).** NOT building until Codex GO + Graham's explicit "build."

Parent decisions this inherits as LOCKED: placement = **(A) MD-mic v1** (§7-1); the audio rung is **shadow-only until it validates** (§6); confidence gates only the auto-*commit*, never motion (§5.2); MD-local, **no wire** (chunks 0–3 shipped no broadcast — the follower/relay transport is the separate conductor-authority epic, not built). Detector algorithm = **(a) zero-dep Web Audio spectral-flux → autocorrelation** (Graham's call, S-current).

---

## 0. What item 4 actually adds (the seams are already cut)

Chunks 0–3 built the whole MD-local clock *scaffold* with the audio rungs designed-in but unreachable:

- `ClockRung = 'live' | 'coasting' | 'static-bpm' | 'manual'` exists (`conductor-clock.ts:126`); `computeStaticRung` can only produce the bottom two (`:135`).
- `clockConfidenceOk` already has `case 'live': return false` / `case 'coasting': return false` (`:161`/`:163`) — **the literal 4b flip points** ("extends here in item 4").
- `rebaselineMotion(r, newBpm, now)` already exists (`:177`) and is the §5.6-ii tempo-change integrator. **A detected-tempo update is just a `newBpm` into it** — the same call the driver already makes when the stated `bpm` prop changes (`use-conductor-session.ts:377`).
- The motion driver `driveClockTick` paces off `cfgRef.current.bpm` (`use-conductor-session.ts:362`). 4b swaps that *one tempo source* to the detected tempo while on the live/coasting rung; everything downstream (owed math, ≤1-advance, stall, the rising-edge auto-fire chain) is unchanged.

So item 4 is **not** new clock machinery — it is (i) a tempo *detector* that did not exist, (ii) a telemetry channel into the existing reckoning, and (iii) reaching the two top rungs. The risk is concentrated in (i), which is why it ships behind glass first.

---

## 1. Scope & non-goals

**Three independent switches (make the model explicit up front):**
1. **`clockOn`** — does the clock drive the playhead *at all* (the shipped chunk-2 toggle, default off).
2. **mic-enabled** — is the detector *running* (the §2.2 `enable()` gesture). Independent of `clockOn`: the MD can shadow-observe detection while the clock paces off `static-bpm`, which is exactly how 4a's validation happens.
3. **`audioDriveEnabled`** — is detected tempo *allowed to drive* the ladder (the §6 validated opt-in, default off; the only switch that is new in **4b**). In 4a it is hard-false.

The floor (5a manual + `static-bpm` click) holds regardless of all three.

**In scope (v1, MD-mic):**
- A zero-dep in-browser tempo detector (mic → tempo + confidence), as a **pure DSP module** + a thin IO shell.
- A telemetry channel faithful to parent §2.3, specialised for the in-process MD-mic case.
- **4a:** detector runs **shadow-only** — ingests, displays detected-vs-stated, logs a comparison over a real set, **drives nothing**. Redline stays on `static-bpm`/`manual` exactly as shipped.
- **4b:** the `live`/`coasting` rungs become *reachable and driving*, behind a per-MD **audio-validated opt-in** (default off). Detected tempo feeds the motion pacer; `clockConfidenceOk` live = `confidence ≥ HIGH`.

**Out of scope (unchanged from parent):**
- **No wire / no broadcast.** Single-device MD-mic needs none; the `ConductorClock` broadcast sub-object + follower rendering is the transport epic. We surface `rung`/`tempoBpm`/`confidence` from the hook for **local** display only.
- **No dedicated listener node (B).** UAT-deferred; the telemetry contract stays node-shaped so B is a later no-architecture-change add.
- **No `downbeatPhase` detection.** The detector emits **tempo + confidence only**. Position/phase is the MD's align tap (parent §1: "MD owns place"). `downbeatPhase` stays an optional, defer-able telemetry field.
- **No backward `seek`.** β still holds (parent §5.4): clock-ahead degrades to `manual`.
- **No change to `shouldAutoFire`, the reducer, or the wire envelope.** Additive only.

---

## 2. The detector (approach a) — pure DSP + thin IO shell

Split into a **pure, unit-testable** core and a **thin IO** lifecycle shell, mirroring the chunk-0 `lib/tempo.ts` (pure) / `TapTempo.tsx` (IO) split.

### 2.1 Pure core — NEW `lib/tempo-detect.ts` (no DOM, no Web Audio, no React)

The detector reduces a stream of **onset-strength** samples to a tempo estimate. All of this is pure and tested with synthetic envelopes:

- **`spectralFlux(prevMag, mag) → number`** — onset strength of one analysis frame: `Σ_k max(0, mag[k] − prevMag[k])` over the magnitude spectrum (positive spectral difference; rising energy = onset). Half-wave rectified so decays don't register as onsets.
- **`OnsetEnvelope`** — a fixed-length ring buffer of flux samples at a constant hop (`HOP_MS`). Length covers `ENVELOPE_SEC` (≈ 6 s) so even a 60-BPM beat (1 s period) has several periods to correlate.
- **`autocorrelateTempo(env, hopMs, { bpmMin, bpmMax, prefer }) → { bpmRaw, bpmFolded, confidence }`** — the estimator:
  1. Mean-subtract + (optionally) normalise the envelope (so loudness doesn't scale confidence).
  2. Autocorrelate across integer lags `[lagMin, lagMax]` where `lag = round(60000 / bpm / hopMs)` for `bpm ∈ [bpmMax, bpmMin]`.
  3. Pick the dominant lag (peak picking with a small parabolic interpolation for sub-hop precision) → `periodMs = lag·hopMs` → `bpmRaw = 60000 / periodMs`.
  4. **Octave fold (§2.3 disambiguation):** autocorrelation also peaks at 2×/½× the true period. Fold `bpmRaw` by ×2/÷2 into the candidate nearest `prefer` (the song's stated `bpm` when present — a strong prior that kills the half/double-time ambiguity — else the centre of a default band ≈ 120). `bpmFolded` is the emitted tempo.
  5. **`confidence ∈ [0,1]`** = normalised peak prominence: peak autocorr value over the local mean (or over `autocorr[0]`), clamped. This is the detector's honest self-report — it is what gates `live` (§7).
- **`octaveFold(bpm, prefer, bpmMin, bpmMax) → number`** — pure helper, exported for its own tests (the trickiest correctness point).

All constants (`HOP_MS`, `ENVELOPE_SEC`, `BPM_MIN`, `BPM_MAX`, `HIGH_CONFIDENCE`, `COAST_TIMEOUT_MS`) are **named, surfaced exports** — defer-with-default, tuned in UAT (parent §7-4 pattern).

### 2.2 IO shell — NEW `lib/use-tempo-detector.ts` (the only DOM/Web-Audio surface)

A small hook owning the audio graph lifecycle. **Never holds clock state** — it only produces telemetry via a callback.

- **`enable()` (MUST be called from a user gesture — the chunk-0 iOS lesson):** `getUserMedia({ audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false } })` (raw signal — DSP wants the unprocessed mic), create/`resume()` an `AudioContext`, wire `MediaStreamSource → AnalyserNode` (`fftSize` ≈ 2048). Start a `setInterval(HOP_MS)` poll: each tick `getFloatFrequencyData` → `spectralFlux` → push to the `OnsetEnvelope`; every `ANALYSIS_PERIOD_MS` (≈ 500 ms) run `autocorrelateTempo` → emit `TempoTelemetry` (§3) through the callback.
- **`disable()` / unmount:** clear the interval, `disconnect()` the nodes, **`stream.getTracks().forEach(t => t.stop())`** (release the mic — the OS indicator goes off), `audioContext.close()`. Idempotent.
- **State surfaced:** `{ status: 'off' | 'requesting' | 'running' | 'denied' | 'error', lastError? }` for the UI.
- **Privacy (stated explicitly):** audio is processed **in-process and never leaves the device**; the stream is held only while detection is on and torn down on disable/unmount; enabling is an explicit, revocable MD action with a visible mic-active indicator.

**Why AnalyserNode-poll, not AudioWorklet (Decision §8-1).** Tempo needs an onset envelope at ~tens-of-ms resolution, not sample-accuracy. A polled AnalyserNode keeps the whole detector in two plain modules (no separate worklet bundle, no cross-thread message protocol, no AGENTS.md "read the framework first" worklet-loader surprises). AudioWorklet is the precision upgrade if UAT shows the poll jitter hurts — a swap behind the same `TempoTelemetry` boundary, no caller change.

---

## 3. The telemetry contract (faithful to parent §2.3)

```ts
// NEW in lib/conductor-clock.ts (or a small lib/tempo-telemetry.ts) — the listener→MD contract.
export type TempoTelemetry = {
  tempoBpm: number;          // detected, octave-folded (§2.1)
  confidence: number;        // [0,1] the detector's self-report (§2.1)
  ageMsAtSend: number;       // freshness in the LISTENER's OWN monotonic frame (≈ 0 for in-process MD-mic)
  listenerId: string;        // 'md-mic' for v1 (stable per device-role)
  telemetryEpoch: number;    // bumped on each detector (re)start — the incarnation (§2.3 restart watermark)
  seq: number;               // per-incarnation monotonic; latest-wins drop
  // downbeatPhase?: number;  // DEFERRED — detector emits tempo+confidence only (§1)
};
```

**MD-mic specialisation (parent §3 "MD-mic is in-process — one clock"):** the producer and consumer share the JS event loop, so `ageMsAtSend ≈ 0` and ordering is trivially monotonic. The full node-shaped fields are kept anyway so the deferred listener-node (B) is a no-contract-change add — `listenerId`/`telemetryEpoch`/`seq` cost nothing in-process and the **MD ingest stays latest-wins per `(listenerId, telemetryEpoch)`** exactly as specced (a detector restart bumps `telemetryEpoch` → resets the accepted-seq watermark, so a restarted stream isn't dropped forever).

**Ingest (pure, testable):** `ingestTelemetry(state, t, nowMs) → ClockTelemetryState` — keeps `lastAcceptedSeq` keyed by incarnation, the **last accepted** telemetry, and the **last-good tempo** (the most recent HIGH-confidence `tempoBpm`, frozen for coasting). Receipt is **now** (the MD's own clock); detection age = `ageMsAtSend + measuredTransit` (≈ `ageMsAtSend` in-process), never a foreign-clock subtraction (parent §3 HIGH-1).

**Tempo smoothing + deadband (MINE — a raw per-estimate tempo would wobble the redline).** The autocorrelation tempo jitters frame-to-frame (124, 125, 123…). If every estimate were treated as a tempo *change*, it would churn `rebaselineMotion` ~twice a second and the dead-reckoned playhead would micro-wobble. So `ingestTelemetry` **smooths** the accepted tempo (median or EMA over the last few estimates — the chunk-0 `tapTempoToBpm` already uses median for robustness) and applies a **deadband**: the smoothed tempo is only treated as a *new* `baselineTempoBpm` when it moves more than `TEMPO_DEADBAND_BPM` (≈ 2). Below that the existing baseline holds. This makes the 4b driver's `rebaselineMotion` fire on *real* tempo moves, not detector noise.

**⚑ Synchronous `telemetryRef` — the time-axis invariant (the exact R5/R6 class, carried forward).** The motion driver is a free-running `setInterval` macrotask; **every input it consumes must be written to a ref synchronously, never reached through a passive React state channel** (parent §5.3 / `feedback_think_dont_outsource` #5/#6: a due tick can fire in the commit→passive gap and read a stale value). The detector callback therefore writes the ingested `ClockTelemetryState` into a **`telemetryRef` synchronously** (same discipline as `driverRef`/`cfgRef`/`gateRef`); the tick reads `telemetryRef.current`. The React-state mirror (for the display readout) is a *separate*, lossy-OK channel. Naively storing telemetry only in `useState` and reading it in `driveClockTick` would re-introduce the stale-input race the parent spent R5–R6 closing — flagged here so the build doesn't walk back into it.

---

## 4. The rung resolution — `computeRung` extends `computeStaticRung`

4a leaves `computeStaticRung` as-is (the driver still calls it). 4b adds a superset that can reach the audio rungs, **gated on the validated opt-in** so it is a no-op until the MD trusts the source:

```ts
// 4b, in lib/conductor-clock.ts — pure. Reaches 'live'/'coasting' ONLY when audioDriveEnabled.
export function computeRung(args: {
  clockOn: boolean; bpm: number | null; stalled: boolean; done: boolean;
  audioDriveEnabled: boolean;        // the §6 validated opt-in (default false)
  telemetryAgeMs: number | null;     // null ⇒ no telemetry ever
  confidence: number;                // last accepted; 0 when none
  hasLastGoodTempo: boolean;
}): ClockRung {
  if (!args.clockOn || args.stalled || args.done) return 'manual';
  if (args.audioDriveEnabled && args.telemetryAgeMs !== null) {
    if (args.telemetryAgeMs <= LIVE_FRESH_MS && args.confidence >= HIGH_CONFIDENCE) return 'live';
    if (args.telemetryAgeMs <= COAST_TIMEOUT_MS && args.hasLastGoodTempo) return 'coasting';
  }
  if (args.bpm != null) return 'static-bpm';
  return 'manual';
}
```

The ladder falls straight out: fresh+HIGH ⇒ `live`; stale-but-within-coast with a last-good tempo ⇒ `coasting`; otherwise the existing `static-bpm`/`manual` floor (parent §4.1). **In 4a, `audioDriveEnabled` is hard-false** ⇒ `computeRung ≡ computeStaticRung`, so the driver is untouched by construction.

---

## 5. Chunk 4a — shadow (drives nothing)

Purely additive + observational. **No change to the driver, the reducer, `applyWithAutoFire`, `clockConfidenceOk`, or the rung the driver paces off.**

- `lib/tempo-detect.ts` (§2.1) + `lib/use-tempo-detector.ts` (§2.2) + `TempoTelemetry`/`ingestTelemetry` (§3).
- `use-conductor-session.ts`: ingest telemetry into a **shadow channel** (a ref holding the last accepted telemetry + last-good tempo). Surface `{ shadowTempoBpm, shadowConfidence, shadowAgeMs }` from the hook. **`rung` stays `computeStaticRung`** (driver unchanged).
- `ConductorCluster.tsx`: an **"Enable mic detection"** affordance (the user gesture) + a **shadow readout** — e.g. `stated 120 · detected 124 (shadow)` with the confidence — explicitly labelled non-driving. A `denied`/`error` status surfaces honestly.
- **Validation logging:** an in-memory rolling log of `{ tMs, detectedBpm, confidence, statedBpm }` the MD can eyeball over a real rehearsal (optionally copy/export). This *is* the §6 "validation mode" — a shadow run with the comparison recorded.

4a ships standalone value: the MD can see, at a real gig, whether the detector tracks their source — before any audio ever moves the playhead.

## 6. Chunk 4b — driving (after validation)

Flips the audio rungs on behind the **`audioDriveEnabled`** opt-in (default off, per-session like `clockOn`; the MD turns it on once 4a's shadow comparison has earned their trust — parent §6's "promotes once it clears the bar for that MD's source," human-judged in v1).

- **Rung — computed in TWO places, from the SAME synchronous refs.** The render-level `rung` (display) swaps `computeStaticRung` → `computeRung` (§4). But the **driver must compute its own effective rung *inside the tick*** from `telemetryRef.current` + `cfgRef`/`driverRef` — it currently hardcodes `rung: 'static-bpm'` at the auto-fire call (`use-conductor-session.ts:399`, with a comment asserting "rung is provably 'static-bpm' here"). In 4b that comment no longer holds: the tick resolves the effective rung (`computeRung` off the refs) and passes **that** to `applyWithAutoFire` (not a literal). Reading the rung off render-state inside the macrotask tick would be the stale-input race again — it must come from the refs.
- **Driver tempo source (`driveClockTick`):** the local `b` (today `cfgRef.current.bpm`, `:362`) becomes the **effective tempo**: `live ⇒ telemetryRef smoothed tempo`, `coasting ⇒ last-good tempo`, else `cfgRef.bpm`. The existing in-tick reconcile at `:373–381` is **reused verbatim** — a change of effective tempo vs `r.baselineTempoBpm` already routes through `rebaselineMotion` (§5.6-ii), so past bars keep their duration and `expected − barsSinceAnchor = 0` (no jump, no stall). The owed math, ≤1-advance/tick, ≥2-owed stall, and the rising-edge chain are **all unchanged** — only the `b` source and the passed rung move. (The deadband §3 keeps this reconcile from firing on detector noise.)
- **`clockConfidenceOk` live flip:** the gate's signature is `(r: ClockReckoning, rung: ClockRung)` — **`r` carries no confidence** (confidence lives in telemetry, not the reckoning), so encoding freshness+HIGH in the *rung* is **required, not merely chosen**: the rung is `live` only when the tick saw `confidence ≥ HIGH` + fresh, so `case 'live': return true` is sound *because the driver computed that rung at the same synchronous instant*. `coasting` stays `false` (motion yes, auto-commit no — parent §4.1). The `alignedAtMs != null` never-trued guard and the `barsSinceAnchor ≤ bound` guard stay exactly as shipped (both still gate `live`).
- **Drop ladder (parent §5.3):** telemetry going stale moves the rung `live → coasting → static-bpm/manual` via `computeRung`; the driver re-baselines onto the new tempo source at each step. The existing ≥2-owed stall (tab sleep) is orthogonal and still fires. A dropped detector can only ever cost *audio-driven motion*, never the floor: `static-bpm`/manual is always under it.

---

## 7. The confidence / validation discipline (parent §6 — honesty over precision)

- Motion is **never** gated by confidence; only the untrusted auto-*commit* is (parent §5.2). A noisy clock still flows the redline; it just declines to auto-fire and leaves the marker for the MD's tap.
- The `live` rung **drives nothing** until `audioDriveEnabled` (4a → 4b boundary). An unvalidated detector that moved the playhead would show the wrong place = the one thing we refuse (parent §6 MEDIUM-1).
- `static-bpm` and `manual` are **always available, audio-free, carry no detection risk** — they ship/stay unconditionally as the floor.

---

## 8. Decisions (defer-with-default; recommendation + Graham/Codex react)

1. **Detector node type — RECOMMEND AnalyserNode-poll v1** (§2.2), AudioWorklet as a behind-the-boundary precision upgrade if UAT jitter warrants.
2. **Tuning constants — defer-with-default, surfaced:** `HOP_MS` ≈ 23–43, `ENVELOPE_SEC` ≈ 6, `ANALYSIS_PERIOD_MS` ≈ 500, `BPM_MIN/MAX` ≈ 60/200, `LIVE_FRESH_MS` ≈ 1×–2× bar, `COAST_TIMEOUT_MS` ≈ 2 bars (parent D4-T), `HIGH_CONFIDENCE` ≈ TBD-in-UAT. All fail safe (drop a rung, never confidently wrong).
3. **Octave-fold prior — RECOMMEND: fold toward `song.bpm` when present, else a default-band centre.** The stated tempo is a free, strong half/double-time disambiguator.
4. **`downbeatPhase` — RECOMMEND deferred** (tempo+confidence only; MD align owns phase). Telemetry field reserved.
5. **Validation promotion — RECOMMEND manual MD opt-in** (`audioDriveEnabled`, earned by eyeballing the 4a shadow log), not an automated stats gate (premature; defer).
6. **`live` gate form — RECOMMEND** encoding freshness+HIGH in the *rung* so `clockConfidenceOk('live')` is a plain `true` (this is **forced** by the frozen `(r, rung)` signature — `r` has no confidence; §6).
7. **Tempo smoothing — RECOMMEND median/EMA + `TEMPO_DEADBAND_BPM` ≈ 2** (§3) so detector jitter doesn't churn `rebaselineMotion`. Defer-with-default constant.

**Open for Graham:** any of the above defaults; whether 4a's validation log needs export/persistence or in-memory-eyeball suffices; whether `audioDriveEnabled` persists per-session (like `clockOn`) or per-MD-per-source.

---

## 9. Build outline (gated chunks, Codex per chunk — NOT building)

**4a (shadow):**
- `lib/tempo-detect.ts` (pure: `spectralFlux`, `OnsetEnvelope`, `autocorrelateTempo`, `octaveFold`, constants) **+ tests** (synthetic click trains at known BPM → recovered within tolerance; octave-fold toward prior; flux half-wave rectification; confidence rises with a clean periodic signal, ~0 on noise).
- `TempoTelemetry` + `ingestTelemetry` (pure) **+ tests** (latest-wins per incarnation; restart bumps epoch → not dropped; last-good tempo tracks last HIGH; receipt-based age; **smoothing + `TEMPO_DEADBAND_BPM`: a sub-deadband jitter does NOT change the accepted baseline tempo**).
- `lib/use-tempo-detector.ts` (IO shell; gesture-gated enable, teardown releases mic). Thin; covered at the boundary + a denied/error-status test.
- `use-conductor-session.ts` shadow channel (the synchronous `telemetryRef` from §3, written by the detector callback) + surfaced shadow readouts; **assert the driver/rung are byte-unchanged** (rung still `computeStaticRung`; no playhead motion from telemetry even with a fresh HIGH stream).
- `ConductorCluster.tsx` enable affordance + shadow readout + validation log. Cluster test: shadow shows, drives nothing, denied state honest.

**4b (driving):**
- `computeRung` (§4) **+ tests** (each ladder transition; `audioDriveEnabled=false` ⇒ `computeRung ≡ computeStaticRung`; live needs fresh+HIGH; coasting needs last-good within timeout; drop to static/manual).
- `clockConfidenceOk` live flip **+ tests** (live arrival within bound + trued auto-fires; coasting never; `alignedAtMs===null` still refuses; past-bound still refuses).
- Driver tempo-source swap (effective `b` from `telemetryRef`) + **effective rung passed to `applyWithAutoFire`** (not hardcoded `'static-bpm'`) + `rebaselineMotion` on every accepted tempo/source change **+ fake-timer tests** (live tempo change re-baselines: next advance on time, no jump/no stall — the R4 class, reused; live→coasting freezes at last-good; coasting→static drops to stated; sub-deadband jitter does NOT re-baseline; a live arrival on `fireAt` auto-fires while a coasting one does NOT; ≥2-owed stall still independent; signal-loss → manual, no fast-forward; **telemetry read via ref, not stale render-state — a due tick after a telemetry update sees the new tempo**).
- `audioDriveEnabled` opt-in wiring (default off) + cluster control.

Report the test-count DELTA on each chunk PR (per the standing rule).

---

## 10. What chunk 4 is NOT

- **Not a positioner** — detector gives *speed*; the MD's align tap gives *place* (parent §1).
- **Not a second writer / not a wire change** — telemetry is MD-local input; no broadcast added (transport epic owns followers). `shouldAutoFire`, the reducer, and the envelope stay frozen.
- **Not on by default** — `audioDriveEnabled` defaults off; the floor is the shipped 5a manual advance + `static-bpm` click. No half-trusted clock ever moves the playhead.
- **Not auto-jump** — structural changes stay MD-armed; the clock feeds motion only, auto-commit stays confidence-gated.

---

## 11. Risks / honest unknowns

- **Detection quality is the real risk** — autocorrelation on a noisy stage mic (crowd, monitors, bleed) may be jittery or octave-confused. This is *exactly* why 4a ships shadow-first: we learn the real-source quality before any audio drives the playhead, and the floor never depends on it.
- **AnalyserNode poll jitter** under main-thread contention could smear the envelope hop. Mitigation: timestamp each frame by `AudioContext.currentTime` (not wall clock) for the envelope spacing; AudioWorklet is the upgrade path behind the same boundary.
- **Browser mic permission UX** varies (iOS Safari gesture + HTTPS; permission persistence). The IO shell surfaces `requesting/denied/error` honestly; the floor is unaffected when denied.
