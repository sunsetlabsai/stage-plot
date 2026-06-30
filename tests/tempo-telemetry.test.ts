import { describe, it, expect } from 'vitest';
import {
  HIGH_CONFIDENCE,
  TEMPO_DEADBAND_BPM,
  type TempoTelemetry,
  initTelemetryState,
  ingestTelemetry,
  telemetryAgeMs,
  lastGoodAgeMs,
} from '../lib/tempo-telemetry';

// A telemetry packet with sensible MD-mic defaults (ageMsAtSend ≈ 0, one incarnation).
function pkt(over: Partial<TempoTelemetry> = {}): TempoTelemetry {
  return {
    tempoBpm: 120,
    confidence: 0.9,
    ageMsAtSend: 0,
    listenerId: 'md-mic',
    telemetryEpoch: 1,
    seq: 1,
    ...over,
  };
}

describe('ingestTelemetry — latest-wins per incarnation', () => {
  it('drops a seq ≤ the accepted watermark (stale / dup)', () => {
    let s = initTelemetryState();
    s = ingestTelemetry(s, pkt({ seq: 5, tempoBpm: 120 }), 1000);
    const before = s;
    s = ingestTelemetry(s, pkt({ seq: 3, tempoBpm: 999 }), 1100); // stale
    expect(s).toBe(before); // returned by identity — nothing updated
    expect(s.lastTempoBpm).toBe(120);
  });
  it('accepts a higher seq in the same incarnation', () => {
    let s = initTelemetryState();
    s = ingestTelemetry(s, pkt({ seq: 5 }), 1000);
    s = ingestTelemetry(s, pkt({ seq: 6, tempoBpm: 121 }), 1100);
    expect(s.lastReceivedAtMs).toBe(1100);
  });
  it('a detector restart bumps the epoch ⇒ a low seq is NOT dropped', () => {
    let s = initTelemetryState();
    s = ingestTelemetry(s, pkt({ telemetryEpoch: 1, seq: 10 }), 1000);
    s = ingestTelemetry(s, pkt({ telemetryEpoch: 2, seq: 1, tempoBpm: 130, confidence: 0.9 }), 2000);
    expect(s.lastReceivedAtMs).toBe(2000); // accepted despite seq 1 < 10
  });
});

describe('ingestTelemetry — lastGood updates ONLY on HIGH confidence (R1 HIGH-1)', () => {
  it('a low-confidence stream refreshes lastReceived* but NOT lastGood*', () => {
    let s = initTelemetryState();
    // one HIGH estimate seeds lastGood at t=1000
    s = ingestTelemetry(s, pkt({ seq: 1, tempoBpm: 120, confidence: 0.9 }), 1000);
    expect(s.lastGoodTempoBpm).toBe(120);
    expect(s.lastGoodAtMs).toBe(1000);

    // then a stream of LOW-confidence packets (detector alive, but not trustworthy)
    s = ingestTelemetry(s, pkt({ seq: 2, tempoBpm: 121, confidence: 0.1 }), 2000);
    s = ingestTelemetry(s, pkt({ seq: 3, tempoBpm: 122, confidence: 0.1 }), 3000);

    expect(s.lastReceivedAtMs).toBe(3000); // detector alive — last-received advanced
    expect(s.lastGoodAtMs).toBe(1000); // but lastGood is FROZEN at the HIGH estimate
    expect(s.lastGoodTempoBpm).toBe(120);
    // so coasting (keyed on lastGoodAgeMs) keeps aging out, while telemetryAge stays small:
    expect(lastGoodAgeMs(s, 3000)).toBe(2000);
    expect(telemetryAgeMs(s, 3000)).toBe(0);
  });
  it('the HIGH threshold is the boundary', () => {
    let s = initTelemetryState();
    s = ingestTelemetry(s, pkt({ seq: 1, confidence: HIGH_CONFIDENCE }), 500);
    expect(s.lastGoodAtMs).toBe(500); // ≥ HIGH counts
  });
});

describe('telemetryAgeMs — READ-TIME age grows (R1 MEDIUM-1)', () => {
  it('a fixed stored age would never expire; read-time age grows with nowMs', () => {
    let s = initTelemetryState();
    s = ingestTelemetry(s, pkt({ ageMsAtSend: 0 }), 1000);
    expect(telemetryAgeMs(s, 1000)).toBe(0);
    expect(telemetryAgeMs(s, 3000)).toBe(2000); // grows — `live` can expire
  });
  it('carries the at-send age forward and adds elapsed', () => {
    let s = initTelemetryState();
    s = ingestTelemetry(s, pkt({ ageMsAtSend: 40 }), 1000);
    expect(telemetryAgeMs(s, 1500)).toBe(540); // 40 at send + 500 elapsed
  });
  it('null ages before any estimate', () => {
    const s = initTelemetryState();
    expect(telemetryAgeMs(s, 1000)).toBeNull();
    expect(lastGoodAgeMs(s, 1000)).toBeNull();
  });
});

describe('ingestTelemetry — smoothing + deadband (§3)', () => {
  it('a sub-deadband jitter does NOT change the accepted baseline tempo', () => {
    let s = initTelemetryState();
    s = ingestTelemetry(s, pkt({ seq: 1, tempoBpm: 120, confidence: 0.9 }), 1000);
    const base = s.lastTempoBpm;
    expect(base).toBe(120);
    // jitter within ±TEMPO_DEADBAND_BPM around 120 — median stays ~120, baseline holds.
    s = ingestTelemetry(s, pkt({ seq: 2, tempoBpm: 121, confidence: 0.9 }), 1500);
    s = ingestTelemetry(s, pkt({ seq: 3, tempoBpm: 119, confidence: 0.9 }), 2000);
    expect(s.lastTempoBpm).toBe(base); // unchanged — no churn
  });
  it('a real move beyond the deadband re-baselines the tempo', () => {
    let s = initTelemetryState();
    for (let i = 1; i <= 3; i++) {
      s = ingestTelemetry(s, pkt({ seq: i, tempoBpm: 120, confidence: 0.9 }), 1000 + i * 100);
    }
    expect(s.lastTempoBpm).toBe(120);
    // a sustained jump to 140 (well past the ±2 band) moves the median baseline.
    for (let i = 4; i <= 8; i++) {
      s = ingestTelemetry(s, pkt({ seq: i, tempoBpm: 140, confidence: 0.9 }), 1000 + i * 100);
    }
    expect(Math.abs((s.lastTempoBpm ?? 0) - 140)).toBeLessThanOrEqual(TEMPO_DEADBAND_BPM);
  });
});
