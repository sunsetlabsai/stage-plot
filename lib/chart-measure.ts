// ── Chart measurement — the deterministic geometry pipeline (docs/design-chart-measurement.md) ──
//
// Stages 1-5 of the frozen spec, as PURE functions over segments + text items. This
// module knows nothing about pdf.js, canvases, the DOM, or the network: geometry comes
// in as page-space line segments and printed text comes in as positioned strings.
// `lib/chart-measure-canvas.ts` is the one adapter that produces those inputs from a
// PDF; keeping the split here is what makes stages 2-5 unit-testable without a corpus.
//
// CRITICAL: this module imports NOTHING. It runs identically in the browser (where the
// engine executes, per §The split contract) and in a node test. Keep it that way.
//
// Every threshold below is CORPUS-CALIBRATED, not arbitrary — the reference
// implementation scores 464/464 scored systems across 62 real charts, and the
// acceptance harness (scripts/chart-measure-acceptance.ts) is the only thing that
// licenses changing any of them. Move a constant, run the harness, or you are guessing.

// ─── Stage 1: staves ─────────────────────────────────────────────────────────
/** A segment counts as axis-aligned if it deviates by less than this (pt). */
export const AXIS_TOL = 0.5;
/** Segments shorter than this are ink noise (serifs, glyph fragments, join stubs). */
export const MIN_SEGMENT_LEN = 2;
/** Two horizontal segments belong to the same rule if their y differ by less (pt). */
export const RULE_Y_TOL = 0.5;
/** Collinear runs closer than this merge — engravers break staff lines at barlines. */
export const RULE_X_MERGE_GAP = 1.5;
/** A staff-line candidate must be at least this fraction of the longest rule. */
export const STAFF_LEN_FRACTION = 0.6;
/** Staff line spacing is read as this percentile of the positive inter-rule gaps. */
export const LINE_GAP_PERCENTILE = 0.25;
/** Used only when a page has too few gaps to take a percentile from (pt). */
export const LINE_GAP_FALLBACK = 5;
/** Rules further apart than this multiple of the line gap start a new system. */
export const STAFF_GROUP_FACTOR = 2.5;
/** A staff has 5 lines; allow one missing or one extra before rejecting the group. */
export const STAFF_MIN_LINES = 4;
export const STAFF_MAX_LINES = 6;

// ─── Stage 2: barlines ───────────────────────────────────────────────────────
/** A vertical is a barline only if BOTH endpoints land on the outer staff lines. */
export const BARLINE_END_TOL_FRACTION = 0.04;
export const BARLINE_END_TOL_MIN = 1.2;
/** Above this width (pt) a stroke is a repeat/final thick bar, never a note stem. */
export const THICK_STROKE_PT = 1.5;
/** Repeat thick+thin pairs run 3-4.5pt apart; no real bar of music is this narrow. */
export const BARLINE_CLUSTER_GAP = 6;
/** Barline width is engraver-specific but MODAL within a chart. Bucket, then match. */
export const MODAL_WIDTH_BUCKET = 0.05;
export const MODAL_WIDTH_TOL = 0.12;
/** A line-start begin-repeat needs at least this many clusters to be distinguishable. */
export const MIN_CLUSTERS_FOR_LINE_START_REPEAT = 3;
/**
 * A thick leftmost cluster is a span START (begin-repeat) rather than a divider when
 * the gap from the staff start is under this multiple of the median bar width — i.e.
 * the gap holds clef/key/time only, with no room for a bar of music. Corpus: line-start
 * repeats show gap/median 0.25-0.88; a thick divider with a real bar before it shows
 * 1.38. "Left 20% of the staff" was tried and is WRONG — one chart's genuine first bar
 * fits inside that window.
 */
export const LINE_START_REPEAT_GAP_FACTOR = 1.0;
/** Fallback median bar width when a system has too few clusters, as a staff fraction. */
export const FALLBACK_MEDIAN_BAR_FRACTION = 0.2;

