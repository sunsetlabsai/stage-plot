// ── The measured payload — the contract between the client engine and the server ──
//
// docs/design-chart-measurement.md §The split contract, §Payload and route extension.
//
// PURE and SHARED. The browser builds this from `lib/chart-measure.ts` output; the
// convert route validates it, decides what it means, and installs it. Both sides read
// the SAME predicates from here, for the same reason `overlaySkipReason` is shared: the
// client decides what to offer and the server decides what to spend, and two copies of
// one rule is how they drift.
//
// Everything the server concludes from this payload is a decision about the OWNER'S OWN
// chart, so client geometry is treated as DATA (validated at the DB boundary like any
// other untrusted payload), never as trusted computation. A hostile owner can only
// corrupt their own draft overlay, which the human calibrate/verify flow then owns.

import type { Bar, ChartCalibration, SectionAnchor, System } from './types';
import { CALIBRATION_SCHEMA_VERSION, isValidBar, isValidSystem } from './chart-calibration';
import { THICK_STROKE_PT } from './chart-measure';
import type { MeasuredSystem, PageClass, PageMeasurement } from './chart-measure';

/**
 * What one page turned out to be, and whether we could see all of it.
 *
 * Both fields are PER PAGE and stay per page all the way to the decision — the
 * never-gate's safety rule is a per-page predicate and folding it into a chart-level
 * aggregate before evaluating it is the exact mistake `isGeometryComplete`'s header
 * warns about.
 */
export interface MeasuredPageReport {
  pageNumber: number;
  classification: PageClass;
  /** `isGeometryComplete` for THIS page. */
  complete: boolean;
}

/**
 * What the client measured. `systems`/`bars` are already normalized to the [0,1] page
 * coordinates the calibration model uses, already carry reading-order ids and a dense
 * `absNumber`, and are validated on arrival with the same `isValidSystem`/`isValidBar`
 * the DB boundary uses — so there is exactly one shape and one validator, not a parallel
 * "wire type" that can disagree with the stored one.
 */
export interface MeasuredPayload {
  pages: MeasuredPageReport[];
  systems: System[];
  bars: Bar[];
}

