'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

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

/**
 * Platform super-admin surface (design-single-backend §3.3a).
 *
 * The gating below is PRESENTATION ONLY. `/api/admin/*` enforces the boundary
 * server-side against PLATFORM_ADMIN_EMAIL, and this page cannot check that
 * itself — the variable is server-only by design. So "authorized" here means
 * "the route answered", not "the browser decided": we read the session to tell
 * signed-out from signed-in-as-someone-else, then let the 401 speak for itself.
 * §3.3a rule 4 — hiding a section is presentation, the route is the control.
 *
 * Read-only. Config lives in Vercel env vars, so there is nothing to submit;
 * changing the try-it key is an env edit plus a redeploy (§3).
 */
type Gate =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'forbidden'; email: string }
  | { state: 'error'; email: string; message: string }
  | { state: 'ok' };

export default function AdminPage() {
  const [gate, setGate] = useState<Gate>({ state: 'loading' });
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [ownersWarning, setOwnersWarning] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data } = await getSupabaseBrowser().auth.getUser();
      const email = data?.user?.email;
      if (cancelled) return;
      if (!email) {
        setGate({ state: 'signed-out' });
        return;
      }

      // Same-origin, so the session cookie rides along — no auth header.
      const ownersRes = await fetch('/api/admin/owners');
      if (cancelled) return;

      if (ownersRes.status === 401) {
        setGate({ state: 'forbidden', email });
        return;
      }
      if (ownersRes.status === 429) {
        setGate({ state: 'error', email, message: 'Too many requests. Wait a minute and reload.' });
        return;
      }
      if (!ownersRes.ok) {
        setGate({ state: 'error', email, message: 'Failed to load owners.' });
        return;
      }

      const ownersData = await ownersRes.json();
      if (cancelled) return;
      setOwners(ownersData.owners || []);
      if (ownersData.warning) setOwnersWarning(ownersData.warning);
      setGate({ state: 'ok' });

      // Config is supplementary — a failure here must not blank the page.
      try {
        const settingsRes = await fetch('/api/admin/settings');
        if (cancelled || !settingsRes.ok) return;
        setConfig((await settingsRes.json()).config);
      } catch {
        // Leave config null; the section renders as unavailable.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (gate.state === 'loading') return <Shell><p className="text-sm text-gray-500">Checking access…</p></Shell>;

  if (gate.state === 'signed-out') {
    return (
      <Shell>
        <p className="text-sm text-gray-500 mb-4">Sign in to continue.</p>
        <Link
          href="/sign-in?redirect=/admin"
          className="inline-block px-4 py-2 bg-black text-white font-bold text-sm rounded-lg hover:bg-gray-800 transition-colors"
        >
          Sign in
        </Link>
      </Shell>
    );
  }

  if (gate.state === 'forbidden') {
    return (
      <Shell>
        <p className="text-sm text-gray-700 mb-1">Signed in as <span className="font-mono">{gate.email}</span>.</p>
        <p className="text-sm text-gray-500 mb-4">This account is not the platform administrator.</p>
        <Link
          href="/sign-in?redirect=/admin"
          className="inline-block px-4 py-2 border text-sm rounded-lg hover:bg-gray-50 transition-colors"
        >
          Switch account
        </Link>
      </Shell>
    );
  }

  if (gate.state === 'error') {
    return (
      <Shell>
        <p className="text-sm text-gray-700 mb-1">Signed in as <span className="font-mono">{gate.email}</span>.</p>
        <p className="text-sm text-red-600">{gate.message}</p>
      </Shell>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-lg mx-auto">
        <h1 className="text-xl font-bold mb-6">Admin</h1>

        {/* Status */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">Status</h2>
          <div className="space-y-2 text-sm">
            <StatusRow
              label="Google OAuth"
              ok={config?.google_client_id?.configured && config?.google_client_secret?.configured}
            />
            <StatusRow label="AI Try-It Mode" ok={config?.claude_tryit_key?.configured} />
          </div>
        </div>

        {/* Current values */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">Configuration</h2>
          {config ? (
            <>
              <div className="space-y-2 text-sm font-mono">
                <ConfigRow label="Google Client ID" entry={config.google_client_id} />
                <ConfigRow label="Google Client Secret" entry={config.google_client_secret} />
                <ConfigRow label="Claude Try-It Key" entry={config.claude_tryit_key} />
              </div>
              <p className="text-xs text-gray-400 mt-4">
                Read-only. These resolve from environment variables — change one in Vercel and redeploy.
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-400">Configuration unavailable.</p>
          )}
        </div>

        {/* Registered Owners */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500 mb-3">Registered Owners</h2>
          {ownersWarning && (
            <p className="text-sm text-amber-600 bg-amber-50 px-3 py-2 rounded mb-3">{ownersWarning}</p>
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
        </div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold mb-2">Admin</h1>
        {children}
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
      <span className="text-gray-800 text-xs">{entry.configured ? entry.masked : '—'}</span>
    </div>
  );
}
