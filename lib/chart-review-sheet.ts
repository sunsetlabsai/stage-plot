// ── The review sheet's decisions, without the React (docs/design-chart-review-step.md §C3) ──
//
// Everything the sheet has to DECIDE lives here: which candidate splits to offer, whether
// two of them are really the same picture, and what to say about a count. The component
// renders; this module chooses. Same split as `chart-review.ts` under the calibrate
// overlay, and for the same reason — the choosing is testable under env=node, the
// rendering needs jsdom and a PDF.

import type { Bar, System } from './types';
import type { MeasuredSystem } from './chart-measure';
import { resegment, type ResegmentFailure } from './chart-resegment';

/**
 * Two splits are the same picture when every edge agrees to within this fraction of the
 * system width. The owner is being asked "which of these looks right", so options that
 * differ by a third of a percent of the staff are not two options — they are one option
 * shown twice, and offering both makes the sheet look broken.
 *
 * Not a measurement tolerance: nothing downstream consumes it, and it never widens or
 * narrows any geometry. It only decides whether two pictures are visibly distinct.
 */
export const CANDIDATE_DEDUPE_TOL = 0.004;

/**
 * Where a candidate picture came from.
 *
 * ⚠ There is deliberately no `'vlm'` member, and its absence is the point. §The interaction
 * lists measured / VLM / printed-number-implied as the three sources, but a VLM split is
 * NOT CONSTRUCTIBLE at review time: the converter persists exactly one split per system,
 * so on a VLM-path chart the stored split IS the VLM's and arrives here as `'current'`.
 * Nothing second-guesses it because nothing second opinion was ever written down.
 *
 * A `'vlm'` member no emitter can produce is the same dead-enum shape that hid the missing
 * printed candidate for a whole review round (`'printed'` sat unused in this union while
 * `buildCandidates` never built one). So it is deleted rather than reserved.
 */
export type CandidateSource = 'measured' | 'printed' | 'current';

export interface Candidate {
  /** Right edge of each span, normalized [0,1], reading order. `length` is the bar count. */
  xs: number[];
  /**
   * Where this picture came from. Used for ordering and dedupe-merging, and `'printed'`
   * alone reaches the owner — as a plain-words line under the option, because when two
   * pictures are both plausible "this is what the numbers printed on your chart say"
   * is the one piece of provenance that helps a non-reader choose between them.
   */
  sources: CandidateSource[];
}

function sameSplit(a: number[], b: number[]): boolean {
  return (
    a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= CANDIDATE_DEDUPE_TOL)
  );
}

/**
 * Deduplicate candidate splits, preserving order and merging the provenance of any that
 * collapse. Two agreeing sources become ONE option, per §The interaction.
 */
export function dedupeCandidates(cands: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of cands) {
    if (c.xs.length === 0) continue;
    const hit = out.find((o) => sameSplit(o.xs, c.xs));
    if (hit) {
      for (const s of c.sources) if (!hit.sources.includes(s)) hit.sources.push(s);
    } else out.push({ xs: [...c.xs], sources: [...c.sources] });
  }
  // Never more than three, per the frozen spec — a fourth picture is not a choice a
  // non-reader can make, and the count fallback exists for exactly that case.
  return out.slice(0, 3);
}

/**
 * The one line of provenance an option is allowed to show, or null.
 *
 * Only the printed candidate gets one. "Measured" and "what's saved now" are machine
 * biography — a non-reader cannot act on either, and §Principles says every question is
 * about the picture. But when two pictures are both plausible, *the numbers printed on
 * your own chart say this one* is a fact the owner can check with their eyes, on paper,
 * without knowing anything about the engine.
 */
export function candidateNote(c: Candidate): string | null {
  return c.sources.includes('printed') ? 'Matches the numbers printed on your chart' : null;
}

/** The split currently stored for a system, as a candidate. */
export function currentSplit(bars: Bar[], systemId: string): Candidate {
  const xs = bars
    .filter((b) => b.systemId === systemId)
    .sort((a, b) => a.xStart - b.xStart)
    .map((b) => b.xEnd);
  return { xs, sources: ['current'] };
}

/** The page facts a candidate build needs. Both come from one `PageMeasurement`. */
export interface CandidatePage {
  pageWidth: number;
  /** The page's modal thin-barline width — what the printed candidate's re-segment scores by. */
  modalWidth: number;
}

/**
 * What the sheet offers for one system.
 *
 * Three sources, in the order §C3 lists them: the stored split, the printed-number-implied
 * split, the freshly measured split. `dedupeCandidates` collapses any that agree, so on a
 * healthy system this returns ONE option and the sheet becomes "is this right? → no → how
 * many bars?".
 *
 * ★ THE PRINTED CANDIDATE IS THE WHOLE REASON THE PICKER EARNS ITS PLACE, and it was
 * missing until Codex M1 (#184). `expectedSpans` is what the chart's own printed measure
 * numbers say this line should hold, and `verdict: 'uncertain'` is assigned by
 * `measurePage` precisely when it DISAGREES with the measured span count
 * (`chart-measure.ts:612`). So on the exact system the sheet was built for, the stored and
 * the measured splits are the same known-wrong picture, and without this the sheet offered
 * "Yes, 4 bars" as its only answer and could stamp `confirmed` on it permanently. The
 * disagreeing count is not a guess — it is read off the chart — and `resegment` turns it
 * into geometry made entirely of barlines the engine actually saw, or refuses.
 *
 * A refusal is silent here. The printed numbers disagreeing does not entitle us to a
 * picture; when the evidence cannot support that count the count fallback is the honest
 * route, and it is one tap away.
 */