/** One page's engine output plus its completeness verdict, as the client sees it. */
export interface MeasuredPageResult {
  measurement: PageMeasurement;
  complete: boolean;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * How far a multirest's H-bar may cross a bar boundary and still count as INSIDE it.
 *
 * A bar boundary is a barline's CENTER, but a barline is drawn with width
 * (`THICK_STROKE_PT`), so a glyph sitting flush against a barline's inner edge lands
 * half a stroke past that center. That half-stroke is the entire allowance: it is a
 * drawing-width correction, not a search radius, and it must never grow into one.
 *
 * ★ UNMEASURED on the corpus, and deliberately conservative. `measure-expected.json` is
 * B1's reference schema and records no multirest data at all, so the harness cannot say
 * how often this demotes. The asymmetry decides it: over-demotion costs a review badge a
 * human clears, under-demotion costs a permanently wrong musical count (generate-once —
 * insert-only, never re-run). Quantify the badge volume in chunk C, where a human is
 * already looking at the flagged systems.
 */
const MULTIREST_CONTAINMENT_TOL = THICK_STROKE_PT / 2;

/**
 * Attach `measures` to the ONE bar each multirest actually sits in.
 *
 * Returns per-bar measure counts (parallel to `sys.bars`), or `null` when a multirest
 * cannot be attributed — which is a real outcome, not a can't-happen: the sum check that
 * guards this is INVARIANT UNDER MIS-ASSIGNMENT (put the 4 on the wrong bar and the
 * total is still right), so position is the only thing that can prevent a silently wrong
 * musical numbering. A null demotes the system rather than guessing.
 *
 * ★ The test is CONTAINMENT, never best-overlap (Codex, #177). A multirest IS a bar: its
 * H-bar is engraved between that bar's own barlines, so "inside exactly one bar" is the
 * only evidence that actually locates it. An earlier version took the bar with the
 * largest positive overlap, which cannot fail to produce an answer and therefore never
 * demoted: a multirest straddling a boundary was assigned to whichever side overlapped
 * more, and an exact TIE was silently resolved by array order. Both persisted a musical
 * count the geometry did not support, and the sum guard is blind to it by construction.
 * Ambiguity here is not a tie to be broken — it is the absence of a placement.
 *
 * Page space throughout — normalization is a later, monotone step and would only add
 * rounding to a comparison that is already deciding a permanent write.
 */
function attributeMultirests(sys: MeasuredSystem): number[] | null {
  const measures = sys.bars.map(() => 1);
  const claimed = new Set<number>();
  for (const mr of sys.multirests) {
    let target = -1;
    for (let i = 0; i < sys.bars.length; i++) {
      const b = sys.bars[i];
      const inside =
        mr.xStart >= b.xStart - MULTIREST_CONTAINMENT_TOL &&
        mr.xEnd <= b.xEnd + MULTIREST_CONTAINMENT_TOL;
      if (!inside) continue;
      // Contained in two bars at once — only reachable for a degenerate H-bar narrower
      // than the tolerance itself, sitting on a shared boundary. Still ambiguous.
      if (target >= 0) return null;
      target = i;
    }
    // Contained by no bar (it straddles a boundary, or lies off the system entirely), or
    // two multirests claim one bar — a multirest IS a bar, so either means the H-bar and
    // the bar geometry disagree and the count cannot be placed.
    if (target < 0 || claimed.has(target)) return null;
    claimed.add(target);
    measures[target] = mr.count;
  }
  return measures;
}

/**
 * The consistency guard from §The invariant, corrected. Evaluable on SCORED systems
 * only, and it is a guard, not a proof.
 *
 * ```
 * expectedSpans = delta − Σ(multirest − 1)      // VISIBLE, what the engine compares
 * Σ measures    = visible spans + Σ(multirest − 1) = delta   // MUSICAL
 * ```
 *
 * The earlier draft's "Σ measures === expectedSpans" is wrong by exactly Σ(multirest−1)
 * — it holds only when the system has no multirest, which is the one case it was written
 * to check. `expectedSpans` is null for the last system on a page, the first system of a
 * continuation page, and every `unscored` system (86/550 on the corpus): the invariant is
 * then UNDEFINED, not violated, and a check that fires on absent evidence is the same
 * mistake the never-gate's safety rule exists to prevent.
 *
 * On a `validated` system this is arithmetically true BY CONSTRUCTION, which is the
 * point: the only way it can fail is if attribution dropped or duplicated a count. That
 * is precisely the bug class it is here to catch.
 */
function measuresAgreeWithPrinted(sys: MeasuredSystem, measures: number[]): boolean {
  if (sys.expectedSpans === null || sys.verdict !== 'validated') return true; // undefined, not failed
  const extras = sys.multirests.reduce((acc, m) => acc + (m.count - 1), 0);
  const delta = sys.expectedSpans + extras;
  return measures.reduce((a, b) => a + b, 0) === delta;
}

/**
 * Engine output → the wire payload, or `null` when the measurement cannot be expressed
 * as a valid calibration at all (a degenerate page box, a system whose bounds collapse
 * under normalization). `null` means "fall back to today's whole-chart VLM path", never
 * "gate" — we only ever gate on what was positively observed.
 *
 * `absNumber` is dense over VISIBLE bars in reading order (page → yTop → xStart), which
 * is exactly what `barsInOrder` re-derives during validation. Multirests do NOT advance
 * it; they set `measures` instead.
 */
export function buildMeasuredPayload(pages: MeasuredPageResult[]): MeasuredPayload | null {
  const payload: MeasuredPayload = { pages: [], systems: [], bars: [] };
  let sysN = 0;
  let barN = 0;

  for (const { measurement: m, complete } of pages) {
    payload.pages.push({ pageNumber: m.pageNumber, classification: m.classification, complete });
    if (!(m.pageWidth > 0) || !(m.pageHeight > 0)) return null;

    for (const s of m.systems) {
      const id = `s${++sysN}`;
      const xStart = clamp01(s.x0 / m.pageWidth);
      const xEnd = clamp01(s.x1 / m.pageWidth);
      // The band is the STAFF's own extent — the top and bottom staff lines — not a
      // padded guess at where the system "feels" like it reaches. Nearest-system
      // hit-testing already tolerates a tight band, and padding would be inventing
      // geometry in the one module whose whole purpose is not to.
      const yTop = clamp01(s.yTop / m.pageHeight);
      const yBottom = clamp01(s.yBot / m.pageHeight);
      if (!(xStart < xEnd) || !(yTop < yBottom)) return null;

      const measures = attributeMultirests(s);
      const ok = measures !== null && measuresAgreeWithPrinted(s, measures);
      // Attribution failed ⇒ the geometry and the printed numbers disagree about this
      // system. That is what `uncertain` MEANS, and it keeps the system (its bars are
      // still right) while refusing to assert a musical count we could not place.
      payload.systems.push({
        id,
        page: m.pageNumber,
        yTop,
        yBottom,
        xStart,
        xEnd,
        verdict: ok ? s.verdict : 'uncertain',
      });

      for (let i = 0; i < s.bars.length; i++) {
        const b = s.bars[i];
        // Clamp into the parent system: `isValidCalibration` requires every bar to fit
        // inside its system's x-bounds, and a barline drawn a hair past the staff rule
        // would otherwise invalidate the whole calibration.
        const bxStart = Math.max(xStart, clamp01(b.xStart / m.pageWidth));
        const bxEnd = Math.min(xEnd, clamp01(b.xEnd / m.pageWidth));
        if (!(bxStart < bxEnd)) return null;
        const count = ok ? measures![i] : 1;
        payload.bars.push({
          id: `b${++barN}`,
          systemId: id,
          xStart: bxStart,
          xEnd: bxEnd,
          absNumber: barN,
          sectionId: null,
          ...(count > 1 ? { measures: count } : {}),
        });
      }
    }
  }

  return payload;
}

/**
 * What the server should DO with a payload. One fold over the per-page reports, and the
 * only place that decision is made.
 *
 * | every page | outcome |
 * |---|---|
 * | `not-notation` ∧ complete | **`gated`** — the third never-gate. No VLM, no overlay. |
 * | `notation` ∧ complete (and something was measured) | **`measured`** — install it. |
 * | anything else | **`fallback`** — today's whole-chart VLM path, unchanged. |
 *
 * ★ Whole-CHART granularity is deliberate and measured: across the 87-file corpus, ZERO
 * files mix classifications — 62 are notation throughout, 23 not-notation throughout, 2
 * raster throughout. So "any page we cannot measure cleanly sends the whole chart to the
 * VLM" costs nothing today, and it avoids shipping a half-measured overlay whose missing
 * pages would look like a bug rather than a fallback.
 *
 * ★ `raster` and incomplete pages never gate. A never-gate is unappealable, so it fires
 * only on evidence of ABSENCE (staves were looked for, in geometry we could fully see,
 * and were not there) — never on absence of EVIDENCE.
 */
export type MeasuredDisposition = 'gated' | 'measured' | 'fallback';

export function measuredDisposition(payload: MeasuredPayload): MeasuredDisposition {
  const pages = payload.pages;
  if (pages.length === 0) return 'fallback';
  if (pages.every((p) => p.classification === 'not-notation' && p.complete)) return 'gated';
  if (pages.every((p) => p.classification === 'notation' && p.complete) && payload.systems.length > 0) {
    return 'measured';
  }
  return 'fallback';
}

/** Untrusted-boundary shape check for the POSTed payload. */
export function isValidMeasuredPayload(p: unknown): p is MeasuredPayload {
  if (!p || typeof p !== 'object') return false;
  const m = p as Record<string, unknown>;
  if (!Array.isArray(m.pages) || m.pages.length === 0) return false;
  for (let i = 0; i < m.pages.length; i++) {
    const pg = m.pages[i] as Record<string, unknown> | null;
    if (!pg || typeof pg !== 'object') return false;
    // Dense 1..n: the reports describe every page of one document, in order. A sparse
    // or reordered list would make the per-page fold below describe a different chart.
    if (pg.pageNumber !== i + 1) return false;
    if (pg.classification !== 'notation' && pg.classification !== 'not-notation' && pg.classification !== 'raster') {
      return false;
    }
    if (typeof pg.complete !== 'boolean') return false;
  }
  if (!Array.isArray(m.systems) || !m.systems.every(isValidSystem)) return false;
  if (!Array.isArray(m.bars) || !m.bars.every(isValidBar)) return false;
  return true;
}

/**
 * The measured half installed beside the VLM's semantic half.
 *
 * Measurement replaces VLM GEOMETRY, not VLM SEMANTICS: `sections` come from the vision
 * call and are passed through untouched, because `canVerify` requires at least one
 * labeled section and a measurement-only calibration would leave the owner at
 * `unverifiable / no-sections` — a regression against today.
 *
 * No `roadmap`: this path only runs when the VLM produced none. Roadmap markers bind
 * through the VLM's OWN bar indices, so copying them across measured bars would either
 * fail to resolve or — worse — bind a repeat to the wrong bar and pass validation.
 *
 * No `confidence` either: a measured system carries a `verdict`, which is the evidence
 * that actually exists for it. Absent confidence is valid, and inventing a number to
 * fill the field would be a lie the review sheet then ranks by.
 */
export function installMeasured(
  sections: SectionAnchor[],
  payload: MeasuredPayload,
): ChartCalibration {
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    status: 'draft',
    sections,
    systems: payload.systems,
    bars: payload.bars,
  };
}
