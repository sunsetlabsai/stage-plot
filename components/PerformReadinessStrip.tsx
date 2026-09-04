'use client';

import type { PerformReadiness, PerformReadinessView } from '@/lib/chart-calibration';
import type { OverlaySkipReason } from '@/lib/chart-converter';

// ── Perform readiness: the can't-Perform/Conduct strip (presentational) ───────
//
// (design-perform-readiness.md §4). Mirrors ConductorCluster: a PURE component —
// render + one callback, no session/PDF/validity — so it's jsdom-testable with no
// chart render. It mounts in the Perform transport hole (page.tsx `: null`, when
// `!barMode`) and surfaces WHY there's no bar transport plus the owner's one next
// step. It NEVER re-decides the gates; it only renders the pure diagnosis (`view`)
// and routes the owner to the right calibrate tool.

export type CalTool = 'sections' | 'bars' | 'roadmap'; // matches page.tsx calTool union

// Where the owner-demand conversion trigger lives (backlog-charting.md §Ruled
// 2026-09-02 left placement open; decided here). This is the only moment the app
// KNOWS the owner wants this chart to perform: they have it open in Perform mode
// and we are telling them it can't. Upload can't be the trigger (it's a reflex,
// not a demand) and "first conductor open" can't either — Conduct only renders
// under `barMode`, which already presupposes the overlay this would build.
//
// 'gated' is the third never-gate answering (`not_notation`), and it belongs HERE rather
// than beside `skipReason`: the row-level gates are known before the owner touches
// anything, while this one is only knowable by measuring the bytes — i.e. it is an
// outcome of a build attempt, which is exactly what this type models. It is still a
// never-gate: no retry CTA is offered, because the answer is deterministic for these
// bytes and a "Try again" that always loses is a lie.
export type ConvertState = 'idle' | 'running' | 'error' | 'gated';

export interface PerformReadinessStripProps {
  view: PerformReadinessView;
  // NOT isOwner: calibratable = isOwner && has a calibrationChartId. A Drive-chart
  // owner is isOwner but NOT calibratable — keying on isOwner would offer a
  // Calibrate button that can't do anything (§4.1).
  calibratable: boolean;
  onCalibrate: (tool: CalTool) => void; // enter Calibrate on the RIGHT repair surface
  // WHY this chart may never be offered an overlay, or null if it may be. Decided
  // by `overlaySkipReason` in page.tsx and arriving already-answered — the strip
  // never re-decides a gate, it only renders one.
  //
  // This carries the REASON rather than a boolean on purpose. Collapsed to
  // `convertible: boolean`, every gated chart rendered the same generic "No overlay
  // for these bytes", which reads as a failure the owner might retry — it never said
  // a decision had been made, let alone which one. The two reasons are different
  // KINDS of thing (`authored` is a fact about the row; `lyrics` is a classification
  // off a column that can be wrong), and telling them apart is the whole point.
  //
  // A gated chart still gets the hand-calibrate CTA: gated means "we won't spend AI
  // on it", never "you can't set it up".
  skipReason: OverlaySkipReason | null;
  convertState: ConvertState; // only meaningful under readiness `none`
  onBuildOverlay: () => void;
}

// One CTA per line, always. A second button here would compete with the header's
// Calibrate toggle, which is already visible in exactly these states.
type Action = { kind: 'calibrate'; label: string; tool: CalTool } | { kind: 'build'; label: string };

interface Line {
  text: string;
  cta?: Action;
}

// The per-state copy. Returns null when the strip renders nothing (loading,
// bar-ready, and the "—" non-calibratable rows that can't actually reach a
// non-owner by construction — §4 †).
// What the owner is told when a never-gate fired. One line each, and each one names
// the property of THIS chart that decided it — a gate the owner cannot see is
// indistinguishable from a bug.
const SKIP_COPY: Record<OverlaySkipReason, string> = {
  authored: "Built in ShowRunr — we don't generate an overlay for these. Calibrate to set up Perform.",
  lyrics: 'Lyrics sheet — no bars to detect. Calibrate to set up Perform.',
};

