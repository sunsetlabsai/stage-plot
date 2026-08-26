'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ClaimPage() {
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [alreadyClaimed, setAlreadyClaimed] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const router = useRouter();

  const slug = handle.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const isValid = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug);

  // On-mount: check if profile already exists
  useEffect(() => {
    async function checkProfile() {
      try {
        const res = await fetch('/api/profiles');
        if (res.ok) {
          const data = await res.json();
          setAlreadyClaimed(data.owner_slug);
        } else if (res.status === 401) {
          // Document load, not router.push, for the same cache reason — and
          // note this branch `return`s without clearing `checking`, so if the
          // navigation does not land the page is pinned on "Loading..."
          // forever. A document load cannot fail to land.
          window.location.assign('/sign-in?redirect=/claim');
          return;
        }
        // 404 = no profile, show form
      } catch {
        // Network error — show form as fallback
      }
      setChecking(false);
    }
    checkProfile();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;

    setSubmitting(true);
    setError('');

    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_slug: slug, display_name: displayName || null }),
    });

    if (res.ok) {
      setClaimed(true);
      // A FULL DOCUMENT LOAD, not router.push. Claiming a handle changes the
      // answer middleware.ts:86 gives for /dashboard, but the client router
      // cached the pre-claim answer — a 307 to /claim — when sign-in pushed
      // here. /dashboard builds as a STATIC route, and static routes are held
      // in the client cache (staleTimes.static, 5 min), so router.push replays
      // that redirect without ever asking the server and the user is pinned on
      // this page. Measured: with push, ZERO requests for /dashboard are made.
      // router.refresh() does not help — it clears the cache for the CURRENT
      // route only (next/docs use-router.md:46); measured, it changed nothing.
      // A document load is the one documented reset: "The client cache is
      // cleared on page refresh" (next/docs glossary.md:45).
      setTimeout(() => window.location.assign('/dashboard'), 1500);
    } else {
      const data = await res.json();
      // Handle 409 gracefully — user already has a profile, fetch real handle
      if (res.status === 409 && data.error?.includes('Profile already exists')) {
        try {
          const profileRes = await fetch('/api/profiles');
          if (profileRes.ok) {
            const profileData = await profileRes.json();
            setAlreadyClaimed(profileData.owner_slug);
          } else {
            setAlreadyClaimed('__unknown__');
          }
        } catch {
          setAlreadyClaimed('__unknown__');
        }
      } else {
        setError(data.error || 'Something went wrong');
      }
    }
    setSubmitting(false);
  }

  // Loading state — don't flash the form
  if (checking) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    );
  }

  // Already claimed state
  if (alreadyClaimed) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center space-y-4">
          <h1 className="text-2xl font-bold text-white">Already claimed</h1>
          {alreadyClaimed === '__unknown__' ? (
            <p className="text-zinc-400">You already have a ShowRunr handle.</p>
          ) : (
            <p className="text-zinc-400">
              Your handle is <span className="font-mono text-white">showrunr.ai/{alreadyClaimed}</span>
            </p>
          )}
          {/* Plain <a>, not <Link>: see the comment on the redirect above.
              <Link> is a client navigation and replays the same cached
              redirect, which is why this CTA appeared dead in UAT.
              no-html-link-for-pages assumes a client navigation is always
              preferable. Here it is the defect, so the rule is wrong for these
              two links specifically — suppressed per-line, not per-file. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/dashboard"
            className="inline-block px-6 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors"
          >
            Go to Dashboard
          </a>
        </div>
      </div>
    );
  }

  // Success state
  if (claimed) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center space-y-4">
          <h1 className="text-2xl font-bold text-white">
            Claimed <span className="font-mono">{slug}</span>!
          </h1>
          <p className="text-zinc-400">Redirecting to your dashboard...</p>
          {/* Plain <a> for the same reason as the CTA above. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/dashboard"
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            Go to Dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">Claim your RunR</h1>
          <p className="text-zinc-400 mt-2">Pick a handle for your ShowRunr URL</p>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Handle</label>
          <div className="flex items-center gap-0 rounded-lg overflow-hidden border border-zinc-700 focus-within:border-blue-500 transition-colors">
            <span className="bg-zinc-800 text-zinc-500 px-3 py-2.5 text-sm select-none whitespace-nowrap">
              showrunr.ai/
            </span>
            <input
              type="text"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                setError('');
              }}
              placeholder="your-handle"
              className="flex-1 bg-zinc-900 text-white px-3 py-2.5 text-sm outline-none min-w-0"
              maxLength={30}
              autoFocus
            />
          </div>
          {handle && !isValid && (
            <p className="text-xs text-zinc-500 mt-1">3-30 characters, letters, numbers, and hyphens</p>
          )}
          <p className="text-xs text-zinc-600 mt-2">
            Your handle is your unique URL prefix. Shows you create will live at showrunr.ai/{slug || 'your-handle'}/...
          </p>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Display name (optional)</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name or band name"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 transition-colors"
            maxLength={100}
          />
        </div>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={!isValid || submitting}
          className="w-full py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Claiming...' : 'Claim it'}
        </button>
      </form>
    </div>
  );
}
