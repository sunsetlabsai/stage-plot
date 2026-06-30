// ── Conductor 5b, chunk 4a: the tempo detector's PURE DSP core ────────────────
//
// (design-conductor-chunk5b-c4-live.md §2.1.) No DOM, no Web Audio, no React —
// just the math that reduces a stream of onset-strength samples to a tempo +
// confidence. Mirrors the chunk-0 lib/tempo.ts (pure) / TapTempo.tsx (IO) split;
// the IO lifecycle lives in lib/use-tempo-detector.ts. Every constant is a named,
// surfaced export (defer-with-default, tuned in UAT — §8-2). Unit-tested against
// synthetic onset envelopes (tests/tempo-detect.test.ts).

// Analysis-frame hop: the constant spacing (ms) between onset-envelope samples.
// autocorrelateTempo is a FIXED-hop estimator — its lag→BPM math is only valid on
// an even grid, so the IO shell re-grids jittered polls onto this hop (§2.2 / the
// MEDIUM-2 re-grid; see regridOntoHop). Defer-with-default (§8-2 ≈ 23–43).
export const HOP_MS = 23;

// How many seconds of onset envelope the ring buffer holds. Long enough that even a
// 60-bpm beat (1 s period) has several periods to correlate (§2.1).
export const ENVELOPE_SEC = 6;

// How often (ms) the shell runs autocorrelateTempo over the envelope and emits an
// estimate. Coarser than HOP_MS — one estimate summarises many frames (§2.2).
export const ANALYSIS_PERIOD_MS = 500;

// The musical band the detector searches. Narrower than the stated-tempo range
// (lib/tempo.ts MIN/MAX) — a detector hunting 20–400 bpm invites octave noise; the
// octave fold (toward the stated prior) recovers half/double-time inside this band.
export const BPM_MIN = 60;
export const BPM_MAX = 200;

// AnalyserNode FFT size the shell requests (§2.2). Surfaced here so the magnitude
// bin count the core sees and the node config can never silently disagree.
export const FFT_SIZE = 2048;

// The octave-fold prior used when no stated song tempo is present (§2.1.4 / §8-3):
// the centre of the band, a weak but safe default.
export const DEFAULT_PREFER_BPM = 120;

// Ring-buffer capacity (samples) covering ENVELOPE_SEC at HOP_MS.
export const ENVELOPE_CAPACITY = Math.ceil((ENVELOPE_SEC * 1000) / HOP_MS);

// Onset strength of ONE analysis frame: Σ_k max(0, mag[k] − prevMag[k]) over the
// magnitude spectrum (positive spectral difference — rising energy = onset). The
// half-wave rectification (max(0, …)) is the whole point: a DECAY (mag dropping)
// must NOT register as an onset, else every note tail would look like a hit. Inputs
// are magnitude/dB arrays from getFloatFrequencyData; only their RISES matter.
export function spectralFlux(prevMag: ArrayLike<number>, mag: ArrayLike<number>): number {
  const n = Math.min(prevMag.length, mag.length);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const d = mag[k] - prevMag[k];
    if (d > 0) sum += d;
  }
  return sum;
}

// A fixed-length ring buffer of flux samples at a constant hop. push() overwrites the
// oldest once full; snapshot() returns the samples in CHRONOLOGICAL order (oldest →
// newest) so the autocorrelation sees a proper time series.
export class OnsetEnvelope {
  private readonly buf: Float64Array;
  private filled = 0;
  private head = 0; // index of the next write (= oldest sample once full)

  constructor(capacity: number = ENVELOPE_CAPACITY) {
    this.buf = new Float64Array(Math.max(1, capacity));
  }

  get capacity(): number {
    return this.buf.length;
  }

  get length(): number {
    return this.filled;
  }

  push(value: number): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }

  clear(): void {
    this.filled = 0;
    this.head = 0;
  }

  // Oldest → newest. Before the buffer fills, only the `filled` written samples.
  snapshot(): number[] {
    const out: number[] = new Array(this.filled);
    const start = this.filled < this.buf.length ? 0 : this.head; // oldest
    for (let i = 0; i < this.filled; i++) {
      out[i] = this.buf[(start + i) % this.buf.length];
    }
    return out;
  }
}