// ─── Stage 3: text ───────────────────────────────────────────────────────────
/** A measure number sits within this distance (pt) of the leftmost staff edge. */
export const MARGIN_NUMBER_X_TOL = 4;
/** Time signatures are two digits stacked at the same x — excluded, not counted. */
export const TIMESIG_X_TOL = 1.5;
export const TIMESIG_Y_MIN = 6;
export const TIMESIG_Y_MAX = 14;
/** Text is attributed to the nearest system within this multiple of staff height. */
export const BAND_MATCH_FACTOR = 1.5;
/** A multirest H-bar sits strictly inside the staff band, this far in from each edge. */
export const MULTIREST_INSET_FRACTION = 0.2;
/** ...and is shorter than this fraction of the staff — longer means it IS the staff. */
export const MULTIREST_MAX_LEN_FRACTION = 0.6;
/** The multirest COUNT digit sits above its H-bar, within these tolerances. */
export const MULTIREST_DIGIT_X_TOL = 6;
export const MULTIREST_DIGIT_Y_FACTOR = 1.8;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * One painted line in PAGE SPACE: points, y increasing DOWNWARD from the page top.
 * `strokeW` is the stroke width in points, or `null` for a filled shape (some
 * engravers draw barlines as thin filled rectangles rather than strokes).
 */
export interface MeasuredSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  strokeW: number | null;
}

/** A positioned text run, in the same page space as the segments. */
export interface PositionedText {
  str: string;
  x: number;
  y: number;
}

/**
 * What the geometry alone can conclude. The frozen spec's full vocabulary is
 * `validated | corroborated | uncertain | estimated`, but two of those four REQUIRE an
 * independent VLM opinion, and per §The split contract the VLM runs server-side with a
 * key the browser never sees. So the engine emits provisional verdicts and the server
 * completes the vocabulary after its VLM step (chunk B2).
 *
 * - `validated`  — measured span count equals the printed measure-number delta.
 * - `uncertain`  — measured disagrees with printed. Needs the per-system VLM fallback,
 *                  and stays `uncertain` until a human answers.
 * - `unscored`   — no printed delta was available to check against: the page-tail
 *                  system, or the first system of a continuation page. Deliberate —
 *                  cross-page measure-number chaining is a §Non-goal.
 */
export type ProvisionalVerdict = 'validated' | 'uncertain' | 'unscored';

/**
 * What the page IS, decided before any verdict matters.
 *
 * - `notation`     — staves were found; measure it.
 * - `not-notation` — a vector page with real text but ZERO staves: a lyrics sheet or a
 *                    chord chart. This is the automatic backstop gate from
 *                    backlog-charting.md §Ruled 2026-09-02, and the one never-gate that
 *                    could not be expressed at the `chart_library` row level, because
 *                    it catches a MISLABELED upload. No VLM call, no overlay.
 * - `raster`       — no vectors and no text: a scan. Whole-page VLM (`estimated`).
 */
export type PageClass = 'notation' | 'not-notation' | 'raster';

/**
 * One multirest: N musical measures drawn as a single visible bar.
 *
 * ★ The x-range was ADDED in B2 — this was a bare `number[]`. A count alone says the
 * system contains a 4-measure multirest but not WHICH bar it is, and `Bar.measures` has
 * to be attached to one specific bar. The sum check that guards it is invariant under
 * mis-assignment (put the 4 on the wrong bar and the total is still right), so position
 * is the only thing that can prevent that.
 */
export interface MeasuredMultirest {
  count: number;
  /** Page-space x-range of the H-bar, for matching to the bar that contains it. */
  xStart: number;
  xEnd: number;
}

/** One visible measure, as a page-space x-range inside its parent system. */
export interface MeasuredBar {
  xStart: number;
  xEnd: number;
}

