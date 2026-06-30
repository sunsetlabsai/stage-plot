'use client';

import { useState } from 'react';
import type { ExitPolicy } from '@/lib/roadmap-vm';
import type { JumpTarget, RedirectOption } from '@/lib/conductor-targets';

// ── Conductor authority, chunk 4: the MD-only Perform control cluster ─────────
//
// (design-conductor-chunk4-ui.md §3). A PURE presentational component: it renders
// exactly the targets/redirects the pure enumerators produced and fires callbacks —
// no session, no PDF, no validity logic (all of that lives in the hook + lib). This
// keeps it unit-testable in jsdom with no chart render. It is MD-only and labelled
// "Local MD mode" so it never implies relay authority over other players (D7) — there
// is no transport until 3b; this drives ONLY this device's local session.

function exitLabel(kind: ExitPolicy['kind']): string {
  return kind === 'alCoda' ? 'al Coda' : 'al Fine';
}

export interface ConductorClusterProps {
  active: boolean; // false while the async programHash is still resolving
  readout: { absNumber: number; passLabel: string | null } | null;
  armedSummary: { targetLabel: string; fireAtLabel: string } | null;
  targets: JumpTarget[];
  redirects: RedirectOption[];
  canAdvance: boolean; // false at song end (§3 guard)
  canArm: boolean; // false at song end (§3 guard)
  ignored: boolean; // last action was a dead tap — surface it honestly (D3)
  autoFire: boolean; // §3 opt-in auto-fire toggle (default OFF = chunk-4 go-tap floor)
  holding: boolean; // vm.holding != null — surfaces the §3.5 "release to fire" copy
  canArmNextSection: boolean; // §4 — a next-section boundary exists ahead (else disable)
  onAdvance: () => void;
  onArm: (t: JumpTarget, exit?: ExitPolicy['kind'], fireAt?: 'next-bar' | 'next-section') => void;
  onCommit: () => void;
  onDisarm: () => void;
  onRedirect: (opt: RedirectOption) => void;
  onToggleAutoFire: () => void;
  onStop: () => void;
}