// Fold a raw tempo by ×2 / ÷2 into the octave nearest `prefer` (the song's stated
// bpm when present — a strong half/double-time disambiguator; §2.1.4). Autocorrelation
// also peaks at 2×/½× the true period, so the bare bpmRaw is octave-ambiguous; folding
// toward the prior resolves it. Distance is measured in LOG space (so 60↔120↔240 are
// symmetric octaves). Candidates are kept inside [bpmMin, bpmMax] when any are; pure +
// exported for its own tests (the trickiest correctness point).
export function octaveFold(
  bpm: number,
  prefer: number,
  bpmMin: number = BPM_MIN,
  bpmMax: number = BPM_MAX,
): number {
  if (!(bpm > 0) || !(prefer > 0)) return bpm;
  const candidates: number[] = [];
  for (let k = -3; k <= 3; k++) candidates.push(bpm * Math.pow(2, k));
  const inBand = candidates.filter((c) => c >= bpmMin && c <= bpmMax);
  const pool = inBand.length > 0 ? inBand : candidates;
  let best = pool[0];
  let bestDist = Infinity;
  for (const c of pool) {
    const d = Math.abs(Math.log2(c / prefer));
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

export interface TempoEstimate {
  bpmRaw: number; // pre-fold tempo straight off the dominant lag
  bpmFolded: number; // octave-folded toward `prefer` — the emitted tempo
  confidence: number; // [0,1] normalised peak prominence — the detector's self-report
}

// The estimator (§2.1): mean-subtract → autocorrelate across the lag band → pick the
// dominant lag (parabolic-interpolated for sub-hop precision) → period → bpmRaw →
// octave-fold → confidence. Confidence = dominant-lag autocorrelation over the zero-lag
// energy, clamped [0,1] — high for a clean periodic envelope, ~0 on noise. This is what
// gates `live` in 4b (§7); here it is purely reported. envHopMs lets tests drive a clean
// grid while the shell passes the real HOP_MS.
export function autocorrelateTempo(
  env: ArrayLike<number>,
  envHopMs: number,
  opts: { bpmMin?: number; bpmMax?: number; prefer?: number } = {},
): TempoEstimate {
  const bpmMin = opts.bpmMin ?? BPM_MIN;
  const bpmMax = opts.bpmMax ?? BPM_MAX;
  const prefer = opts.prefer ?? DEFAULT_PREFER_BPM;
  const N = env.length;
  const none: TempoEstimate = { bpmRaw: 0, bpmFolded: 0, confidence: 0 };
  if (N < 4) return none;

  let mean = 0;
  for (let i = 0; i < N; i++) mean += env[i];
  mean /= N;
  const x = new Float64Array(N);
  let energy = 0;
  for (let i = 0; i < N; i++) {
    const v = env[i] - mean;
    x[i] = v;
    energy += v * v;
  }
  if (energy <= 0) return none; // flat envelope — no onsets, nothing to correlate

  const lagMin = Math.max(1, Math.round(60000 / bpmMax / envHopMs));
  const lagMax = Math.min(N - 1, Math.round(60000 / bpmMin / envHopMs));
  if (lagMax <= lagMin) return none;

  const ac = new Float64Array(lagMax + 1);
  let bestLag = lagMin;
  let bestVal = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = lag; i < N; i++) s += x[i] * x[i - lag];
    ac[lag] = s;
    if (s > bestVal) {
      bestVal = s;
      bestLag = lag;
    }
  }

  // Sub-hop precision: parabolic interpolation of the peak against its neighbours.
  let lagInterp = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = ac[bestLag - 1];
    const y1 = ac[bestLag];
    const y2 = ac[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const delta = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(delta) < 1) lagInterp = bestLag + delta;
    }
  }

  const periodMs = lagInterp * envHopMs;
  const bpmRaw = 60000 / periodMs;
  const confidence = Math.max(0, Math.min(1, bestVal / energy));
  const bpmFolded = octaveFold(bpmRaw, prefer, bpmMin, bpmMax);
  return { bpmRaw, bpmFolded, confidence };
}

// Re-grid timestamped flux frames onto the constant HOP_MS grid (§2.2 / the MEDIUM-2
// fix). A setInterval poll does NOT land on an even grid (timer jitter, main-thread
// contention), but autocorrelateTempo REQUIRES one. So the IO shell stamps every poll
// with AudioContext.currentTime and calls this: each frame is placed in its nearest grid
// slot; a SKIPPED slot stays zero-filled, a DOUBLED slot is AVERAGED. The pure core then
// sees a true constant-hop envelope regardless of wall-clock jitter. (Timestamping alone,
// without re-gridding, would NOT make a fixed-hop autocorrelation valid — the re-grid is
// the actual fix.) Pure + exported so the recovery is unit-tested with jittered stamps.
export function regridOntoHop(
  frames: ReadonlyArray<{ tMs: number; flux: number }>,
  hopMs: number,
  t0Ms: number,
  length: number,
): number[] {
  const grid = new Array<number>(length).fill(0);
  const counts = new Array<number>(length).fill(0);
  for (const f of frames) {
    const slot = Math.round((f.tMs - t0Ms) / hopMs);
    if (slot < 0 || slot >= length) continue;
    grid[slot] += f.flux;
    counts[slot] += 1;
  }
  for (let i = 0; i < length; i++) {
    if (counts[i] > 1) grid[i] /= counts[i]; // doubled slot → average
    // counts[i] === 0 ⇒ skipped slot ⇒ stays zero-filled (already 0)
  }
  return grid;
}
