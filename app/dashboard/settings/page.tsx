'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ByoaKeySettings } from '@/components/ByoaKeySettings';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

// /dashboard/settings — the signed-in owner's OWN account (§8 Q5).
// Distinct from /admin, which is the platform super-admin surface for a
// different principal entirely. Nothing here is show-scoped, so there is no
// RBAC and no collaborator check: the whole authorization rule is "you are you".
//
// v1 content is the BYOA key (§4.5), rendered by the shared `ByoaKeySettings`
// component — the SAME component the show-page settings overlay uses, so the two
// presentations of "manage your key" cannot drift (§9 T24, "one route").

export default function SettingsPage() {
  // The device key is scoped to the account (lib/byoa-key-storage, #134), so the
  // panel waits for the id. The middleware guard means a session exists here.
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    getSupabaseBrowser().auth.getSession().then(({ data }: { data: { session: { user: { id: string } } | null } }) => {
      setUserId(data.session?.user?.id ?? '');
    });
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Your account</p>
        </div>
        <Link href="/dashboard" className="text-sm text-zinc-500 hover:text-zinc-300">
          Back to shows
        </Link>
      </header>

      {userId === null ? (
        <p className="text-zinc-400 text-sm">Loading...</p>
      ) : userId ? (
        <ByoaKeySettings userId={userId} />
      ) : (
        <p className="text-zinc-400 text-sm">
          <Link href="/sign-in?redirect=/dashboard/settings" className="underline">Sign in</Link> to manage your key.
        </p>
      )}
    </div>
  );
}
