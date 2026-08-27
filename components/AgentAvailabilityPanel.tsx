'use client';

import type { Availability } from '@/lib/agent-availability';

// Design docs/design-ai-key-availability.md §5 (states 2–6) and §7, chunk 3;
// the settings-overlay affordance is design-single-backend §3.1 (chunk 4).
//
// Presentational only — every decision arrives already made in `availability`, which
// lib/agent-availability.ts resolves and tests in isolation. The split exists because
// this panel lives inside a 6704-line page component whose state cannot be driven from
// a test; the same reason SetlistImportPreview was split out of the import flow.
//
// Chunk 4 removed the inline key input from here entirely. Every state whose way
// forward is a key now points at ONE place — the settings overlay — via
// `onOpenSettings`. A second inline input beside a settings page that also holds a
// key is the duplicate-entry problem §3.1 exists to remove, and it is why §9 T23
// asserts the ABSENCE of an input in states 5–7, not merely the presence of a link.

const KEY_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';

export function AgentAvailabilityPanel({
  availability,
  onOpenSettings,
}: {
  availability: Availability;
  onOpenSettings: () => void;
}) {
  const { lead, remaining, showKeyField } = availability;

  return (
    <>
      {lead === 'checking' && (
        <p className="text-xs text-gray-500" role="status">
          Checking AI availability…
        </p>
      )}

      {/* State 1 — a key is already in use. No lead copy (§5 says nothing about
          try-it here), but the overlay must stay reachable so the key can be
          replaced or removed without leaving the show and losing composer text.
          A quiet link, since nothing is wrong. */}
      {lead === 'none' && (
        <p className="text-xs text-gray-500">
          Using your Claude API key.{' '}
          <button onClick={onOpenSettings} className="underline">
            Manage key
          </button>
        </p>
      )}

      {lead === 'remaining' && remaining !== null && (
        <p className="text-xs text-gray-500">
          {remaining} free message{remaining !== 1 ? 's' : ''} remaining.
          <button onClick={onOpenSettings} className="underline ml-1">
            Add your own key
          </button>{' '}
          for unlimited use.
        </p>
      )}

      {lead === 'exhausted' && (
        <div className="text-xs text-gray-500 space-y-1">
          <p>Free messages used up. Add your own Claude API key to continue.</p>
          {/* §7: without this line, two testers in one room file two bug reports
              about a quota neither of them spent. The quota is keyed on the
              forwarded IP, so a whole venue shares one allowance. */}
          <p className="text-gray-400">Free messages are shared across everyone on your network.</p>
        </div>
      )}

      {(lead === 'unconfigured' || lead === 'checkFailed' || lead === 'rateLimited') && (
        <div className="text-xs text-gray-500 space-y-1">
          {/* States 5 and 6 are the same instruction with different leads. The user
              needs the same thing either way; only our confidence about why differs.
              The 429 lead is the one case where waiting is a real option, so it says so
              rather than implying something is broken. */}
          <p className="text-gray-700">
            {lead === 'unconfigured'
              ? 'Free messages aren’t available on this deployment.'
              : lead === 'rateLimited'
                ? 'Couldn’t check AI availability just yet — too many checks from your network. Try again shortly.'
                : 'Couldn’t check AI availability.'}
          </p>
          <p>
            Add your own Claude API key to use the AI Show Designer.{' '}
            <a
              href={KEY_CONSOLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 underline"
            >
              Get a key
            </a>
          </p>
        </div>
      )}

      {/* The single entry surface. Shown wherever availability says a key is the way
          forward; opening it never navigates away, so restored composer text survives
          (§3.1). There is deliberately no inline input here anymore (§9 T23). */}
      {showKeyField && (
        <button
          onClick={onOpenSettings}
          className="text-sm px-3 py-2 border border-gray-300 rounded hover:bg-gray-50 font-medium"
        >
          Add your API key in Settings
        </button>
      )}
    </>
  );
}