export interface MeasuredSystem {
  /** Page-space y of the top and bottom staff lines. */
  yTop: number;
  yBot: number;
  /** Page-space x of the staff's left and right ends. */
  x0: number;
  x1: number;
  /** Page-space x of each span divider, left to right. */
  barlines: number[];
  /** Number of measures the geometry says this system holds. */
  spans: number;
  /**
   * The visible measures, left to right — always exactly `spans` of them.
   *
   * Derived here rather than by each caller, because it depends on a stage-2 decision
   * that is not otherwise visible at this boundary: `barlines` alone cannot say whether
   * the leftmost cluster is a divider or a begin-repeat. A cluster is the RIGHT edge of a
   * measure, so bars normally run staff-start → c0 → c1 → …; when the line-start
   * begin-repeat rule fired the leftmost cluster is a span START and bars run between
   * clusters instead.
   */
  bars: MeasuredBar[];
  /** The measure number printed at the staff's left edge, if any. */
  printedNumber: number | null;
  /** Multirests found in this system, with position. */
  multirests: MeasuredMultirest[];
  /** What the printed numbers say `spans` should be, or null when unscored. */
  expectedSpans: number | null;
  verdict: ProvisionalVerdict;
}

/**
 * Which page was measured, and how big it is. `width`/`height` are carried because
 * normalization to the [0,1] coordinates `isValidCalibration` requires happens
 * DOWNSTREAM, and a caller holding a `PageMeasurement` should not have to still be
 * holding the pdf.js page to do it. This module itself stays entirely in page space.
 */
export interface PageInfo {
  /**
   * 1-based, and load-bearing at stage 4: an unnumbered first system is measure 1 on
   * PAGE 1 ONLY. On a continuation page it must abstain.
   */
  number: number;
  /** Page dimensions in points. */
  width: number;
  height: number;
}

export interface PageMeasurement {
  pageNumber: number;
  /** Page dimensions in points, for normalizing geometry to [0,1]. */
  pageWidth: number;
  pageHeight: number;
  classification: PageClass;
  staffCount: number;
  systems: MeasuredSystem[];
}

interface MergedRule {
  y: number;
  x0: number;
  x1: number;
  len: number;
}

interface Vertical {
  x: number;
  w: number;
  thick: boolean;
}

// ─── Stage 1: staves ─────────────────────────────────────────────────────────

/**
 * Horizontal segments → merged rules. Some engravers break each staff line at every
 * barline, so a staff line arrives as a dozen collinear fragments; others draw it once.
 * Bucketing by y and merging contiguous x-ranges makes both shapes look the same.
 */
export function mergeHorizontalRules(segments: MeasuredSegment[]): MergedRule[] {
  const horiz = segments
    .filter((s) => Math.abs(s.y1 - s.y0) < AXIS_TOL && Math.abs(s.x1 - s.x0) > MIN_SEGMENT_LEN)
    .sort((p, q) => p.y0 + p.y1 - (q.y0 + q.y1));

  const buckets: { y: number; parts: [number, number][] }[] = [];
  for (const s of horiz) {
    const y = (s.y0 + s.y1) / 2;
    const part: [number, number] = [Math.min(s.x0, s.x1), Math.max(s.x0, s.x1)];
    const last = buckets[buckets.length - 1];
    if (last && Math.abs(last.y - y) < RULE_Y_TOL) last.parts.push(part);
    else buckets.push({ y, parts: [part] });
  }

  const rules: MergedRule[] = [];
  for (const b of buckets) {
    b.parts.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const [lo, hi] of b.parts) {
      const prev = merged[merged.length - 1];
      if (prev && lo <= prev[1] + RULE_X_MERGE_GAP) prev[1] = Math.max(prev[1], hi);
      else merged.push([lo, hi]);
    }
    for (const [lo, hi] of merged) rules.push({ y: b.y, x0: lo, x1: hi, len: hi - lo });
  }
  return rules;
}

/**
 * Rules → staff groups. Length FIRST, then spacing: filtering by length before grouping
 * is what stops interleaved ink (voltas, rehearsal boxes, multirest H-bars, hairpins)
 * from splitting a staff in two.
 */
