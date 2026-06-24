import type { ChartCalibration } from './types';
import { moveBarBoundary } from './chart-calibration';

// ── CV Barline Snap — pure core ──────────────────────────────────────────────
// The automated layer between autoDistributeBars (even floor) and the manual
// barline-tick drag (moveBarBoundary, #94): read a system band's column-darkness
// profile, find the real printed vertical barlines, and snap the auto-distributed
// boundaries onto them. Geometry-safe (applies ONLY through moveBarBoundary, so
// every #94 invariant inherits), never changes bar count, and reports enough
// metadata for the UI to surface no-ops, count mismatches, and clamped partials
// without re-deriving any matcher internals. See docs/design-cv-barline-snap.md.
//
// This file is pure (no DOM): the only DOM-touching step — turning a band's
// pixels into a BandProfile — lives in the page component and is covered by
// manual UAT, mirroring the repo's vitest `environment: 'node'` posture.

// Tunable named constants (decision 5; calibrate post-UAT). MIN_COVERAGE,
// MIN_STRENGTH, MAX_LINE_FRAC, NMS_PX gate detection; MAX_PULL_FRAC + SNAP_EPSILON
// gate/verify the snap; DARK_LUMA + SNAP_RENDER_SCALE are read by the DOM adapter.
export const MIN_COVERAGE = 0.6; // a barline spans ≥60% of band height; stems/text far less
export const MIN_STRENGTH = 0.35; // detection-confidence floor (both match branches)
export const MAX_LINE_FRAC = 0.05; // reject clusters wider than 5% of band (shaded fills)
export const NMS_PX = 4; // merge above-threshold columns within this gap into one line
export const MAX_PULL_FRAC = 0.5; // cap a pull at 0.5 × local bar width (unequal-count branch)
export const SNAP_EPSILON = 0.003; // page-norm: how close a landed boundary counts as fully snapped
export const DARK_LUMA = 140; // 0..255; luminance below this = "dark" (DOM adapter)
export const SNAP_RENDER_SCALE = 2.5; // offscreen render scale (DOM adapter; ~1000px band target)
export const STAFF_ROW_FRAC = 0.5; // DOM adapter: a band row is "staff" if dark across ≥50% of its width

export interface BandProfile {
  cols: number; // sampled columns across the band width (≈ band px width)
  dark: Float32Array; // length cols; per-column fraction 0..1 of band rows that are dark
}

export interface DetectedLine {
  x: number; // normalized 0..1 WITHIN the band (0 = xStart, 1 = xEnd)
  strength: number; // 0..1 detection confidence (height coverage × local contrast)
}

export interface SnapOptions {
  minCoverage?: number;
  minStrength?: number;
  maxLineFrac?: number;
  nmsPx?: number;
  maxPullFrac?: number;
  snapEpsilon?: number;
}

// The result is a shape, not just the mutated calibration (Codex R3): the UI
// reports "no clear barlines" (accepted === 0), the count delta
// (detectedLines ≠ expectedBoundaries), and clamped partials (partial > 0)
// straight from these fields.
export interface SnapBarsResult {
  calibration: ChartCalibration; // mutated cal; === input identity when accepted === 0
  detectedLines: number; // |L| AFTER the strength prefilter — the lines snap acted on
  expectedBoundaries: number; // N+1 for the system's N bars (0 if the system is unknown/empty)
  accepted: number; // matches the matcher accepted (pre-apply)
  fullySnapped: number; // accepted boundaries that landed within ε of their target
  partial: number; // accepted − fullySnapped (moveBarBoundary clamped them short)
  surplusLines: number; // detectedLines − accepted (lines no boundary took)
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ── detectBarlines — vertical-line finder ───────────────────────────────────
// A printed barline is a tall, thin, dark vertical run. Cluster the columns that
// clear the height-coverage floor (merging gaps ≤ NMS_PX so an anti-aliased line
// stays one candidate), reject clusters too wide to be a line, take each
// cluster's dark-weighted centroid, and score it by coverage × local contrast.
export function detectBarlines(profile: BandProfile, opts?: SnapOptions): DetectedLine[] {
  const cols = profile.cols;
  const dark = profile.dark;
  if (cols <= 0 || dark.length === 0) return [];
  const minCoverage = opts?.minCoverage ?? MIN_COVERAGE;
  const minStrength = opts?.minStrength ?? MIN_STRENGTH;
  const maxLineFrac = opts?.maxLineFrac ?? MAX_LINE_FRAC;
  const nmsPx = opts?.nmsPx ?? NMS_PX;

  // 1+2. Above-coverage columns → clusters, bridging gaps ≤ nmsPx (NMS).
  const clusters: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < cols) {
    if (dark[i] >= minCoverage) {
      let end = i;
      let j = i + 1;
      while (j < cols) {
        if (dark[j] >= minCoverage) {
          end = j;
          j += 1;
        } else {
          // bridge a sub-nmsPx gap only if another above-coverage column follows
          let k = j;
          let bridged = -1;
          while (k < cols && k - end <= nmsPx) {
            if (dark[k] >= minCoverage) {
              bridged = k;
              break;
            }
            k += 1;
          }
          if (bridged >= 0) {
            end = bridged;
            j = bridged + 1;
          } else break;
        }
      }
      clusters.push({ start: i, end });
      i = end + 1;
    } else {
      i += 1;
    }
  }