export function buildCandidates(
  storedBars: Bar[],
  system: System,
  measured?: MeasuredSystem | null,
  page?: CandidatePage | null,
): Candidate[] {
  const cands: Candidate[] = [currentSplit(storedBars, system.id)];
  if (measured && page && page.pageWidth > 0) {
    const { expectedSpans } = measured;
    if (expectedSpans !== null && expectedSpans !== measured.spans) {
      const printed = proposeFromCount(measured, page.pageWidth, page.modalWidth, expectedSpans);
      if (printed.kind === 'ok') cands.push({ xs: printed.xs, sources: ['printed'] });
    }
    const xs = measured.bars.map((b) => b.xEnd / page.pageWidth);
    if (xs.length) cands.push({ xs, sources: ['measured'] });
  }
  return dedupeCandidates(cands);
}

/**
 * Find the freshly-measured system that corresponds to a STORED one.
 *
 * By vertical overlap, never by index. The stored systems and a fresh measurement are two
 * independent lists: a chart hand-edited since conversion can have systems added, deleted
 * or resized, so position `i` in one is not position `i` in the other. Matching by index
 * would hand the sheet another line's barlines and ask the owner to confirm it.
 *
 * Returns null when nothing overlaps — the honest answer, which routes the count fallback
 * to a refusal rather than to some other line's geometry.
 */
export function matchMeasuredSystem(
  system: System,
  measured: MeasuredSystem[],
  pageHeight: number,
): MeasuredSystem | null {
  if (!(pageHeight > 0)) return null;
  let best: MeasuredSystem | null = null;
  let bestOverlap = 0;
  for (const m of measured) {
    const top = Math.max(system.yTop, m.yTop / pageHeight);
    const bot = Math.min(system.yBottom, m.yBot / pageHeight);
    const overlap = bot - top;
    if (overlap > 0 && overlap > bestOverlap) {
      best = m;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Convert a confirmed split (normalized page x, one right edge per span) into page-space
 * bars, so multirest counts can be re-attributed against the geometry the human chose.
 */
export function splitToPageBars(
  system: System,
  xs: number[],
  pageWidth: number,
): { xStart: number; xEnd: number }[] {
  let left = system.xStart * pageWidth;
  return xs.map((x) => {
    const bar = { xStart: left, xEnd: x * pageWidth };
    left = x * pageWidth;
    return bar;
  });
}

export type CountOutcome =
  | { kind: 'ok'; xs: number[]; surplus: number }
  | { kind: 'refused'; reason: ResegmentFailure; available: number };

/**
 * Turn the owner's bar count into a proposed split, or a refusal.
 *
 * `surplus` is how many measured barlines the answer leaves unused, and it is the whole
 * reason this returns a struct rather than an array. Measured on the corpus: an OVERCOUNT
 * is structurally impossible (N+1 refused 464/464) while an UNDERCOUNT is always accepted
 * (N−1 accepted 464/464), because dropping a real barline still leaves a split made
 * entirely of real barlines. No arithmetic downstream can catch it. So the sheet must say
 * so and show the picture — `surplus > 0` is what it says it with.
 */
export function proposeFromCount(
  measured: MeasuredSystem,
  pageWidth: number,
  modalWidth: number,
  n: number,
): CountOutcome {
  const r = resegment(
    {
      clusters: measured.clusters,
      lineStartRepeat: measured.lineStartRepeat,
      x0: measured.x0,
      x1: measured.x1,
      modalWidth,
    },
    n,
  );
  if (!r.ok || !r.bars) {
    return { kind: 'refused', reason: r.reason ?? 'insufficient-evidence', available: r.available ?? 0 };
  }
  return {
    kind: 'ok',
    xs: r.bars.map((b) => b.xEnd / pageWidth),
    surplus: Math.max(0, (r.available ?? 0) - n),
  };
}

/**
 * The sentence shown under a proposed count, or null when there is nothing to say.
 *
 * Plain words, no notation vocabulary — the owner is counting shapes, not reading music.
 * It WARNS rather than blocks: the owner may be right that one of those verticals is not
 * a real bar, and §Principles says the step is never mandatory.
 */
export function surplusWarning(surplus: number, n: number): string | null {
  if (surplus <= 0) return null;
  const seen = n + surplus;
  return `We can see ${seen} barlines in this line, not ${n}. That's fine if one of them isn't a real bar — check the picture matches what you meant.`;
}

/** Why a refusal happened, in the owner's terms. Never blames their count. */
export function refusalMessage(reason: ResegmentFailure, available: number): string {
  switch (reason) {
    case 'insufficient-evidence':
      return `We can only see ${available} barline${available === 1 ? '' : 's'} here, so we can't place the rest. Setting them by hand keeps the overlay honest.`;
    case 'out-of-staff':
    case 'degenerate-span':
      return `The barlines we found here don't line up with this line, so we won't guess where the bars go.`;
    case 'invalid-count':
      return `That isn't a number of bars we can use.`;
  }
}