function lineFor(
  view: PerformReadinessView,
  calibratable: boolean,
  skipReason: OverlaySkipReason | null,
  convertState: ConvertState,
): Line | null {
  switch (view.phase) {
    case 'loading':
      return null; // no flash while the fetch is in flight
    case 'load-error':
      // Covers a failed PDF fetch AND a failed calibration fetch. Honest, no dead
      // button — reload is the recourse; never a Calibrate CTA that would Save-no-op.
      return { text: "Couldn't load this chart." };
    case 'unreadable':
      // Owner-only by construction (§3.2). Honest dead-stop, NO innocent Calibrate
      // CTA (that's the clobber this fix exists to prevent — D6).
      return {
        text:
          view.reason === 'unsupported-schema'
            ? "This chart's overlay was made by a newer version of the app — update to edit it."
            : "This chart's stored overlay is corrupt.",
      };
    case 'ready':
      return readyLine(view.readiness, calibratable, skipReason, convertState);
  }
}

function readyLine(
  readiness: PerformReadiness,
  calibratable: boolean,
  skipReason: OverlaySkipReason | null,
  convertState: ConvertState,
): Line | null {
  switch (readiness.state) {
    case 'bar-ready':
      return null; // transport / Conduct already shows
    case 'section-only':
      // Two orthogonal axes: section seek works for ANY viewer; only "Add bars"
      // is calibratable-gated.
      return calibratable
        ? { text: 'Tap a section to seek · Add bars to Conduct.', cta: { kind: 'calibrate', label: 'Add bars', tool: 'bars' } }
        : { text: 'Tap a section to seek.' };
    case 'none':
      if (!calibratable) return null;
      // Gated charts (lyrics sheets, builder charts) keep the hand-calibrate
      // route — we decline to spend AI, not to let the owner set it up. The line
      // states WHICH gate fired; the CTA is the same either way.
      if (skipReason) {
        return { text: SKIP_COPY[skipReason], cta: { kind: 'calibrate', label: 'Calibrate', tool: 'sections' } };
      }
      switch (convertState) {
        case 'running':
          // No CTA while it runs: the only honest actions would be cancel (the
          // route has no cancel) or a second Build (which the route would
          // no-op as `exists` anyway).
          return { text: 'Building overlay… this takes a few seconds.' };
        case 'error':
          // Never a dead end — retry is one tap, Calibrate is one tap in the
          // header. A failed build leaves the chart exactly as it was.
          return { text: "Couldn't build an overlay for this chart.", cta: { kind: 'build', label: 'Try again' } };
        case 'gated':
          // We looked inside the PDF and found no staves anywhere, in geometry we could
          // fully observe. Names the property of THIS chart that decided it, like the
          // other two gates — and keeps the hand-calibrate route, because gated means
          // "we won't spend AI on it", never "you can't set it up".
          return {
            text: 'No staves found on any page — nothing to detect. Calibrate to set up Perform.',
            cta: { kind: 'calibrate', label: 'Calibrate', tool: 'sections' },
          };
        case 'idle':
          return { text: 'No overlay for these bytes.', cta: { kind: 'build', label: 'Build overlay' } };
      }
    case 'verifiable':
      return calibratable
        ? { text: 'Draft — Verify to perform.', cta: { kind: 'calibrate', label: 'Calibrate', tool: 'sections' } }
        : null;
    case 'unverifiable':
      if (!calibratable) return null; // never reaches a non-owner (§4 †)
      switch (readiness.reason) {
        case 'no-sections':
          return { text: 'Add a section to verify this chart.', cta: { kind: 'calibrate', label: 'Calibrate', tool: 'sections' } };
        case 'unlabeled-section':
          return { text: 'Label every section to verify.', cta: { kind: 'calibrate', label: 'Calibrate', tool: 'sections' } };
        case 'roadmap-unresolved':
          return { text: "The roadmap doesn't resolve — fix it in Calibrate.", cta: { kind: 'calibrate', label: 'Calibrate', tool: 'roadmap' } };
      }
  }
}

export default function PerformReadinessStrip({
  view,
  calibratable,
  onCalibrate,
  skipReason,
  convertState,
  onBuildOverlay,
}: PerformReadinessStripProps) {
  const line = lineFor(view, calibratable, skipReason, convertState);
  if (!line) return null;
  const cta = line.cta;

  return (
    <div className="bg-zinc-900 border-t border-zinc-800 text-xs">
      <div className="flex items-center justify-center gap-3 px-3 py-2 text-center">
        <span className="text-zinc-400">{line.text}</span>
        {cta && (
          <button
            onClick={() => (cta.kind === 'build' ? onBuildOverlay() : onCalibrate(cta.tool))}
            className="px-3 py-1 rounded bg-zinc-800 text-zinc-200 font-bold hover:bg-zinc-700"
          >
            {cta.label}
          </button>
        )}
      </div>
    </div>
  );
}