  const maxWidthCols = maxLineFrac * cols;
  const lines: DetectedLine[] = [];
  for (const c of clusters) {
    const widthCols = c.end - c.start + 1;
    if (widthCols > maxWidthCols) continue; // 3. thinness — reject shaded boxes / fills

    // 4. dark-weighted centroid in column-center units → normalized 0..1.
    let wSum = 0;
    let xSum = 0;
    let peak = 0;
    for (let col = c.start; col <= c.end; col += 1) {
      const w = dark[col];
      wSum += w;
      xSum += w * (col + 0.5);
      if (w > peak) peak = w;
    }
    if (wSum <= 0) continue;
    const x = clamp01(xSum / wSum / cols);

    // 5. strength = coverage × local contrast (how much the line stands out from
    // its surroundings). On a clean page the neighborhood is ~white → contrast ≈ 1
    // → strength ≈ coverage; on a noisy scan the neighborhood is dark → contrast
    // drops → weak lines fall below MIN_STRENGTH (the intended degrade).
    const win = Math.max(nmsPx * 4, widthCols * 2);
    let nSum = 0;
    let nCount = 0;
    for (let col = c.start - win; col <= c.end + win; col += 1) {
      if (col < 0 || col >= cols || (col >= c.start && col <= c.end)) continue;
      nSum += dark[col];
      nCount += 1;
    }
    const neighborhoodMean = nCount > 0 ? nSum / nCount : 0;
    const contrast = clamp01(1 - neighborhoodMean / Math.max(peak, 1e-6));
    const strength = clamp01(peak * contrast);
    if (strength < minStrength) continue; // 6. drop low-confidence candidates

    lines.push({ x, strength });
  }
  lines.sort((a, b) => a.x - b.x);
  return lines;
}

