'use client';

import { useState } from 'react';
import type { ExitPolicy } from '@/lib/roadmap-vm';
import type { JumpTarget, RedirectOption } from '@/lib/conductor-targets';
import type { ClockRung } from '@/lib/conductor-clock';
import type { TempoDetectorStatus } from '@/lib/use-tempo-detector';

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

// ── 3b chunk 5: the header's relay facet ──────────────────────────────────────
// null/undefined = relay unconfigured → the shipped "Local MD mode" header,
// byte-for-byte. The cluster itself renders only when this device's LOCAL
// session drives (role local or writer) — a follower gets RelayStrip instead.
export type ClusterRelayState =
  | { kind: 'available'; onGoLive: () => void } // configured, not connected
  | { kind: 'connecting' } // socket up-ing / reconnecting — still conducting locally
  | { kind: 'live'; code: string; onShowQr: () => void }; // we hold the baton

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
  // 5b chunk 2 — the static-BPM motion driver surface. clockOn is the per-session
  // opt-in (default OFF = chunk-4 go-tap floor). rung is the resolved motion tier
  // ('static-bpm' ⇒ "fixed tempo" dead-reckon; 'manual' ⇒ honest manual floor).
  // stalled means owed ≥ 2 bars at a tick — the loop suspended to avoid a fast-forward;
  // a manual move or "On the 1" clears it.
  clockOn: boolean;
  rung: ClockRung;
  stalled: boolean;
  holding: boolean; // vm.holding != null — surfaces the §3.5 "release to fire" copy
  canArmNextSection: boolean; // §4 — a next-section boundary exists ahead (else disable)
  // 5b chunk 4a — the tempo detector's SHADOW readout. The mic is an independent switch;
  // when running, the detected-vs-stated comparison lets the MD judge the source quality
  // before opting any audio into driving (4b). This row OBSERVES and drives nothing.
  micStatus: TempoDetectorStatus;
  shadow: { detectedBpm: number; confidence: number; statedBpm: number | null } | null;
  validationLogCount: number;
  // 3b chunk 5: relay facet for the header (absent = shipped single-device header).
  relay?: ClusterRelayState | null;
  onEnableMic: () => void; // originates from this click (the iOS gesture requirement)
  onDisableMic: () => void;
  onCopyLog: () => void;
  onClearLog: () => void;
  onAdvance: () => void;
  // 5b chunk 1 — the align / true-up tap. Seeds bar 1 at the start, re-zeros the timing
  // baseline mid-song. No visible motion effect until the chunk-2 driver consumes it.
  onAlign: () => void;
  onArm: (t: JumpTarget, exit?: ExitPolicy['kind'], fireAt?: 'next-bar' | 'next-section') => void;
  onCommit: () => void;
  onDisarm: () => void;
  onRedirect: (opt: RedirectOption) => void;
  onToggleAutoFire: () => void;
  onToggleClock: () => void; // 5b chunk 2 — flips clockOn (the static-BPM motion driver)
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
  clockOn,
  rung,
  stalled,
  holding,
  canArmNextSection,
  micStatus,
  shadow,
  validationLogCount,
  relay = null,
  onEnableMic,
  onDisableMic,
  onCopyLog,
  onClearLog,
  onAdvance,
  onAlign,
  onArm,
  onCommit,
  onDisarm,
  onRedirect,
  onToggleAutoFire,
  onToggleClock,
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
        {/* 3b chunk 5: the relay facet. LIVE = we hold the room's baton (emerald);
            connecting = honest amber while the MD keeps conducting locally (the
            self-drive floor — never an interruption); available = the Go-live
            door; unconfigured = the shipped header, byte-for-byte. */}
        {relay?.kind === 'live' ? (
          <span className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-wide text-emerald-400">Conducting</span>
            <span className="inline-flex items-center gap-1 rounded bg-emerald-950 border border-emerald-800 px-2 py-0.5 text-emerald-300">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> LIVE
            </span>
            <button
              onClick={relay.onShowQr}
              className="rounded px-2 py-0.5 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            >
              Room <span className="font-mono font-bold text-white tracking-widest">{relay.code}</span> &middot; QR
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-wide text-amber-400">
              Local MD mode
            </span>
            {relay?.kind === 'available' && (
              <button
                onClick={relay.onGoLive}
                className="rounded px-2 py-0.5 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              >
                Go live
              </button>
            )}
            {relay?.kind === 'connecting' && (
              <span className="inline-flex items-center gap-1 text-amber-500">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                relay connecting&hellip;
              </span>
            )}
          </span>
        )}
        <div className="flex items-center gap-3">
          {/* 5b chunk 2 — static-BPM clock opt-in toggle (default OFF = go-tap floor).
              When on, the resolved rung readout tells the MD what it is actually doing
              ('fixed tempo' = dead-reckon, 'manual' = no usable tempo source). */}
          <button
            onClick={onToggleClock}
            aria-pressed={clockOn}
            className={`rounded px-2 py-0.5 ${
              clockOn ? 'bg-sky-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            Clock: {clockOn ? 'on' : 'off'}
          </button>
          {clockOn && (
            <span className="text-zinc-400">
              {rung === 'static-bpm' ? 'fixed tempo' : 'manual'}
            </span>
          )}
          {/* §4 — auto-fire opt-in toggle (default OFF = go-tap floor). */}
          <button
            onClick={onToggleAutoFire}
            aria-pressed={autoFire}
            className={`rounded px-2 py-0.5 ${
              autoFire ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            Auto-fire: {autoFire ? 'on' : 'off'}
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
            {/* 5b chunk 1 — align / true-up: "we are on the 1, now." Disabled at song end
                (mirrors Advance, since seed-align IS the first advance). */}
            <button
              onClick={onAlign}
              disabled={!canAdvance}
              title="Tap on the downbeat to true up the clock"
              className="px-3 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              On the 1
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

          {/* 5b chunk 2 — the clock fell ≥2 bars behind in one tick and suspended rather
              than fast-forward. Honest readout; a manual move or "On the 1" re-anchors. */}
          {stalled && (
            <div className="px-3 py-1 text-center text-sky-400">
              Clock paused &mdash; tap &ldquo;On the 1&rdquo; to catch up
            </div>
          )}

          {/* 5b chunk 4a — tempo detection (SHADOW: observes the source, drives nothing).
              The mic toggle is independent of Clock/Auto-fire; when running it shows the
              detected-vs-stated comparison so the MD can judge the source before 4b. */}
          <div className="flex flex-wrap items-center justify-center gap-3 border-t border-zinc-800 px-3 py-1.5">
            <span className="uppercase tracking-wide text-zinc-500">Detection</span>
            {micStatus === 'running' ? (
              <button
                onClick={onDisableMic}
                aria-pressed
                className="rounded px-2 py-0.5 bg-purple-700 text-white"
              >
                Mic on
              </button>
            ) : (
              <button
                onClick={onEnableMic}
                disabled={micStatus === 'requesting'}
                className="rounded px-2 py-0.5 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {micStatus === 'requesting' ? 'Starting\u2026' : 'Enable mic'}
              </button>
            )}
            {micStatus === 'denied' && <span className="text-amber-500">mic blocked</span>}
            {micStatus === 'error' && <span className="text-amber-500">mic error</span>}
            {micStatus === 'running' &&
              (shadow ? (
                <span className="text-zinc-400">
                  stated <span className="text-zinc-200">{shadow.statedBpm ?? '\u2014'}</span>
                  {' \u00b7 '}detected{' '}
                  <span className="font-bold text-purple-300">{Math.round(shadow.detectedBpm)}</span>
                  <span className="text-zinc-500"> ({Math.round(shadow.confidence * 100)}%)</span>
                  <span className="text-zinc-600"> &middot; shadow</span>
                </span>
              ) : (
                <span className="text-zinc-500">listening&hellip;</span>
              ))}
            {micStatus === 'running' && (
              <span className="basis-full text-center text-xs text-zinc-600">
                measuring only &mdash; doesn&rsquo;t drive the chart yet
              </span>
            )}
            {validationLogCount > 0 && (
              <span className="flex items-center gap-2">
                <button onClick={onCopyLog} className="underline text-zinc-400 hover:text-white">
                  Copy log ({validationLogCount})
                </button>
                <button onClick={onClearLog} className="underline text-zinc-500 hover:text-white">
                  Clear
                </button>
              </span>
            )}
          </div>

          {ignored && (
            <div className="px-3 py-1 text-center text-amber-500">Not available right now</div>
          )}
        </>
      )}
    </div>
  );
}