export default function ConductorCluster({
  active,
  readout,
  armedSummary,
  targets,
  redirects,
  canAdvance,
  canArm,
  ignored,
  autoFire,
  holding,
  canArmNextSection,
  onAdvance,
  onArm,
  onCommit,
  onDisarm,
  onRedirect,
  onToggleAutoFire,
  onStop,
}: ConductorClusterProps) {
  const [picking, setPicking] = useState(false);
  // §3.1/§4 — the structural fire-at choice for the next arm. Default 'next-bar'
  // (chunk-4 behaviour). Forced back to 'next-bar' when no section boundary is ahead.
  const [fireAt, setFireAt] = useState<'next-bar' | 'next-section'>('next-bar');
  const effectiveFireAt = canArmNextSection ? fireAt : 'next-bar';

  return (
    <div className="bg-zinc-900 border-t border-zinc-800 text-xs">
      {/* Mode header — labelled "Local MD mode" (drives only THIS device, no relay). */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="font-bold uppercase tracking-wide text-amber-400">
          Local MD mode
        </span>
        <div className="flex items-center gap-3">
          {/* §4 — auto-fire opt-in toggle (default OFF = go-tap floor). */}
          <button
            onClick={onToggleAutoFire}
            aria-pressed={autoFire}
            className={`rounded px-2 py-0.5 ${
              autoFire ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            Auto-fire {autoFire ? 'on' : 'off'}
          </button>
          <button onClick={onStop} className="text-zinc-500 hover:text-white underline">
            Exit
          </button>
        </div>
      </div>

      {!active ? (
        <div className="px-3 py-2 text-center text-zinc-500">Starting&hellip;</div>
      ) : (
        <>
          {/* 1 — Transport readout + Advance */}
          <div className="flex items-center justify-center gap-3 py-1.5">
            <span className="text-zinc-400 min-w-[6rem] text-center">
              {readout ? (
                <>
                  Bar <span className="font-bold text-red-400">{readout.absNumber}</span>
                  {readout.passLabel && (
                    <span className="text-zinc-500"> &middot; {readout.passLabel}</span>
                  )}
                </>
              ) : (
                'Tap Advance to begin'
              )}
            </span>
            <button
              onClick={onAdvance}
              disabled={!canAdvance}
              className="px-3 py-1 rounded bg-red-600 text-white font-bold hover:bg-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Advance &rarr;
            </button>
          </div>

          {/* 2 — Change-marker: Arm → Go/Cancel */}
          <div className="border-t border-zinc-800 px-3 py-1.5">
            {armedSummary ? (
              <div className="flex items-center justify-center gap-3">
                <span className="text-zinc-400">
                  Change pending &rarr;{' '}
                  <span className="font-bold text-amber-300">{armedSummary.targetLabel}</span>
                  {/* §4 copy keys on the toggle + hold state. */}
                  <span className="text-zinc-500">
                    {autoFire
                      ? holding
                        ? ' · release to fire'
                        : ` · fires at bar ${armedSummary.fireAtLabel}`
                      : ` @ bar ${armedSummary.fireAtLabel} · tap Go`}
                  </span>
                </span>
                <button
                  onClick={onCommit}
                  className="px-3 py-1 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-500"
                >
                  Go
                </button>
                <button
                  onClick={onDisarm}
                  className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                >
                  Cancel
                </button>
              </div>
            ) : picking ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Arm a change to&hellip;</span>
                  <button
                    onClick={() => setPicking(false)}
                    className="text-zinc-500 hover:text-white underline"
                  >
                    close
                  </button>
                </div>
                {/* §4 — structural fire-at choice (never a raw count). Next section
                    disables when no boundary is ahead (vamping / last section). */}
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500">Fire at:</span>
                  <button
                    onClick={() => setFireAt('next-bar')}
                    aria-pressed={effectiveFireAt === 'next-bar'}
                    className={`px-2 py-0.5 rounded ${
                      effectiveFireAt === 'next-bar'
                        ? 'bg-amber-600 text-white'
                        : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                    }`}
                  >
                    Next bar
                  </button>
                  <button
                    onClick={() => setFireAt('next-section')}
                    disabled={!canArmNextSection}
                    aria-pressed={effectiveFireAt === 'next-section'}
                    title={canArmNextSection ? undefined : 'no section ahead'}
                    className={`px-2 py-0.5 rounded disabled:opacity-30 disabled:cursor-not-allowed ${
                      effectiveFireAt === 'next-section'
                        ? 'bg-amber-600 text-white'
                        : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                    }`}
                  >
                    Next section
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {targets.map((t) => (
                    // Composite key: armableTargets can legally emit several targets for
                    // one bar (e.g. Coda + a section head + Repeat all on bar 1), so barId
                    // alone is not unique.
                    <span key={`${t.kind}:${t.barId}:${t.label}`} className="inline-flex items-center gap-1">
                      <button
                        onClick={() => {
                          onArm(t, undefined, effectiveFireAt);
                          setPicking(false);
                        }}
                        className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                      >
                        {t.label}
                      </button>
                      {t.exitOptions.map((ex) => (
                        <button
                          key={ex}
                          onClick={() => {
                            onArm(t, ex, effectiveFireAt);
                            setPicking(false);
                          }}
                          className="px-1.5 py-1 rounded bg-zinc-800 text-amber-300 hover:bg-zinc-700"
                        >
                          {exitLabel(ex)}
                        </button>
                      ))}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center">
                <button
                  onClick={() => setPicking(true)}
                  disabled={!canArm}
                  className="px-3 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Arm change&hellip;
                </button>
              </div>
            )}
          </div>

          {/* 3 — Immediate redirects (only the applicable ones — no-ops are absent) */}
          {redirects.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-1 border-t border-zinc-800 px-3 py-1.5">
              {redirects.map((opt, i) => (
                <button
                  key={`${opt.label}-${i}`}
                  onClick={() => onRedirect(opt)}
                  className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {ignored && (
            <div className="px-3 py-1 text-center text-amber-500">Not available right now</div>
          )}
        </>
      )}
    </div>
  );
}