// ── snapBarsToLines — assign + apply ─────────────────────────────────────────
// All matching/gating is decided against ONE pre-snap snapshot (boundary
// positions + bar widths), then committed in a single ascending moveBarBoundary
// fold — never re-reading the partially-mutated geometry (determinism). Snap only
// re-positions existing boundaries; it never adds or removes a bar.
export function snapBarsToLines(
  cal: ChartCalibration,
  systemId: string,
  lines: DetectedLine[],
  opts?: SnapOptions,
): SnapBarsResult {
  const minStrength = opts?.minStrength ?? MIN_STRENGTH;
  const maxPullFrac = opts?.maxPullFrac ?? MAX_PULL_FRAC;
  const eps = opts?.snapEpsilon ?? SNAP_EPSILON;

  const system = (cal.systems ?? []).find((s) => s.id === systemId);
  const sysBars = (cal.bars ?? [])
    .filter((b) => b.systemId === systemId)
    .sort((a, b) => a.xStart - b.xStart);
  const n = sysBars.length;

  // Strength prefilter (BOTH branches, B2): a sub-strength stroke can't pad the
  // count to N+1 and trigger ungated ordinal anchoring. The count is independent
  // of page mapping (so it's still meaningful for an unknown system).
  const passed = lines.filter((ln) => ln.strength >= minStrength);
  const detectedLines = passed.length;

  if (!system || n === 0) {
    return {
      calibration: cal,
      detectedLines,
      expectedBoundaries: 0,
      accepted: 0,
      fullySnapped: 0,
      partial: 0,
      surplusLines: detectedLines,
    };
  }

  // Map survivors to page space, ascending.
  const span = system.xEnd - system.xStart;
  const L = passed.map((ln) => system.xStart + ln.x * span).sort((a, b) => a - b);

  const expectedBoundaries = n + 1;

  // Pre-snap snapshot: boundary positions B (tick model, same as #94) and bar
  // widths for the edge-aware MAX_PULL.
  const B: number[] = [];
  for (let i = 0; i <= n; i += 1) {
    B.push(i === 0 ? sysBars[0].xStart : i === n ? sysBars[n - 1].xEnd : sysBars[i].xStart);
  }
  const barW = (k: number): number => sysBars[k].xEnd - sysBars[k].xStart;
  const maxPullAt = (i: number): number =>
    maxPullFrac * (i === 0 ? barW(0) : i === n ? barW(n - 1) : Math.min(barW(i - 1), barW(i)));

  // Matching → accepted targets in ascending boundary index.
  const accepted: Array<{ index: number; target: number }> = [];
  if (detectedLines === expectedBoundaries) {
    // Equal counts: ordinal anchoring, edges included. MAX_PULL intentionally
    // off here (it's what lets boundary 0 reclaim a wide clef margin); the
    // strength prefilter already gated L.
    for (let i = 0; i <= n; i += 1) accepted.push({ index: i, target: L[i] });
  } else if (detectedLines > 0) {
    // Symmetric mutual-nearest on the snapshot (Codex R2 #1): nearestLine[i] and
    // nearestBoundary[j] must point at each other; no line is consumed merely by
    // being considered, so an earlier boundary can't burn a later one's line.
    // Ties → smaller index (reading order, Codex R2 NB) via strict-< scan.
    const nearestLineOf = (i: number): number => {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < detectedLines; j += 1) {
        const d = Math.abs(L[j] - B[i]);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      return best;
    };
    const nearestBoundaryOf = (j: number): number => {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i <= n; i += 1) {
        const d = Math.abs(L[j] - B[i]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };
    const nL: number[] = [];
    for (let i = 0; i <= n; i += 1) nL.push(nearestLineOf(i));
    const nB: number[] = [];
    for (let j = 0; j < detectedLines; j += 1) nB.push(nearestBoundaryOf(j));
    for (let i = 0; i <= n; i += 1) {
      const j = nL[i];
      if (nB[j] !== i) continue; // not mutual
      if (Math.abs(L[j] - B[i]) > maxPullAt(i)) continue; // exceeds MAX_PULL
      accepted.push({ index: i, target: L[j] });
    }
  }

  // Apply: one ascending fold through moveBarBoundary (the single mutation path,
  // inheriting every #94 invariant). Zero accepted → calibration is input identity.
  let next = cal;
  for (const m of accepted) next = moveBarBoundary(next, systemId, m.index, m.target);

  // Post-apply honesty (D): moveBarBoundary silently clamps an out-of-window
  // target, so an accepted match may rest short of its detected line. Compare
  // each moved boundary's resting tick to its target; within ε = fullySnapped,
  // else partial. moveBarBoundary never adds/removes/reorders bars, so index i
  // still names the same boundary in the final geometry.
  const finalBars = (next.bars ?? [])
    .filter((b) => b.systemId === systemId)
    .sort((a, b) => a.xStart - b.xStart);
  const finalTick = (i: number): number =>
    i === 0 ? finalBars[0].xStart : i === n ? finalBars[n - 1].xEnd : finalBars[i].xStart;
  let fullySnapped = 0;
  for (const m of accepted) {
    if (Math.abs(finalTick(m.index) - m.target) <= eps) fullySnapped += 1;
  }

  return {
    calibration: next,
    detectedLines,
    expectedBoundaries,
    accepted: accepted.length,
    fullySnapped,
    partial: accepted.length - fullySnapped,
    surplusLines: detectedLines - accepted.length,
  };
}
