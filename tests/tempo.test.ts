import { describe, it, expect } from 'vitest';
import {
  MIN_BPM,
  MAX_BPM,
  DEFAULT_BAR_BEATS,
  isValidBpm,
  clampBpm,
  beatMs,
  barMs,
  tapTempoToBpm,
} from '../lib/tempo';

describe('isValidBpm', () => {
  it('accepts whole numbers in range', () => {
    expect(isValidBpm(120)).toBe(true);
    expect(isValidBpm(MIN_BPM)).toBe(true);
    expect(isValidBpm(MAX_BPM)).toBe(true);
  });
  it('rejects out-of-range, non-integer, and NaN', () => {
    expect(isValidBpm(MIN_BPM - 1)).toBe(false);
    expect(isValidBpm(MAX_BPM + 1)).toBe(false);
    expect(isValidBpm(120.5)).toBe(false);
    expect(isValidBpm(NaN)).toBe(false);
  });
});

describe('clampBpm', () => {
  it('rounds then clamps into range', () => {
    expect(clampBpm(119.6)).toBe(120);
    expect(clampBpm(5)).toBe(MIN_BPM);
    expect(clampBpm(9999)).toBe(MAX_BPM);
  });
  it('falls back to MIN_BPM on non-finite input', () => {
    expect(clampBpm(NaN)).toBe(MIN_BPM);
    expect(clampBpm(Infinity)).toBe(MIN_BPM); // non-finite ⇒ safe MIN fallback, before any clamp
    expect(clampBpm(-Infinity)).toBe(MIN_BPM);
  });
});

describe('beatMs / barMs (§5.5 — 60000, not 60)', () => {
  it('120 bpm → 500 ms/beat, 2000 ms/4-4-bar', () => {
    expect(beatMs(120)).toBe(500);
    expect(barMs(120)).toBe(2000);
    expect(barMs(120, DEFAULT_BAR_BEATS)).toBe(2000);
  });
  it('honors a non-4/4 bar length', () => {
    expect(barMs(120, 3)).toBe(1500); // 3/4 at 120
    expect(barMs(90, 6)).toBe((60000 * 6) / 90);
  });
});

describe('tapTempoToBpm', () => {
  it('needs at least two taps', () => {
    expect(tapTempoToBpm([])).toBeNull();
    expect(tapTempoToBpm([1000])).toBeNull();
  });
  it('derives bpm from even 500ms taps → 120', () => {
    expect(tapTempoToBpm([0, 500, 1000, 1500])).toBe(120);
  });
  it('uses the median interval (robust to one stray late tap)', () => {
    // four ~500ms intervals and one huge stray; median stays ~500 → 120
    expect(tapTempoToBpm([0, 500, 1000, 1500, 5000])).toBe(120);
  });
  it('drops non-positive intervals and clamps the result', () => {
    expect(tapTempoToBpm([1000, 1000])).toBeNull(); // only a zero interval → dropped
    expect(tapTempoToBpm([0, 100])).toBe(MAX_BPM); // 600 bpm clamps to MAX
  });
});
