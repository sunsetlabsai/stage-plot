// ── Re-segmentation from a human's bar count (docs/design-chart-review-step.md §C4) ──
//
// The review sheet's count fallback. The owner says "this line has N bars"; this module
// turns that N into geometry, or REFUSES. It is pure, and it is deliberately the only
// place the selection policy lives — `chart-measure.ts` stays a measurement.
//
// ★ THE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE.
//
// The floor is NECESSARY, NOT SUFFICIENT. "Every boundary is an observed vertical" stops
// us inventing geometry, but it does not SELECT: when more clusters survive than N needs,
// a wrong subset is still fully observed. Two specific traps, both found in review:
//
//   1. A line-start begin-repeat cluster is a span START, not an interior divider. Taking
//      it as a divider is fully observed and wrong. Position alone cannot tell you this —
//      it is a stage-2 decision — which is why `lineStartRepeat` is an input.
//   2. A wrong N+1 can be reached WITHOUT inventing an interior vertical, by promoting the
//      true trailing barline to an interior boundary and letting the staff edge stand in
//      as the new trailing edge. The floor never sees it, because nothing was invented.
//
// Trap 2 is why the contract below is stated over span EDGES rather than over interior
// boundaries: EVERY span's right edge must be an observed cluster, and the staff edge may
// stand in only as the LEADING edge. That makes the promotion impossible — there is no
// trailing cluster left to use.
//
// ⚠ And note what this module is NOT allowed to do: read `MeasuredSystem.bars` or
// `spans`. That is a discipline, not a guarantee — `spans === clusters.length -
// (lineStartRepeat ? 1 : 0)` exactly, so any implementation here could re-derive the
// engine's own answer and echo it back. The acceptance harness therefore cannot prove
// honesty by withholding a field; it proves it by asking for counts the engine never
// produced (arm 2, N ± 1), where there is no answer to echo.

import type { MeasuredBar, MeasuredCluster } from './chart-measure';
import { BARLINE_END_TOL_MIN, MODAL_WIDTH_TOL } from './chart-measure';

/** What the re-segmenter was given. Evidence and the pinned count — nothing derived. */
export interface ResegmentInput {
  /** Stage-2 clusters for ONE system, left to right, with their barline evidence. */
  clusters: MeasuredCluster[];
  /** Whether the leftmost cluster is a span start rather than a divider. */
  lineStartRepeat: boolean;
  /** Page-space x of the staff's left and right ends. */
  x0: number;
  x1: number;
  /** The page's modal thin-barline width, for scoring width agreement. */
  modalWidth: number;
}

export type ResegmentFailure =
  /** Fewer usable right-edge clusters than the requested count. Nothing to invent from. */
  | 'insufficient-evidence'
  /** N < 1, or a non-integer — not a count a human can have meant. */
  | 'invalid-count'
  /** A chosen subset produced a zero- or negative-width span. */
  | 'degenerate-span';

export interface ResegmentResult {
  ok: boolean;
  bars?: MeasuredBar[];
  reason?: ResegmentFailure;
  /** How many clusters were available as right edges. `=== n` means the answer was FORCED. */
  available?: number;
}

/**
 * Score one cluster as a barline. Higher is better. Evidence only — both terms come
 * straight from stage 2 and are normalized by the tolerance that admitted them, so
 * neither axis can dominate by unit choice.
 *
 * `endMiss` — how far the vertical's ends missed the outer staff lines. A real barline
 * touches both.
 * width agreement — barline width is engraver-specific but MODAL within a chart. A thick
 * stroke is exempt: it is a repeat/final bar, legitimately off-modal by a different rule,
 * and penalizing it would rank real repeat barlines below note stems.
 */
export function clusterScore(c: MeasuredCluster, modalWidth: number): number {
  const endTerm = c.endMiss / BARLINE_END_TOL_MIN;
  const widthTerm =
    c.thick || c.w === 0 || modalWidth <= 0 ? 0 : Math.abs(c.w - modalWidth) / MODAL_WIDTH_TOL;
  return -(endTerm + widthTerm);
}

/**
 * Build the N-span segmentation the owner's count implies, or refuse.
 *
 * THE ENDPOINT CONTRACT (the floor, stated over edges):
 *  - every span's RIGHT edge is an observed cluster;
 *  - the only non-cluster edge is the LEADING edge — the staff start `x0` — and only when
 *    the begin-repeat did not fire (when it did, the leading edge is that cluster);
 *  - a staff edge may NEVER stand in as a right edge.
 *
 * So N spans need exactly N usable right-edge clusters. Fewer ⇒ refuse; the sheet routes
 * to "Open calibration" rather than fitting fake geometry. More ⇒ the surplus are treated
 * as false positives and the weakest are dropped by `clusterScore`.
 */
export function resegment(input: ResegmentInput, n: number): ResegmentResult {
  const { clusters, lineStartRepeat, x0, modalWidth } = input;
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'invalid-count' };

  // The leading edge is the staff start, unless the begin-repeat consumed the first
  // cluster — in which case that cluster IS the start and is not available as a right edge.
  const leading = lineStartRepeat && clusters.length > 0 ? clusters[0].x : x0;
  const usable = lineStartRepeat ? clusters.slice(1) : clusters;

  if (usable.length < n) {
    return { ok: false, reason: 'insufficient-evidence', available: usable.length };
  }

  // Keep the n best-scoring clusters, then restore reading order. Ties break on x so the
  // result is deterministic — an arbitrary tie-break here would be a silent policy.
  const chosen =
    usable.length === n
      ? usable
      : usable
          .map((c, i) => ({ c, i }))
          .sort((a, b) => clusterScore(b.c, modalWidth) - clusterScore(a.c, modalWidth) || a.i - b.i)
          .slice(0, n)
          .sort((a, b) => a.i - b.i)
          .map((e) => e.c);

  const bars: MeasuredBar[] = [];
  let prevX = leading;
  for (const c of chosen) {
    // A subset can be individually plausible and still collapse a span to nothing.
    if (!(c.x > prevX)) return { ok: false, reason: 'degenerate-span', available: usable.length };
    bars.push({ xStart: prevX, xEnd: c.x });
    prevX = c.x;
  }

  return { ok: true, bars, available: usable.length };
}
