'use client';

import { useState } from 'react';

interface ConfigEntry {
  configured: boolean;
  masked: string;
}

type AdminConfig = Record<string, ConfigEntry>;

interface Owner {
  owner_slug: string;
  display_name: string | null;
  email: string | null;
  show_count: number;
  created_at: string;
}

export default function AdminPage() {
  const [secret, setSecret] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [kvConnected, setKvConnected] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState('');
  const [owners, setOwners] = useState<Owner[]>([]);
  const [ownersWarning, setOwnersWarning] = useState('');
  const [ownersError, setOwnersError] = useState('');

  // Form fields
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [claudeTryitKey, setClaudeTryitKey] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const authHeader = { Authorization: `Bearer ${secret}` };

    // Fetch settings and owners in parallel — either can fail independently
    const [settingsRes, ownersRes] = await Promise.all([
      fetch('/api/admin/settings', { headers: authHeader }),
      fetch('/api/admin/owners', { headers: authHeader }),
    ]);

    // Check auth on either response (both use same secret)
    if (settingsRes.status === 401 || ownersRes.status === 401) {
      setError('Invalid admin secret.');
      return;
    }

    // Settings may be 503 (KV down) — still authenticate and show owners
    if (settingsRes.ok) {
      const settingsData = await settingsRes.json();
      setConfig(settingsData.config);
      setKvConnected(settingsData.kvConnected);
    } else if (settingsRes.status === 503) {
      setKvConnected(false);
    }

    // Owners
    if (ownersRes.ok) {
      const ownersData = await ownersRes.json();
      setOwners(ownersData.owners || []);
      if (ownersData.warning) setOwnersWarning(ownersData.warning);
    } else {
      setOwnersError('Failed to load owners');
    }

    setAuthenticated(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaveSuccess('');
    setSaving(true);

    // Only send non-empty fields — blank means "no change"
    const body: Record<string, string> = {};
    if (googleClientId) body.google_client_id = googleClientId;
    if (googleClientSecret) body.google_client_secret = googleClientSecret;
    if (claudeTryitKey) body.claude_tryit_key = claudeTryitKey;

    if (Object.keys(body).length === 0) {
      setError('No changes to save.');
      setSaving(false);
      return;
    }

    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    setSaving(false);

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || 'Save failed.');
      return;
    }

    const data = await res.json();
    setConfig(data.config);
    setGoogleClientId('');
    setGoogleClientSecret('');
    setClaudeTryitKey('');
    setSaveSuccess(`Updated: ${data.updated.join(', ')}`);
    setTimeout(() => setSaveSuccess(''), 3000);
  }

  async function handleClear(key: string) {
    if (!confirm(`Disable ${key.replace(/_/g, ' ')}? This will prevent the feature from working.`)) return;
    setError('');
    setSaveSuccess('');

    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ [key]: '' }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || 'Clear failed.');
      return;
    }

    const data = await res.json();
    setConfig(data.config);
    setSaveSuccess(`Cleared: ${key}`);
    setTimeout(() => setSaveSuccess(''), 3000);
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <form onSubmit={handleLogin} className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm">
          <h1 className="text-xl font-bold mb-2">Admin Settings</h1>
          <p className="text-sm text-gray-500 mb-6">Enter your admin secret to continue.</p>
          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Admin secret"
            className="w-full px-3 py-2 border rounded-lg mb-4 text-sm"
            autoFocus
          />
          <button
            type="submit"
            className="w-full py-2 bg-black text-white font-bold text-sm rounded-lg hover:bg-gray-800 transition-colors"
          >
            Authenticate
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-lg mx-auto">
        <h1 className="text-xl font-bold mb-6">Admin Settings</h1>

        {/* Status */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">Status</h2>
          <div className="space-y-2 text-sm">
            <StatusRow label="KV Store" ok={kvConnected} />
            <StatusRow label="Google OAuth" ok={config?.google_client_id?.configured && config?.google_client_secret?.configured} />
            <StatusRow label="AI Try-It Mode" ok={config?.claude_tryit_key?.configured} />
          </div>
        </div>

        {/* Current values */}
        {config && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">Current Configuration</h2>
            <div className="space-y-2 text-sm font-mono">
              <ConfigRow label="Google Client ID" entry={config.google_client_id} />
              <ConfigRow label="Google Client Secret" entry={config.google_client_secret} />
              <ConfigRow label="Claude Try-It Key" entry={config.claude_tryit_key} />
            </div>
          </div>
        )}

        {/* Registered Owners */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">Registered Owners</h2>
          {ownersError ? (
            <p className="text-sm text-red-600">{ownersError}</p>
          ) : (
            <>
              {ownersWarning && (
                <p className="text-sm text-amber-600 bg-amber-50 px-3 py-2 rounded mb-3">
                  {ownersWarning}
                </p>
              )}
              {owners.length === 0 ? (
                <p className="text-sm text-gray-400">No owners registered yet.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b">
                          <th className="pb-2 pr-4">Handle</th>
                          <th className="pb-2 pr-4">Name</th>
                          <th className="pb-2 pr-4">Email</th>
                          <th className="pb-2 pr-4 text-right">Shows</th>
                          <th className="pb-2">Joined</th>
                        </tr>
                      </thead>
                      <tbody>
                        {owners.map((o) => (
                          <tr key={o.owner_slug} className="border-b border-gray-100">
                            <td className="py-2 pr-4 font-mono text-gray-800">{o.owner_slug}</td>
                            <td className="py-2 pr-4 text-gray-600">{o.display_name || '—'}</td>
                            <td className="py-2 pr-4 text-gray-600">{o.email || '—'}</td>
                            <td className="py-2 pr-4 text-right text-gray-600">{o.show_count}</td>
                            <td className="py-2 text-gray-400">
                              {o.created_at ? new Date(o.created_at).toLocaleDateString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-400 mt-3">{owners.length} owner{owners.length !== 1 ? 's' : ''} registered</p>
                </>
              )}
            </>
          )}
        </div>

        {/* Update form */}
        <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-4">Update Settings</h2>
          <p className="text-xs text-gray-400 mb-4">Only fill in fields you want to change. Leave blank to keep current value.</p>

          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
          {saveSuccess && <p className="text-sm text-green-600 mb-4">{saveSuccess}</p>}

          <div className="space-y-4">
            <SettingField
              label="Google Client ID"
              type="text"
              value={googleClientId}
              onChange={setGoogleClientId}
              configured={config?.google_client_id?.configured}
              onClear={() => handleClear('google_client_id')}
            />
            <SettingField
              label="Google Client Secret"
              type="password"
              value={googleClientSecret}
              onChange={setGoogleClientSecret}
              configured={config?.google_client_secret?.configured}
              onClear={() => handleClear('google_client_secret')}
            />
            <SettingField
              label="Claude API Key (Try-It Mode)"
              type="password"
              value={claudeTryitKey}
              onChange={setClaudeTryitKey}
              configured={config?.claude_tryit_key?.configured}
              onClear={() => handleClear('claude_tryit_key')}
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="mt-6 w-full py-2 bg-black text-white font-bold text-sm rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </form>
      </div>
    </div>
  );
}

function StatusRow({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-700">{label}</span>
      <span className={ok ? 'text-green-600 font-bold' : 'text-gray-400'}>
        {ok ? 'Configured' : 'Not configured'}
      </span>
    </div>
  );
}

function ConfigRow({ label, entry }: { label: string; entry: ConfigEntry }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-600 text-xs">{label}</span>
      <span className="text-gray-800 text-xs">
        {entry.configured ? entry.masked : '—'}
      </span>
    </div>
  );
}

function SettingField({ label, type, value, onChange, configured, onClear }: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  configured?: boolean;
  onClear: () => void;
}) {
  return (
    <div>
      <label className="block text-xs font-bold text-gray-600 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={configured ? 'Currently set — leave blank to keep' : 'Not configured'}
          className="flex-1 px-3 py-2 border rounded-lg text-sm font-mono"
        />
        {configured && (
          <button
            type="button"
            onClick={onClear}
            className="px-3 py-2 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
