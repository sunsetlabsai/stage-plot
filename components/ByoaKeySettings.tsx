'use client';

import { useState, useEffect, useCallback } from 'react';
import { readKey, persistKey } from '@/lib/byoa-key-storage';
import { normalizeKey, keyFormatMessage } from '@/lib/byoa-key-format';

// The BYOA key management UI (§4.5, §5.1), shared by two presentations:
//   - the standalone /dashboard/settings page, reached from the dashboard, and
//   - the settings OVERLAY on the show page (design-single-backend §3.1), opened
//     from the AI tab so entering a key never navigates away and destroys the
//     restored composer text.
//
// It is ONE component, not two, deliberately: "both presentations, one route"
// (§9 T24). A second copy would drift — the device/account rules, the consent
// copy and the masked-display invariant are the whole feature, and they must read
// identically wherever the key is entered.
//
// The optional callbacks are how the overlay keeps the show host in sync WITHOUT a
// remount: `onDeviceKeyChange` hands the host the new device key (or '' on remove)
// so its `apiKey` — and therefore Send — updates in place; `onAccountKeyChange`
// tells the host to re-run the account-aware probe so a freshly saved account key
// flips the affordance (§3.2, §9 T22). The standalone page passes neither and just
// manages storage.

type Storage = 'device' | 'account';

