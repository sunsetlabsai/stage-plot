'use client';

import type { PerformReadiness, PerformReadinessView } from '@/lib/chart-calibration';

// ── Perform readiness: the can't-Perform/Conduct strip (presentational) ───────
//
// (design-perform-readiness.md §4). Mirrors ConductorCluster: a PURE component —
// render + one callback, no session/PDF/validity — so it's jsdom-testable with no
// chart render. It mounts in the Perform transport hole (page.tsx `: null`, when
// `!barMode`) and surfaces WHY there's no bar transport plus the owner's one next
// step. It NEVER re-decides the gates; it only renders the pure diagnosis (`view`)
// and routes the owner to the right calibrate tool.

export type CalTool = 'sections' | 'bars' | 'roadmap'; // matches page.tsx calTool union

export interface PerformReadinessStripProps {
  view: PerformReadinessView;
  // NOT isOwner: calibratable = isOwner && has a calibrationChartId. A Drive-chart
  // owner is isOwner but NOT calibratable — keying on isOwner would offer a
  // Calibrate button that can't do anything (§4.1).
  calibratable: boolean;
  onCalibrate: (tool: CalTool) => void; // enter Calibrate on the RIGHT repair surface
}

interface Line {
  text: string;
  cta?: { label: string; tool: CalTool };
}

// The per-state copy. Returns null when the strip renders nothing (loading,
// bar-ready, and the "—" non-calibratable rows that can't actually reach a
// non-owner by construction — §4 †).
function lineFor(view: PerformReadinessView, calibratable: boolean): Line | null {
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
            ? "This chart's map was made by a newer version of the app — update to edit it."
            : "This chart's stored map is corrupt.",
      };
    case 'ready':
      return readyLine(view.readiness, calibratable);
  }
}

function readyLine(readiness: PerformReadiness, calibratable: boolean): Line | null {
  switch (readiness.state) {
    case 'bar-ready':
      return null; // transport / Conduct already shows
    case 'section-only':
      // Two orthogonal axes: section seek works for ANY viewer; only "Add bars"
      // is calibratable-gated.
      return calibratable
        ? { text: 'Tap a section to seek · Add bars to Conduct.', cta: { label: 'Add bars', tool: 'bars' } }
        : { text: 'Tap a section to seek.' };
    case 'none':
      return calibratable
        ? { text: 'No chart map for these bytes — Calibrate to set up Perform.', cta: { label: 'Calibrate', tool: 'sections' } }
        : null;
    case 'verifiable':
      return calibratable
        ? { text: 'Draft — Verify to perform.', cta: { label: 'Calibrate', tool: 'sections' } }
        : null;
    case 'unverifiable':
      if (!calibratable) return null; // never reaches a non-owner (§4 †)
      switch (readiness.reason) {
        case 'no-sections':
          return { text: 'Add a section to verify this chart.', cta: { label: 'Calibrate', tool: 'sections' } };
        case 'unlabeled-section':
          return { text: 'Label every section to verify.', cta: { label: 'Calibrate', tool: 'sections' } };
        case 'roadmap-unresolved':
          return { text: "The roadmap doesn't resolve — fix it in Calibrate.", cta: { label: 'Calibrate', tool: 'roadmap' } };
      }
  }
}

export default function PerformReadinessStrip({
  view,
  calibratable,
  onCalibrate,
}: PerformReadinessStripProps) {
  const line = lineFor(view, calibratable);
  if (!line) return null;

  return (
    <div className="bg-zinc-900 border-t border-zinc-800 text-xs">
      <div className="flex items-center justify-center gap-3 px-3 py-2 text-center">
        <span className="text-zinc-400">{line.text}</span>
        {line.cta && (
          <button
            onClick={() => onCalibrate(line.cta!.tool)}
            className="px-3 py-1 rounded bg-zinc-800 text-zinc-200 font-bold hover:bg-zinc-700"
          >
            {line.cta.label}
          </button>
        )}
      </div>
    </div>
  );
}
