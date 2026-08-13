'use client';

import type { Availability } from '@/lib/agent-availability';

// Design docs/design-ai-key-availability.md §5 (states 2–6) and §7, chunk 3.
//
// Presentational only — every decision arrives already made in `availability`, which
// lib/agent-availability.ts resolves and tests in isolation. The split exists because
// this panel lives inside a 6704-line page component whose state cannot be driven from
// a test; the same reason SetlistImportPreview was split out of the import flow.

const KEY_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';

export function AgentAvailabilityPanel({
  availability,
  apiKey,
  rememberKey,
  showKey,
  onApiKeyChange,
  onRememberChange,
  onRevealKey,
  onClearKey,
}: {
  availability: Availability;
  apiKey: string;
  rememberKey: boolean;
  showKey: boolean;
  onApiKeyChange: (value: string) => void;
  onRememberChange: (value: boolean) => void;
  onRevealKey: () => void;
  onClearKey: () => void;
}) {
  const { lead, remaining, showKeyField } = availability;

  // The field is expanded whenever availability says the way forward is a key, and
  // also whenever there already is one (so it can be cleared) or the user asked for it.
  const keyFieldVisible = showKeyField || !!apiKey || showKey;

  return (
    <>
      {lead === 'checking' && (
        <p className="text-xs text-gray-500" role="status">
          Checking AI availability…
        </p>
      )}

      {lead === 'remaining' && remaining !== null && (
        <p className="text-xs text-gray-500">
          {remaining} free message{remaining !== 1 ? 's' : ''} remaining.
          <button onClick={onRevealKey} className="underline ml-1">
            Add your own key
          </button>{' '}
          for unlimited use.
        </p>
      )}

      {lead === 'exhausted' && (
        <div className="text-xs text-gray-500 space-y-1">
          <p>Free messages used up. Enter your own Claude API key to continue.</p>
          {/* §7: without this line, two testers in one room file two bug reports
              about a quota neither of them spent. The quota is keyed on the
              forwarded IP, so a whole venue shares one allowance. */}
          <p className="text-gray-400">Free messages are shared across everyone on your network.</p>
        </div>
      )}

      {(lead === 'unconfigured' || lead === 'checkFailed') && (
        <div className="text-xs text-gray-500 space-y-1">
          {/* States 5 and 6 are the same instruction with different leads. The user
              needs the same thing either way; only our confidence about why differs. */}
          <p className="text-gray-700">
            {lead === 'unconfigured'
              ? 'Free messages aren’t available on this deployment.'
              : 'Couldn’t check AI availability.'}
          </p>
          <p>
            Paste your own Claude API key below to use the AI Show Designer.{' '}
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

      {keyFieldVisible && (
        <div className="flex items-center gap-2">
          <input
            type="password"
            aria-label="Claude API key"
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-black bg-white font-mono"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          {apiKey && (
            <button onClick={onClearKey} className="px-2 py-2 text-xs text-red-500 hover:text-red-700">
              Clear
            </button>
          )}
          <label className="flex items-center gap-1 text-xs text-gray-500 whitespace-nowrap">
            <input
              type="checkbox"
              checked={rememberKey}
              onChange={(e) => onRememberChange(e.target.checked)}
            />
            Remember
          </label>
        </div>
      )}
    </>
  );
}
