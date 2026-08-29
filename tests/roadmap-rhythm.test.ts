import { describe, it, expect } from 'vitest';
import { slashBeats } from '../lib/roadmap-rhythm';

// The shared beat→slash rule. Both render paths (PDF + preview) call this, so its
// contract is the anti-drift guarantee — pin it hard.
describe('slashBeats — the shared beat→slash rule', () => {
  const T = true;
  const F = false;

  it('an inherited/empty bar keeps the FULL rhythm', () => {
    expect(slashBeats(undefined, 4)).toEqual([T, T, T, T]);
    expect(slashBeats(null, 4)).toEqual([T, T, T, T]);
    expect(slashBeats([], 4)).toEqual([T, T, T, T]);
  });

  it('a struck whole-bar chord slashes every beat', () => {
    expect(slashBeats([{ beats: 4 }], 4)).toEqual([T, T, T, T]);
    expect(slashBeats([{}], 4)).toEqual([T, T, T, T]); // even division, one chord
  });

  it('a HELD whole-bar chord suppresses every slash (the ring)', () => {
    expect(slashBeats([{ beats: 4, held: true }], 4)).toEqual([F, F, F, F]);
    expect(slashBeats([{ held: true }], 4)).toEqual([F, F, F, F]);
  });

  it('suppresses only the beats UNDER a held chord in a split bar', () => {
    // struck | held
    expect(slashBeats([{ beats: 2 }, { beats: 2, held: true }], 4)).toEqual([T, T, F, F]);
    // held | struck
    expect(slashBeats([{ beats: 2, held: true }, { beats: 2 }], 4)).toEqual([F, F, T, T]);
  });

  it('handles a held chord in the MIDDLE of an even division', () => {
    // 3/4, three even chords, the middle one held
    expect(slashBeats([{}, { held: true }, {}], 3)).toEqual([T, F, T]);
  });

  it('handles even division with an explicit-beats-free held tail', () => {
    // no explicit beats anywhere → even 2+2, second held
    expect(slashBeats([{}, { held: true }], 4)).toEqual([T, T, F, F]);
  });

  it('handles uneven explicit spans (6/8-style 3+3)', () => {
    expect(slashBeats([{ beats: 3, held: true }, { beats: 3 }], 6)).toEqual([F, F, F, T, T, T]);
  });

  it('a struck split bar leaves every beat slashed', () => {
    expect(slashBeats([{ beats: 1 }, { beats: 1 }, { beats: 2 }], 4)).toEqual([T, T, T, T]);
  });

  it('returns an empty strip when beats is 0 (never NaN-indexes)', () => {
    expect(slashBeats([{ beats: 4, held: true }], 0)).toEqual([]);
    expect(slashBeats(undefined, 0)).toEqual([]);
  });

  it('always returns exactly `beats` slots', () => {
    for (const beats of [1, 2, 3, 4, 5, 6, 7, 8, 12]) {
      expect(slashBeats([{ beats, held: true }], beats)).toHaveLength(beats);
      expect(slashBeats(undefined, beats)).toHaveLength(beats);
    }
  });
});