function groupStaves(rules: MergedRule[]): MergedRule[][] {
  if (rules.length === 0) return [];
  const maxLen = Math.max(...rules.map((r) => r.len));
  const cands = rules
    .filter((r) => r.len >= STAFF_LEN_FRACTION * maxLen)
    .sort((p, q) => p.y - q.y);
  if (cands.length === 0) return [];

  const gaps: number[] = [];
  for (let i = 1; i < cands.length; i++) gaps.push(cands[i].y - cands[i - 1].y);
  const positive = gaps.filter((g) => g > AXIS_TOL).sort((p, q) => p - q);
  const lineGap = positive[Math.floor(positive.length * LINE_GAP_PERCENTILE)] ?? LINE_GAP_FALLBACK;

  const groups: MergedRule[][] = [];
  let group: MergedRule[] = [cands[0]];
  for (let i = 1; i < cands.length; i++) {
    if (cands[i].y - cands[i - 1].y <= STAFF_GROUP_FACTOR * lineGap) group.push(cands[i]);
    else {
      groups.push(group);
      group = [cands[i]];
    }
  }
  groups.push(group);
  return groups.filter((g) => g.length >= STAFF_MIN_LINES && g.length <= STAFF_MAX_LINES);
}

// ─── Stage 2: barlines ───────────────────────────────────────────────────────

/**
 * Verticals whose BOTH endpoints land on the outer staff lines. That endpoint test is
 * what separates a barline from a note stem that happens to cross the staff — and it is
 * only trustworthy in honest coordinates. (The abandoned hand-rolled CTM walk produced
 * 23-28pt content-dependent drift, which this test silently converted into phantom
 * barlines. See §The coordinate-source decision.)
 */
function verticalsOnStaff(verticals: MeasuredSegment[], yTop: number, yBot: number): Vertical[] {
  const tol = Math.max(BARLINE_END_TOL_FRACTION * (yBot - yTop), BARLINE_END_TOL_MIN);
  const out: Vertical[] = [];
  for (const v of verticals) {
    const lo = Math.min(v.y0, v.y1);
    const hi = Math.max(v.y0, v.y1);
    if (Math.abs(lo - yTop) <= tol && Math.abs(hi - yBot) <= tol) {
      const w = v.strokeW ?? 0;
      out.push({ x: (v.x0 + v.x1) / 2, w, thick: w > THICK_STROKE_PT });
    }
  }
  out.sort((p, q) => p.x - q.x);
  return out;
}

/**
 * The modal thin-barline width for the WHOLE PAGE. Barline width is engraver-specific
 * but consistent within a chart, and a note stem that happens to span the staff exactly
 * is measurably thinner (measured: 0.62 vs 0.78 on one chart, 0.43 vs 0.72 on another).
 * A 0.1pt discrimination — which is why the render scale in the canvas adapter is
 * load-bearing rather than a rendering preference.
 */
