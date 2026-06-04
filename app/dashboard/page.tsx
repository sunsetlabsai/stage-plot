'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { deserializeShow } from '@/lib/show-file';
import { ensureSetlistSongIds } from '@/lib/setlist';

interface ShowSummary {
  id: string;
  slug: string;
  name: string;
  venue: string | null;
  show_date: string | null;
  updated_at: string;
  role?: string;
  owner_slug: string;
}

export default function DashboardPage() {
  const [ownerSlug, setOwnerSlug] = useState('');
  const [owned, setOwned] = useState<ShowSummary[]>([]);
  const [collaborating, setCollaborating] = useState<ShowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    async function loadShows() {
      const res = await fetch('/api/shows');
      if (res.ok) {
        const data = await res.json();
        setOwnerSlug(data.owner_slug || '');
        setOwned(data.owned);
        setCollaborating(data.collaborating);
      }
      setLoading(false);
    }
    loadShows();

    // Handle legacy ?config= import (from root page redirect)
    const pending = localStorage.getItem('showrunr-pending-import');
    if (pending) {
      localStorage.removeItem('showrunr-pending-import');
      try {
        const config = JSON.parse(decodeURIComponent(atob(pending)));
        const name = config.showInfo?.showName || config.showInfo?.bandName || 'Imported Show';
        fetch('/api/shows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config, name, venue: config.showInfo?.venue }),
        }).then(async (res) => {
          if (res.ok) {
            const { slug } = await res.json();
            // Refetch to get owner_slug for redirect
            const profileRes = await fetch('/api/profiles');
            if (profileRes.ok) {
              const profile = await profileRes.json();
              router.push(`/${profile.owner_slug}/${slug}`);
            }
          }
        });
      } catch {
        // Invalid config — silently ignore
      }
    }
  }, [router]);

  function showUrl(show: ShowSummary) {
    return `/${show.owner_slug}/${show.slug}`;
  }

  async function handleCreate() {
    setCreating(true);
    const defaultConfig = {
      showInfo: { bandName: 'New Show', eventDate: '', venue: '' },
      stagePlot: [],
      inputs: [],
      monitors: [],
      notes: [],
      setlist: [],
    };

    const res = await fetch('/api/shows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: defaultConfig,
        name: 'New Show',
      }),
    });

    if (res.ok) {
      const { slug } = await res.json();
      router.push(`/${ownerSlug}/${slug}`);
    }
    setCreating(false);
  }

  async function handleImportYaml(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const content = await file.text();
      const config = deserializeShow(content, file.name);
      // Ensure stable song IDs for chart linkage
      config.setlist = ensureSetlistSongIds(config.setlist);

      const name = config.showInfo.showName || config.showInfo.bandName || 'Imported Show';

      const res = await fetch('/api/shows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config,
          name,
          venue: config.showInfo.venue,
          show_date: config.showInfo.eventDate,
        }),
      });

      if (res.ok) {
        const { slug } = await res.json();
        router.push(`/${ownerSlug}/${slug}`);
      }
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

    await fetch('/api/shows/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });

    setOwned((prev) => prev.filter((s) => s.id !== id));
  }

  async function handleSignOut() {
    const supabase = getSupabaseBrowser();
    await supabase.auth.signOut();
    router.push('/sign-in');
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">My Shows</h1>
          <p className="text-xs text-zinc-500 mt-0.5">ShowRunr</p>
        </div>
        <button
          onClick={handleSignOut}
          className="text-sm text-zinc-500 hover:text-zinc-300"
        >
          Sign Out
        </button>
      </header>

      <div className="flex gap-3 mb-8">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {creating ? 'Creating...' : 'New Show'}
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="px-4 py-2 rounded-lg bg-zinc-800 text-white font-medium hover:bg-zinc-700 disabled:opacity-50 transition-colors border border-zinc-700"
        >
          {importing ? 'Importing...' : 'Import YAML'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml,.json"
          onChange={handleImportYaml}
          className="hidden"
        />
      </div>

      {owned.length === 0 && collaborating.length === 0 ? (
        <div className="text-center py-16 text-zinc-500">
          <p className="text-lg">Welcome to ShowRunr.</p>
          <p className="mt-2">Create your first show, or import an existing .showrunr.yaml file.</p>
          {ownerSlug && (
            <p className="mt-1 text-xs text-zinc-600">
              Your shows will live at showrunr.ai/{ownerSlug}/...
            </p>
          )}
        </div>
      ) : (
        <>
          {owned.length > 0 && (
            <section className="mb-8">
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">
                Owned
              </h2>
              <div className="grid gap-3">
                {owned.map((show) => (
                  <ShowCard
                    key={show.id}
                    show={show}
                    onOpen={() => router.push(showUrl(show))}
                    onDelete={() => handleDelete(show.id, show.name)}
                  />
                ))}
              </div>
            </section>
          )}

          {collaborating.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">
                Shared with me
              </h2>
              <div className="grid gap-3">
                {collaborating.map((show) => (
                  <ShowCard
                    key={show.id}
                    show={show}
                    onOpen={() => router.push(showUrl(show))}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ShowCard({
  show,
  onOpen,
  onDelete,
}: {
  show: ShowSummary;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex items-center justify-between p-4 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-colors">
      <button onClick={onOpen} className="flex-1 text-left">
        <div className="font-medium">{show.name}</div>
        <div className="text-sm text-zinc-400 mt-0.5">
          {[show.venue, show.show_date, show.role && `(${show.role})`]
            .filter(Boolean)
            .join(' · ') || 'No details'}
        </div>
      </button>
      <div className="flex items-center gap-2 ml-4">
        <span className="text-xs text-zinc-600">
          /{show.owner_slug}/{show.slug}
        </span>
        {onDelete && (
          <button
            onClick={onDelete}
            className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
            title="Delete show"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
