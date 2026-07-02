'use client';

import { useState } from 'react';

// ── Conductor 3b chunk 5: the follower strip (design-conductor-3b §10-5) ──────
//
// The follower's counterpart to ConductorCluster: ONE slim strip in the same
// bottom slot, PURE presentational (facts in, callbacks out — the hook and the
// page own all routing/authority). Renders exactly one state, in honesty-first
// priority order:
//
//   connecting → conductor-lost (+ in-place take-baton confirm) → waiting
//   (no session announced) → chart mismatch → mirroring ("X is conducting").
//
// There are deliberately NO transport controls here — with a relay bound and
// this device a follower, the wire is the session's one writer (chunk-4 hard
// gate); the strip only ever offers Leave and the claim affordances.

export interface RelayStripProps {
  status: 'connecting' | 'joined';
  conductorLost: boolean; // §4.2 orphan honesty
  conductorLabel: string | null; // §4.3 attribution; null = unknown (never invent a name)
  canClaim: boolean; // follower && no writer && a chart is loaded to conduct
  // The room has no announced session yet (doc §4: "waiting for a conductor").
  waiting: boolean;
  // The room's session ≠ this device's chart (identity is the full SessionKey).
  chartMismatch: boolean;
  // Resolved by the page: the mirrored chart's song title (mirroring line) or the
  // room's chart when we can name it (mismatch line). null = can't name it honestly.
  songTitle: string | null;
  readout: { absNumber: number; passLabel: string | null } | null;
  onTakeBaton: () => void; // requestClaim — relay arbitration answers (§4.1)
  onLeave: () => void;
}

export default function RelayStrip({
  status,
  conductorLost,
  conductorLabel,
  canClaim,
  waiting,
  chartMismatch,
  songTitle,
  readout,
  onTakeBaton,
  onLeave,
}: RelayStripProps) {
  // In-place confirm (no modal mid-song). Reset the moment the lost state
  // resolves (render-phase derived-state reset — the documented React pattern),
  // so a stale confirm can never pre-arm a LATER orphan.
  const [confirming, setConfirming] = useState(false);
  if (confirming && !(status === 'joined' && conductorLost)) setConfirming(false);

  const leave = (
    <button onClick={onLeave} className="text-zinc-500 underline hover:text-white">
      Leave
    </button>
  );

  let body: React.ReactNode;
  if (status === 'connecting') {
    body = (
      <>
        <span className="flex items-center gap-2 text-zinc-400">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
          Joining the room&hellip;
        </span>
        {leave}
      </>
    );
  } else if (conductorLost) {
    // A denied/raced claim needs no error toast: the relay's `writer` frame
    // flips conductorLost off and the attribution line IS the answer.
    body = confirming ? (
      <>
        <span className="text-amber-200">
          Take over as conductor? Everyone follows <span className="font-bold text-white">this device</span>.
        </span>
        <span className="flex items-center gap-2">
          <button
            onClick={() => {
              setConfirming(false);
              onTakeBaton();
            }}
            className="px-3 py-1 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-500"
          >
            Take it
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            Cancel
          </button>
        </span>
      </>
    ) : (
      <>
        <span className="flex items-center gap-2 text-amber-300">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          Conductor lost &mdash; you&rsquo;re on your own chart for now
        </span>
        <span className="flex items-center gap-2">
          {canClaim && (
            <button
              onClick={() => setConfirming(true)}
              className="px-3 py-1 rounded bg-amber-600 text-white font-bold hover:bg-amber-500"
            >
              Take the baton
            </button>
          )}
          {leave}
        </span>
      </>
    );
  } else if (waiting) {
    body = (
      <>
        <span className="flex items-center gap-2 text-zinc-400">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
          In the room &mdash; waiting for a conductor
        </span>
        <span className="flex items-center gap-2">
          {canClaim && (
            <button
              onClick={onTakeBaton}
              className="px-3 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            >
              Conduct from here
            </button>
          )}
          {leave}
        </span>
      </>
    );
  } else if (chartMismatch) {
    body = (
      <>
        <span className="flex items-center gap-2 text-zinc-400">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
          The room is playing{' '}
          {songTitle ? (
            <span className="font-bold text-zinc-200">{songTitle}</span>
          ) : (
            'a different chart'
          )}{' '}
          &mdash; not on this device
        </span>
        {leave}
      </>
    );
  } else {
    // Mirroring. conductorLabel is relay-attributed (§4.3); when the frame
    // hasn't arrived yet we say "the conductor" — never a made-up name.
    body = (
      <>
        <span className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-zinc-300">
            {conductorLabel ? (
              <>
                <span className="font-bold text-white">{conductorLabel}</span> is conducting
              </>
            ) : (
              'Following the conductor'
            )}
          </span>
          {songTitle && <span className="text-zinc-500">&middot; {songTitle}</span>}
          {readout && (
            <span className="text-zinc-500">
              &middot; Bar <span className="font-bold text-red-400">{readout.absNumber}</span>
              {readout.passLabel && <> &middot; {readout.passLabel}</>}
            </span>
          )}
        </span>
        {leave}
      </>
    );
  }

  return (
    <div
      className={`flex items-center justify-between px-3 py-1.5 text-xs border-t ${
        status === 'joined' && conductorLost
          ? 'bg-amber-950/40 border-amber-900/60'
          : 'bg-zinc-900 border-zinc-800'
      }`}
    >
      {body}
    </div>
  );
}
