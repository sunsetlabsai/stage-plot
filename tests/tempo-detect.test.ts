import { describe, it, expect } from 'vitest';
import {
  HOP_MS,
  ENVELOPE_CAPACITY,
  ENVELOPE_SEC,
  spectralFlux,
  OnsetEnvelope,
  octaveFold,
  autocorrelateTempo,
  regridOntoHop,
} from '../lib/tempo-detect';

// Build a synthetic onset envelope: an impulse train at a known bpm over `seconds`,
// sampled at `hopMs`. impulses value 1, gaps 0 (the cleanest possible periodic signal).
function clickTrain(bpm: number, hopMs: number, seconds: number): number[] {
  const periodSamples = Math.round(60000 / bpm / hopMs);
  const n = Math.round((seconds * 1000) / hopMs);
  const env = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += periodSamples) env[i] = 1;
  return env;
}

// Deterministic pseudo-random in [0,1) (no Math.random — tests must be reproducible).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('spectralFlux (half-wave rectified positive difference)', () => {
  it('sums only rising bins, ignores decays', () => {
    // bin0 +1 (rise), bin1 −1 (decay, ignored), bin2 +1 (rise) ⇒ 2
    expect(spectralFlux([1, 1, 1], [2, 0, 2])).toBe(2);
  });
  it('is zero when nothing rises (flat or all-decay frame)', () => {
    expect(spectralFlux([5, 5, 5], [5, 5, 5])).toBe(0);
    expect(spectralFlux([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

describe('OnsetEnvelope ring buffer', () => {
  it('snapshots chronological order before and after wrap', () => {
    const env = new OnsetEnvelope(3);
    env.push(1);
    env.push(2);
    expect(env.snapshot()).toEqual([1, 2]);
    env.push(3);
    env.push(4); // overwrites the oldest (1)
    expect(env.length).toBe(3);
    expect(env.snapshot()).toEqual([2, 3, 4]); // oldest → newest
  });
  it('default capacity covers ENVELOPE_SEC at HOP_MS', () => {
    const env = new OnsetEnvelope();
    expect(env.capacity).toBe(ENVELOPE_CAPACITY);
    expect(env.capacity).toBeGreaterThanOrEqual((ENVELOPE_SEC * 1000) / HOP_MS);
  });
});

describe('octaveFold (toward the stated-tempo prior)', () => {
  it('folds half/double-time into the octave nearest prefer', () => {
    expect(octaveFold(60, 120)).toBe(120); // ×2
    expect(octaveFold(240, 120)).toBe(120); // ÷2
    expect(octaveFold(118, 120)).toBe(118); // already nearest — identity
  });
  it('keeps the result inside the band when possible', () => {
    // raw 300 (above BPM_MAX 200), prefer 90 ⇒ fold down to 150 then 75 — nearest to 90 is 75
    const folded = octaveFold(300, 90);
    expect(folded).toBeGreaterThanOrEqual(60);
    expect(folded).toBeLessThanOrEqual(200);
  });
});

describe('autocorrelateTempo', () => {
  it('recovers a clean click-train bpm within tolerance', () => {
    for (const bpm of [80, 100, 120, 150]) {
      const env = clickTrain(bpm, 10, ENVELOPE_SEC);
      const est = autocorrelateTempo(env, 10, { prefer: bpm });
      expect(Math.abs(est.bpmFolded - bpm)).toBeLessThanOrEqual(2);
    }
  });
  it('reports HIGH confidence on a clean periodic signal, ~0 on noise', () => {
    const clean = autocorrelateTempo(clickTrain(120, 10, ENVELOPE_SEC), 10, { prefer: 120 });
    expect(clean.confidence).toBeGreaterThan(0.5);

    const rnd = lcg(42);
    const noise = Array.from({ length: 600 }, () => rnd());
    const noisy = autocorrelateTempo(noise, 10, { prefer: 120 });
    expect(noisy.confidence).toBeLessThan(0.3);
  });
  it('octave-folds the raw estimate toward the prior', () => {
    // a 60-bpm train reads as period 60; with prefer 120 the folded tempo is 120.
    const env = clickTrain(60, 10, ENVELOPE_SEC);
    const est = autocorrelateTempo(env, 10, { prefer: 120 });
    expect(Math.abs(est.bpmFolded - 120)).toBeLessThanOrEqual(3);
  });
  it('returns zero confidence on a flat (onset-free) envelope', () => {
    const flat = new Array<number>(600).fill(0); // no energy after mean-subtract
    expect(autocorrelateTempo(flat, 10, { prefer: 120 }).confidence).toBe(0);
  });
});

describe('regridOntoHop (MEDIUM-2 — jittered polls recover the bpm)', () => {
  it('re-grids jittered frame stamps and still recovers the tempo', () => {
    const bpm = 120;
    const hopMs = 10;
    const periodMs = 60000 / bpm; // 500
    const lengthMs = ENVELOPE_SEC * 1000;
    const length = Math.round(lengthMs / hopMs);
    const rnd = lcg(7);
    const frames: { tMs: number; flux: number }[] = [];
    // ideal click instants every period, each wall-clock stamp jittered by ±hop/3.
    for (let tIdeal = 0; tIdeal < lengthMs; tIdeal += periodMs) {
      const jitter = (rnd() - 0.5) * (hopMs / 1.5);
      frames.push({ tMs: tIdeal + jitter, flux: 1 });
    }
    const grid = regridOntoHop(frames, hopMs, 0, length);
    const est = autocorrelateTempo(grid, hopMs, { prefer: bpm });
    expect(Math.abs(est.bpmFolded - bpm)).toBeLessThanOrEqual(3);
  });
  it('skipped slots zero-fill and doubled slots average', () => {
    // two frames into slot 1 (avg), nothing into slot 0/2 (zero-filled).
    const grid = regridOntoHop(
      [
        { tMs: 10, flux: 2 },
        { tMs: 11, flux: 4 },
      ],
      10,
      0,
      3,
    );
    expect(grid[0]).toBe(0); // skipped
    expect(grid[1]).toBe(3); // (2+4)/2 averaged
    expect(grid[2]).toBe(0); // skipped
  });
});
