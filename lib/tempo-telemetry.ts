// ── Conductor 5b, chunk 4a: the tempo-telemetry contract + ingest (PURE) ──────
//
// (design-conductor-chunk5b-c4-live.md §3.) The listener→MD contract, specialised for
// the in-process MD-mic case, plus the pure ingest that the conductor hook's
// synchronous telemetryRef holds. No DOM, no React, no timers — tested in
// tests/tempo-telemetry.test.ts. The node-shaped fields (listenerId / telemetryEpoch /
// seq) cost nothing in-process and keep the deferred listener-node (B) a no-contract-
// change add.

// Confidence at/above which an estimate is trusted enough to (4b) drive `live` AND to
// refresh the coast budget (§3 / §8-2). Defer-with-default, tuned in UAT. lastGood*
// updates ONLY on a HIGH estimate — that is what makes coasting expire (the R1 HIGH-1
// fix). Surfaced so the ingest and the 4b computeRung can never disagree on the bar.
export const HIGH_CONFIDENCE = 0.5;

// Smoothed tempo is treated as a NEW baseline only when it moves more than this (§3).
// Below it the existing baseline holds, so detector jitter (124,125,123…) does not churn
// the 4b rebaselineMotion / wobble the dead-reckoned redline. Defer-with-default ≈ 2.
export const TEMPO_DEADBAND_BPM = 2;

// Median window over recent accepted RAW tempos (§3 — the chunk-0 tapTempoToBpm already
// uses median for robustness to one stray estimate).
export const SMOOTHING_WINDOW = 5;

// The listener→MD telemetry packet (§2.3 / §3). For MD-mic the producer and consumer
// share the JS event loop ⇒ ageMsAtSend ≈ 0 and ordering is trivially monotonic; the
// full fields are kept anyway so a later listener node is a no-change add.
export interface TempoTelemetry {
  tempoBpm: number; // detected, octave-folded (tempo-detect §2.1)
  confidence: number; // [0,1] the detector's self-report
  ageMsAtSend: number; // freshness in the LISTENER's own monotonic frame (≈ 0 in-process)
  listenerId: string; // 'md-mic' for v1 (stable per device-role)
  telemetryEpoch: number; // bumped on each detector (re)start — the incarnation watermark
  seq: number; // per-incarnation monotonic; latest-wins drop
  // downbeatPhase?: number; // DEFERRED — detector emits tempo+confidence only (§1)
}

// The MD-local ingested state (§3). Stores RECEIVE INSTANTS, never a fixed age — ages are
// computed at READ time from nowMs (telemetryAgeMs / lastGoodAgeMs) so `live` can actually
// expire (the R1 MEDIUM-1 fix). lastGood* tracks the last HIGH-confidence estimate — the
// ONLY thing 4b coasting may ride (the R1 HIGH-1 fix).
export interface ClockTelemetryState {
  lastAcceptedSeqByIncarnation: Map<string, number>; // (listenerId|epoch) → seq watermark
  // the last ACCEPTED estimate (any confidence) — proves the detector is still alive:
  lastTempoBpm: number | null; // smoothed + deadbanded (§3)
  lastConfidence: number; // [0,1]
  lastReceivedAtMs: number | null; // MD-clock receipt of the last accepted estimate
  lastAgeMsAtReceipt: number; // ageMsAtSend(+transit) captured AT that receipt
  // the last HIGH-confidence estimate — the ONLY thing coasting may ride (R1 HIGH-1):
  lastGoodTempoBpm: number | null; // most recent tempo with confidence ≥ HIGH
  lastGoodAtMs: number | null; // MD-clock receipt of that HIGH estimate
  recentRawTempos: number[]; // recent accepted RAW tempos, for the median smoother (§3)
}

export function initTelemetryState(): ClockTelemetryState {
  return {
    lastAcceptedSeqByIncarnation: new Map(),
    lastTempoBpm: null,
    lastConfidence: 0,
    lastReceivedAtMs: null,
    lastAgeMsAtReceipt: 0,
    lastGoodTempoBpm: null,
    lastGoodAtMs: null,
    recentRawTempos: [],
  };
}

function incarnationKey(t: TempoTelemetry): string {
  return `${t.listenerId}|${t.telemetryEpoch}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Ingest one packet (§3). Latest-wins per incarnation: a seq ≤ the accepted watermark for
// its (listenerId|epoch) is DROPPED (state returned by identity — nothing updates, so a
// stale/dup packet can't refresh aliveness). A detector restart bumps telemetryEpoch ⇒ a
// fresh incarnation key ⇒ its seq is NOT dropped against the old stream. On accept: smooth
// (median over the recent window) + deadband (hold the prior baseline unless it moved >
// TEMPO_DEADBAND_BPM), and update lastGood* ONLY when confidence ≥ HIGH.
export function ingestTelemetry(
  state: ClockTelemetryState,
  t: TempoTelemetry,
  nowMs: number,
): ClockTelemetryState {
  const key = incarnationKey(t);
  const watermark = state.lastAcceptedSeqByIncarnation.get(key);
  if (watermark !== undefined && t.seq <= watermark) return state; // latest-wins drop

  const seqMap = new Map(state.lastAcceptedSeqByIncarnation);
  seqMap.set(key, t.seq);

  const recentRawTempos = [...state.recentRawTempos, t.tempoBpm].slice(-SMOOTHING_WINDOW);
  const smoothed = median(recentRawTempos);
  // Deadband: keep the prior baseline unless the smoothed tempo moved more than the band.
  const prior = state.lastTempoBpm;
  const accepted =
    prior !== null && Math.abs(smoothed - prior) <= TEMPO_DEADBAND_BPM ? prior : smoothed;

  const isHigh = t.confidence >= HIGH_CONFIDENCE;
  return {
    lastAcceptedSeqByIncarnation: seqMap,
    lastTempoBpm: accepted,
    lastConfidence: t.confidence,
    lastReceivedAtMs: nowMs,
    lastAgeMsAtReceipt: Math.max(0, t.ageMsAtSend),
    lastGoodTempoBpm: isHigh ? accepted : state.lastGoodTempoBpm,
    lastGoodAtMs: isHigh ? nowMs : state.lastGoodAtMs,
    recentRawTempos,
  };
}

// Read-time freshness of the last accepted estimate (§3). null ⇒ none ever received. The
// stored age GROWS with nowMs (a fixed stored age would never expire — the R1 MEDIUM-1
// trap). Computed in the tick AND render off telemetryRef, never stored.
export function telemetryAgeMs(state: ClockTelemetryState, nowMs: number): number | null {
  if (state.lastReceivedAtMs === null) return null;
  return state.lastAgeMsAtReceipt + (nowMs - state.lastReceivedAtMs);
}

// Read-time age of the last HIGH-confidence estimate (§3) — what 4b coasting keys on, so a
// stream of low-confidence telemetry can't hold coasting open on a stale good tempo
// (R1 HIGH-1). null ⇒ no HIGH estimate ever.
export function lastGoodAgeMs(state: ClockTelemetryState, nowMs: number): number | null {
  if (state.lastGoodAtMs === null) return null;
  return nowMs - state.lastGoodAtMs;
}