export function ByoaKeySettings({
  onDeviceKeyChange,
  onAccountKeyChange,
}: {
  onDeviceKeyChange?: (key: string) => void;
  onAccountKeyChange?: () => void;
} = {}) {
  const [loading, setLoading] = useState(true);
  const [accountHint, setAccountHint] = useState<string | null>(null);
  const [deviceKey, setDeviceKey] = useState('');
  const [choice, setChoice] = useState<Storage>('device');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  // Both stores are read in ONE async pass so the page never renders a state
  // it is about to contradict — showing "no key" for a frame when the account
  // has one reads as data loss to the person looking at it.
  //
  // The localStorage read sits after the await deliberately: setState called
  // synchronously in an effect body triggers cascading renders, and eslint's
  // react-hooks/set-state-in-effect rejects it.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/byoa');
      if (res.ok) {
        const data = await res.json();
        setAccountHint(data.hint ?? null);
        // If a key already lives on the account, default the radio to where the
        // user last put one. Defaulting to 'device' would silently propose
        // MOVING their key, which is not something a settings page should
        // suggest just by loading.
        if (data.hint) setChoice('account');
      }
    } finally {
      setDeviceKey(readKey(window.localStorage, window.sessionStorage));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetMessages() {
    setError('');
    setStatus('');
  }

  async function handleSave() {
    resetMessages();

    const parsed = normalizeKey(input);
    if (!parsed.ok) {
      setError(keyFormatMessage(parsed.reason));
      return;
    }

    setBusy(true);
    try {
      if (choice === 'device') {
        persistKey(window.localStorage, window.sessionStorage, parsed.key, true);
        setDeviceKey(parsed.key);
        setStatus('Saved in this browser.');
        onDeviceKeyChange?.(parsed.key);
      } else {
        const res = await fetch('/api/settings/byoa', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: parsed.key }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Could not save your key.');
          return;
        }
        setAccountHint(data.hint);
        setStatus('Saved to your account.');
        onAccountKeyChange?.();
      }
      setInput('');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveAccount() {
    resetMessages();
    setBusy(true);
    try {
      const res = await fetch('/api/settings/byoa', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Could not remove your key.');
        return;
      }
      setAccountHint(null);
      setStatus('Removed from your account.');
      onAccountKeyChange?.();
    } finally {
      setBusy(false);
    }
  }

  function handleRemoveDevice() {
    resetMessages();
    persistKey(window.localStorage, window.sessionStorage, '', true);
    setDeviceKey('');
    setStatus('Removed from this browser.');
    onDeviceKeyChange?.('');
  }

  if (loading) {
    return (
      <section className="border border-zinc-800 rounded-lg p-5">
        <p className="text-zinc-400 text-sm">Loading…</p>
      </section>
    );
  }

  const hasAnyKey = Boolean(accountHint) || Boolean(deviceKey);

  return (
    <section className="border border-zinc-800 rounded-lg p-5">
      <h2 className="text-lg font-semibold">Claude API key</h2>
      <p className="text-sm text-zinc-400 mt-1">
        Bring your own Anthropic key to use the AI features without the shared
        free allowance.
      </p>

      {/* Current state, if any. Masked — the key is never readable once saved. */}
      {hasAnyKey && (
        <div className="mt-5 space-y-3">
          {accountHint && (
            <div className="flex items-center justify-between bg-zinc-900 rounded px-4 py-3">
              <div>
                <p className="text-sm font-mono">{accountHint}</p>
                <p className="text-xs text-zinc-500 mt-0.5">Saved to your account</p>
              </div>
              <button
                onClick={handleRemoveAccount}
                disabled={busy}
                className="text-sm text-zinc-400 hover:text-red-400 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          )}

          {deviceKey && (
            <div className="flex items-center justify-between bg-zinc-900 rounded px-4 py-3">
              <div>
                <p className="text-sm font-mono">
                  {deviceKey.slice(0, 7)}…{deviceKey.slice(-4)}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">Saved in this browser</p>
              </div>
              <button
                onClick={handleRemoveDevice}
                disabled={busy}
                className="text-sm text-zinc-400 hover:text-red-400 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          )}

          {accountHint && deviceKey && (
            <p className="text-xs text-amber-500/80">
              This browser has its own key, and it takes precedence over the one
              on your account.
            </p>
          )}
        </div>
      )}

      {/* Add or replace. Labelled Replace when one already exists, because
          saving over a key is a different act from setting one. */}
      <div className="mt-6">
        <label htmlFor="byoa-key" className="block text-sm text-zinc-300 mb-2">
          {hasAnyKey ? 'Replace key' : 'Add a key'}
        </label>
        <input
          id="byoa-key"
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="sk-ant-..."
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />

        <fieldset className="mt-4">
          <legend className="text-sm text-zinc-300 mb-2">Where should it live?</legend>

          <label className="flex items-start gap-3 py-2 cursor-pointer">
            <input
              type="radio"
              name="storage"
              checked={choice === 'device'}
              onChange={() => setChoice('device')}
              className="mt-1"
            />
            <span>
              <span className="text-sm block">Remember on this device</span>
              <span className="text-xs text-zinc-500 block mt-0.5">
                Stays in this browser. We never receive it. You&apos;ll need to
                enter it again on another device.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 py-2 cursor-pointer">
            <input
              type="radio"
              name="storage"
              checked={choice === 'account'}
              onChange={() => setChoice('account')}
              className="mt-1"
            />
            <span>
              <span className="text-sm block">Save to my account</span>
              <span className="text-xs text-zinc-500 block mt-0.5">
                Works on every device you sign in on. Stored encrypted; only
                our servers can read it, and only to call Anthropic for you.
              </span>
            </span>
          </label>
        </fieldset>

        <button
          onClick={handleSave}
          disabled={busy || !input}
          className="mt-4 bg-white text-zinc-950 rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'Saving…' : hasAnyKey ? 'Replace key' : 'Save key'}
        </button>

        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
        {status && <p className="text-sm text-emerald-400 mt-3">{status}</p>}
      </div>

      {/* §4.6.5 — consent at the point of entry, in plain language. */}
      <div className="mt-6 pt-5 border-t border-zinc-800 text-xs text-zinc-500 space-y-1.5">
        <p>
          Choosing &ldquo;Save to my account&rdquo; means we store your key,
          encrypted, so it follows you between devices. It is used only to make
          AI requests you trigger. It is never shown back to you or to anyone
          else — remove it here at any time, and deleting your account deletes
          it too.
        </p>
        <p>
          Your key stays yours: Anthropic bills it to you, and you can revoke it
          from your Anthropic console whenever you like.
        </p>
      </div>
    </section>
  );
}