function modalStrokeWidth(systems: { verts: Vertical[] }[]): number {
  const counts = new Map<number, number>();
  for (const s of systems) {
    for (const v of s.verts) {
      if (v.w > 0 && !v.thick) {
        const bucket = Math.round(v.w / MODAL_WIDTH_BUCKET) * MODAL_WIDTH_BUCKET;
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0;
}

// ─── Stage 3: text ───────────────────────────────────────────────────────────

/**
 * pdf.js text items → page space. PDF text space has y increasing UPWARD from the page
 * bottom; every geometry coordinate in this module runs DOWNWARD from the page top, so
 * the flip happens here, once, rather than at each comparison.
 */
export function toPositionedText(
  items: { str: string; transform: number[] }[],
  pageHeight: number,
): PositionedText[] {
  return items.map((it) => ({
    str: it.str,
    x: it.transform[4],
    y: pageHeight - it.transform[5],
  }));
}

/** Integer runs, minus time signatures (two digits stacked at the same x). */
function integerRuns(text: PositionedText[]): { n: number; x: number; y: number }[] {
  const ints: { n: number; x: number; y: number }[] = [];
  for (const t of text) {
    const s = t.str.trim();
    if (!/^\d+$/.test(s)) continue;
    ints.push({ n: parseInt(s, 10), x: t.x, y: t.y });
  }
  return ints.filter((p, i) =>
    !ints.some(
      (q, j) =>
        j !== i &&
        Math.abs(q.x - p.x) < TIMESIG_X_TOL &&
        Math.abs(q.y - p.y) > TIMESIG_Y_MIN &&
        Math.abs(q.y - p.y) < TIMESIG_Y_MAX,
    ),
  );
}

// ─── Stages 1-5 ──────────────────────────────────────────────────────────────

/**
 * Measure one page. See `PageInfo.number` for why the page number is load-bearing at
 * stage 4 — assuming 1 on a continuation page invents a delta out of the previous page's
 * measure count.
 */
export function measurePage(
  segments: MeasuredSegment[],
  text: PositionedText[],
  page: PageInfo,
): PageMeasurement {
  const { number: pageNumber, width: pageWidth, height: pageHeight } = page;
  const rules = mergeHorizontalRules(segments);
  const groups = groupStaves(rules);

  if (groups.length === 0) {
    // No staves. A page with real text is a lyrics sheet or a chord chart — a
    // classification, not a failure, and the automatic backstop never-gate. Without
    // text there is nothing to read either: a scan, or a vector page whose ink we
    // could not interpret. Both route to the whole-page VLM (`estimated`), which is
    // why they share one class despite `raster` naming only the common case.
    const hasText = text.some((t) => t.str.trim().length > 0);
    return {
      pageNumber,
      pageWidth,
      pageHeight,
      classification: hasText ? 'not-notation' : 'raster',
      staffCount: 0,
      systems: [],
    };
  }

  const verticals = segments.filter(
    (s) => Math.abs(s.x1 - s.x0) < AXIS_TOL && Math.abs(s.y1 - s.y0) > MIN_SEGMENT_LEN,
  );

  const staves = groups.map((g) => {
    const yTop = g[0].y;
    const yBot = g[g.length - 1].y;
    const h = yBot - yTop;
    const x0 = Math.min(...g.map((r) => r.x0));
    const x1 = Math.max(...g.map((r) => r.x1));
    // A multirest is drawn as a thick H-bar strictly inside the staff band. Its end
    // caps are half-height, so they never pass the barline endpoint test — no cap
    // suppression is needed, and adding any would eat the real barline that ENDS the
    // multirest (it sits ~4pt past the H-bar).
    const multirestBars = rules.filter(
      (r) =>
        r.y > yTop + h * MULTIREST_INSET_FRACTION &&
        r.y < yBot - h * MULTIREST_INSET_FRACTION &&
        r.len > h &&
        r.len < MULTIREST_MAX_LEN_FRACTION * (x1 - x0),
    );
    return {
      yTop,
      yBot,
      h,
      x0,
      x1,
      verts: verticalsOnStaff(verticals, yTop, yBot),
      multirestBars,
      printedNumber: null as number | null,
      multirests: [] as MeasuredMultirest[],
    };
  });

  // Attribute text to the nearest staff band.
  const leftEdge = Math.min(...staves.map((s) => s.x0));
  const bandOf = (y: number) => {
    let best: (typeof staves)[number] | null = null;
    let bestDist = Infinity;
    for (const s of staves) {
      const d = y < s.yTop ? s.yTop - y : y > s.yBot ? y - s.yBot : 0;
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best && bestDist <= best.h * BAND_MATCH_FACTOR ? best : null;
  };

  for (const t of integerRuns(text)) {
    const s = bandOf(t.y);
    if (!s) continue;
    if (t.x <= leftEdge + MARGIN_NUMBER_X_TOL) {
      if (s.printedNumber === null) s.printedNumber = t.n;
    } else {
      // A multirest is the PAIR of a digit and an H-bar beneath it. A chord-extension
      // superscript has no bar; a beam has no digit. Neither qualifies alone.
      const bar = s.multirestBars.find(
        (r) =>
          t.x >= r.x0 - MULTIREST_DIGIT_X_TOL &&
          t.x <= r.x1 + MULTIREST_DIGIT_X_TOL &&
          r.y > t.y &&
          r.y - t.y < MULTIREST_DIGIT_Y_FACTOR * s.h,
      );
      // Carry the H-bar's x-range, not just the count: B2 has to attach `measures` to
      // one specific bar, and the count alone cannot say which.
      if (bar) s.multirests.push({ count: t.n, xStart: bar.x0, xEnd: bar.x1 });
    }
  }

  // Span counting runs AFTER text, because the modal width is a page-level statistic.
  const modalW = modalStrokeWidth(staves);
  const systems: MeasuredSystem[] = staves.map((s) => {
    const clusters: { x: number; thick: boolean }[] = [];
    const keep = s.verts.filter(
      (v) => v.thick || v.w === 0 || Math.abs(v.w - modalW) < MODAL_WIDTH_TOL,
    );
    for (const v of keep) {
      const last = clusters[clusters.length - 1];
      if (last && v.x - last.x < BARLINE_CLUSTER_GAP) {
        last.x = v.x;
        last.thick = last.thick || v.thick;
      } else clusters.push({ x: v.x, thick: v.thick });
    }

    let spans = clusters.length;
    let lineStartRepeat = false;
    if (clusters.length >= MIN_CLUSTERS_FOR_LINE_START_REPEAT && clusters[0].thick) {
      const widths = clusters
        .slice(1)
        .map((c, i) => c.x - clusters[i].x)
        .sort((a, b) => a - b);
      const median =
        widths[Math.floor(widths.length / 2)] ?? FALLBACK_MEDIAN_BAR_FRACTION * (s.x1 - s.x0);
      if (clusters[0].x - s.x0 < LINE_START_REPEAT_GAP_FACTOR * median) {
        spans--;
        lineStartRepeat = true;
      }
    }

    // Clusters are the RIGHT edges of measures. Normally bar k runs from the previous
    // cluster to cluster k, with the staff's left edge standing in for the first. When
    // the line-start begin-repeat fired, the leftmost cluster is a span START instead, so
    // bars run cluster-to-cluster and there is one fewer — which is exactly the decrement
    // above. Either way `bars.length === spans`.
    const bars: MeasuredBar[] = [];
    let prevX = lineStartRepeat ? clusters[0].x : s.x0;
    for (const c of clusters.slice(lineStartRepeat ? 1 : 0)) {
      bars.push({ xStart: prevX, xEnd: c.x });
      prevX = c.x;
    }

    return {
      yTop: s.yTop,
      yBot: s.yBot,
      x0: s.x0,
      x1: s.x1,
      barlines: clusters.map((c) => c.x),
      spans,
      bars,
      printedNumber: s.printedNumber,
      multirests: s.multirests,
      expectedSpans: null,
      verdict: 'unscored' as ProvisionalVerdict,
    };
  });

  // Stage 4: printed delta = visible spans + Σ(multirest − 1).
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i];
    const next = systems[i + 1];
    const from = s.printedNumber ?? (i === 0 && pageNumber === 1 ? 1 : null);
    if (from === null || !next || next.printedNumber === null) continue;
    const delta = next.printedNumber - from;
    s.expectedSpans = delta - s.multirests.reduce((acc, m) => acc + (m.count - 1), 0);
    s.verdict = s.spans === s.expectedSpans ? 'validated' : 'uncertain';
  }

  return {
    pageNumber,
    pageWidth,
    pageHeight,
    classification: 'notation',
    staffCount: groups.length,
    systems,
  };
}

// ─── Geometry completeness — the never-gate's safety rule (B2) ────────────────
//
// docs/design-chart-measurement.md §The geometry-completeness precondition.
//
// A never-gate is UNAPPEALABLE: it refuses conversion permanently, with no VLM
// fallback. So `zero staves` may gate a page only when the geometry we scored was
// COMPLETE — evidence of absence, never absence of evidence.
//
// ★★ EVALUATED PER PAGE, over CATEGORIES, never over an aggregate. Both halves of that
// sentence are load-bearing and both have been got wrong before:
//
//  - `Σ opaque === 0` holds for 0 of 87 corpus files (`fillText` is the text layer;
//    `wash` is the page-covering fill the shim deliberately drops), so gating on the
//    total would disable the never-gate entirely and spend AI on all 342 lyrics PDFs.
//  - A file-level fold is the WRONG SHAPE for a per-page predicate: `fillRect` [0, 2]
//    sums to 2 over 2 pages and looks compliant while page 1 has lost its background
//    fill (fails OPEN) and page 2 carries an extra one.
//
// The input is deliberately structural rather than `PageGeometry` (that type lives in
// the client-only canvas adapter): this module imports nothing, and the predicate has to
// be callable from a node test and from the server-side payload check.

/**
 * Warnings that mean paint happened where the shim could not observe it. These, and only
 * these, mean the geometry is incomplete.
 *
 * ⚠ `anisotropic-ctm` is deliberately ABSENT. It is a PRECISION caveat — the geometry
 * *was* observed, under a non-uniform scale — and B1's blanket "any warning means
 * INCOMPLETE" is corrected here, measured: 4 corpus files carry it and validate 53/53
 * systems between them. Treating it as incomplete would route clean charts to the VLM.
 */
export const OBSERVABILITY_WARNINGS: readonly string[] = [
  'stroke-without-path',
  'fill-without-path',
  'no-2d-context',
];

/**
 * Ops that carry PIXELS rather than geometry, any of which could hide a staff: the two
 * shim-bypass classes (SMask / transparency-group ctx swaps, and pattern scratch
 * canvases arriving via `createPattern` / `drawImage`) plus `strokeRect`, which is
 * rect-shaped paint the shim never converts to segments. Measured across 87 corpus
 * files: `drawImage` appears in 2 (both classify `raster`, so both were already on the
 * VLM path); `putImageData`, `createPattern` and `strokeRect` are 0 everywhere.
 */
export const HIDING_OPS: readonly string[] = [
  'drawImage',
  'putImageData',
  'createPattern',
  'strokeRect',
];

/**
 * ★ `fillRect` is BOUNDED, not excluded — and this is the one clause resting on an
 * empirical rather than structural fact.
 *
 * `fillRect` never reaches the wash test (that lives inside the `fill(path)` handler),
 * produces no segments, and pdf.js also uses it for shading fills and image masks. But
 * excluding it is not the fix: it is present in 87 of 87 corpus files and 23 of 23 gate
 * candidates, so `fillRect === 0` would disable the never-gate exactly as `Σ opaque === 0`
 * would. The distinguisher is the COUNT, and it is sharp — exactly 1.00 per page across
 * the corpus, the pdf.js `beginDrawing` page-background fill. A SECOND fill on a page is
 * one pdf.js did not need for the background, and it opens the gate.
 *
 * ⚠ NOT symmetrically safe: more background fills fail closed (routed to the VLM), but
 * ZERO would let a hiding fill become the first on its page and be admitted. No
 * count-based clause can close that, which is why the assumption is ASSERTED per page,
 * every run, by `scripts/chart-measure-acceptance.ts` rather than reasoned about — and
 * why `pdfjs-dist` is pinned exact.
 */
export const MAX_STRUCTURAL_FILLRECT = 1;

/**
 * Was everything painted on THIS PAGE observed as geometry?
 *
 * ```
 * complete  ⟺  no OBSERVABILITY warning                                  (per page)
 *              ∧ drawImage + putImageData + createPattern + strokeRect == 0
 *              ∧ fillRect <= 1
 * ```
 *
 * `false` never means "bad chart" — it means "do not trust the measurement here", which
 * routes the page to the whole-page VLM instead of gating it.
 */
export function isGeometryComplete(geo: {
  warnings: readonly string[];
  opaque: Readonly<Record<string, number>>;
}): boolean {
  if (geo.warnings.some((w) => OBSERVABILITY_WARNINGS.includes(w))) return false;
  for (const op of HIDING_OPS) if ((geo.opaque[op] ?? 0) > 0) return false;
  return (geo.opaque.fillRect ?? 0) <= MAX_STRUCTURAL_FILLRECT;
}
