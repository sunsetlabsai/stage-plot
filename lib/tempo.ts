// ── Conductor clock, chunk 5b chunk-0: the stated-tempo primitives ───────────
//
// Pure tempo math shared by the library BPM editor (set/audition a song's stated
// tempo) and — later — the clock's static-BPM rung. No IO, no React. Mirrors the
// design's §5.5 bar-duration formula EXACTLY (60000 ms, not 60 — the R3 off-by-1000)
// and the DB CHECK range in supabase/migrations/012_song_bpm.sql, so the client
// guard and the column constraint can never disagree.

// The musical range a stated tempo may hold. Kept in lockstep with the 012 CHECK.
export const MIN_BPM = 20;
export const MAX_BPM = 400;

// Default bar length when a chart carries no time signature (§5.5: timeSig.beats if a
// roadmap-spec is present, else assume 4/4). Callers with a spec pass its beats.
export const DEFAULT_BAR_BEATS = 4;

// A stated bpm is a whole number in the musical range. Non-integers, NaN, and
// out-of-range values are not valid tempos (the DB rejects them too).
export function isValidBpm(bpm: number): boolean {
  return Number.isInteger(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM;
}

// Snap any finite number into a valid whole-number bpm (round, then clamp). Used by
// tap-tempo and the +/- nudge so the editor can never hold an out-of-range value.
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return MIN_BPM;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

// Milliseconds per beat at a tempo. 60000 ms / bpm.
export function beatMs(bpm: number): number {
  return 60000 / bpm;
}

// Milliseconds per BAR — the unit the clock dead-reckons in (§5.3/§5.5):
// barMs = 60000 · barBeats / bpm. barBeats defaults to 4/4 when unstated.
export function barMs(bpm: number, barBeats: number = DEFAULT_BAR_BEATS): number {
  return (60000 * barBeats) / bpm;
}

// Tap-tempo: turn a series of tap instants (ms, in tap order) into a stated bpm.
// Uses the MEDIAN inter-tap interval (robust to one stray/late tap) → 60000/interval,
// rounded and clamped into range. Needs at least two taps; fewer ⇒ null (not enough
// to infer a tempo). Out-of-order or zero/negative intervals are dropped.
export function tapTempoToBpm(tapsMs: number[]): number | null {
  if (tapsMs.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < tapsMs.length; i++) {
    const d = tapsMs[i] - tapsMs[i - 1];
    if (d > 0) intervals.push(d);
  }
  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median =
    intervals.length % 2 === 0 ? (intervals[mid - 1] + intervals[mid]) / 2 : intervals[mid];
  return clampBpm(60000 / median);
}
