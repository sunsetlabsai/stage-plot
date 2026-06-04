'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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

// No-fallback slug helper (separate from show-file.ts which falls back to 'show')
function slugBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default function DashboardPage() {
  const [ownerSlug, setOwnerSlug] = useState('');
  const [owned, setOwned] = useState<ShowSummary[]>([]);
  const [collaborating, setCollaborating] = useState<ShowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [modal, setModal] = useState<{ mode: 'new' | 'duplicate'; sourceShow?: ShowSummary } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newShowButtonRef = useRef<HTMLButtonElement>(null);
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

  async function handleImportYaml(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const content = await file.text();
      const config = deserializeShow(content, file.name);
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

  const closeModal = useCallback(() => {
    setModal(null);
    newShowButtonRef.current?.focus();
  }, []);

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
          ref={newShowButtonRef}
          onClick={() => setModal({ mode: 'new' })}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors"
        >
          New Show
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
                    onDuplicate={() => setModal({ mode: 'duplicate', sourceShow: show })}
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

      {modal && (
        <CreateShowModal
          mode={modal.mode}
          sourceShow={modal.sourceShow}
          ownerSlug={ownerSlug}
          onClose={closeModal}
          onCreated={(slug) => router.push(`/${ownerSlug}/${slug}`)}
        />
      )}
    </div>
  );
}

function ShowCard({
  show,
  onOpen,
  onDelete,
  onDuplicate,
}: {
  show: ShowSummary;
  onOpen: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
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
        {onDuplicate && (
          <button
            onClick={onDuplicate}
            className="text-xs text-zinc-600 hover:text-blue-400 transition-colors"
            title="Duplicate show"
          >
            Duplicate
          </button>
        )}
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

function CreateShowModal({
  mode,
  sourceShow,
  ownerSlug,
  onClose,
  onCreated,
}: {
  mode: 'new' | 'duplicate';
  sourceShow?: ShowSummary;
  ownerSlug: string;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const defaultName = mode === 'duplicate' && sourceShow
    ? `Copy of ${sourceShow.name || 'Untitled'}`
    : '';
  const [name, setName] = useState(defaultName);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const trimmed = name.trim();
  const slug = slugBase(trimmed);
  const canCreate = slug.length > 0 && !creating;

  // Autofocus
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Escape to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus trap
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
      'input, button:not([disabled])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate) return;

    setCreating(true);
    setError('');

    try {
      let config;
      let venue: string | null = null;
      let showDate: string | null = null;

      if (mode === 'duplicate' && sourceShow) {
        // Fetch source config
        const sourceRes = await fetch(`/api/shows/${sourceShow.owner_slug}/${sourceShow.slug}`);
        if (!sourceRes.ok) {
          setError('Could not load source show.');
          setCreating(false);
          return;
        }
        const sourceData = await sourceRes.json();
        const sourceConfig = sourceData.config;

        // Strip stale chart snapshots from setlist
        const cleanedSetlist = (sourceConfig.setlist || []).map(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ({ charts, ...rest }: { charts?: unknown; [key: string]: unknown }) => rest,
        );

        config = {
          ...sourceConfig,
          showInfo: {
            ...sourceConfig.showInfo,
            showName: trimmed,
            // bandName preserved from original
          },
          setlist: cleanedSetlist,
        };
        venue = sourceConfig.showInfo?.venue || null;
        const dateStr = sourceConfig.showInfo?.eventDate;
        showDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null;
      } else {
        // New show
        config = {
          showInfo: { bandName: trimmed, showName: trimmed, eventDate: '', venue: '' },
          stagePlot: [],
          inputs: [],
          monitors: [],
          notes: [],
          setlist: [],
        };
      }

      const res = await fetch('/api/shows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, name: trimmed, venue, show_date: showDate }),
      });

      if (res.ok) {
        const data = await res.json();
        onCreated(data.slug);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not create show. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    }
    setCreating(false);
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={handleKeyDown}
    >
      <div ref={modalRef} className="bg-zinc-900 rounded-xl p-6 w-full max-w-md border border-zinc-700">
        <h2 className="text-lg font-bold text-white mb-4">
          {mode === 'duplicate' ? 'Duplicate Show' : 'Create a New Show'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Show Name</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="e.g., Friday Night at The Roxy"
              maxLength={100}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 transition-colors"
            />
            {trimmed && slug && (
              <p className="text-xs text-zinc-500 mt-1.5">
                URL: <span className="font-mono text-zinc-400">/{ownerSlug}/{slug}</span>
              </p>
            )}
            {trimmed && !slug && (
              <p className="text-xs text-amber-500 mt-1.5">
                Name must contain at least one letter or number
              </p>
            )}
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canCreate}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
