'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Chart, Song } from '@/lib/types';
import ManageChartsModal from '@/components/ManageChartsModal';
import { suggestDuplicateTitle } from '@/lib/chart-management';

export default function LibraryPage() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState(true);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<{ title: string; key: string; lead: string; notes: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    async function loadSongs() {
      const res = await fetch('/api/songs');
      if (res.ok) {
        const data = await res.json();
        setSongs(data.songs || []);
        setIsOwner(data.is_owner);
      }
      setLoading(false);
    }
    loadSongs();
  }, []);

  async function handleCreate(title: string, key: string, lead: string, notes: string) {
    const res = await fetch('/api/songs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, key, lead, notes }),
    });

    if (res.ok) {
      const song = await res.json();
      setSongs((prev) => [...prev, { ...song, chart_count: 0, show_count: 0 }].sort((a, b) => a.title.localeCompare(b.title)));
      setAddingNew(false);
      return null;
    }

    const data = await res.json().catch(() => ({}));
    return data.error || 'Failed to create song';
  }

  async function handleUpdate(id: string, updates: { title?: string; key?: string; lead?: string; notes?: string }) {
    const res = await fetch('/api/songs/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });

    if (res.ok) {
      const updated = await res.json();
      setSongs((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...updated } : s))
          .sort((a, b) => a.title.localeCompare(b.title)),
      );
      setEditingId(null);
      return null;
    }

    const data = await res.json().catch(() => ({}));
    return data.error || 'Failed to update song';
  }

  async function handleDelete(id: string, title: string, showCount: number) {
    const msg = showCount > 0
      ? `Delete "${title}"? It is used in ${showCount} show${showCount > 1 ? 's' : ''}. This will remove it from all setlists and delete associated charts.`
      : `Delete "${title}"? This will also delete associated charts.`;

    if (!confirm(msg)) return;

    const res = await fetch('/api/songs/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });

    if (res.ok) {
      setSongs((prev) => prev.filter((s) => s.id !== id));
    }
  }

  // Charts mutated in the Manage Charts modal — update that song in place and
  // keep chart_count in parity with the new array length (add +1 / replace 0 /
  // delete -1 all fall out of length).
  function handleChartsChanged(songId: string, charts: Chart[]) {
    setSongs((prev) =>
      prev.map((s) => (s.id === songId ? { ...s, charts, chart_count: charts.length } : s)),
    );
  }

  // Duplicate-with-edit: copy metadata only (no charts) into a pre-filled create
  // form so the owner can make a key variant ("Song X (Bb)") with its own charts.
  function handleDuplicate(song: Song) {
    setDuplicating({
      title: suggestDuplicateTitle(song.title, songs.map((s) => s.title)),
      key: song.key ?? '',
      lead: song.lead ?? '',
      notes: song.notes ?? '',
    });
    setAddingNew(false);
    setEditingId(null);
  }

  async function handleDuplicateSave(title: string, key: string, lead: string, notes: string) {
    const err = await handleCreate(title, key, lead, notes);
    if (!err) setDuplicating(null);
    return err;
  }

  const managingSong = managingId ? songs.find((s) => s.id === managingId) ?? null : null;

  const filtered = search
    ? songs.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
    : songs;

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
          <h1 className="text-2xl font-bold">Song Library</h1>
          <p className="text-xs text-zinc-500 mt-0.5">ShowRunr</p>
        </div>
        <button
          onClick={() => router.push('/dashboard')}
          className="text-sm text-zinc-500 hover:text-zinc-300"
        >
          Back to Shows
        </button>
      </header>

      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search songs..."
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition-colors"
        />
        {isOwner && (
          <button
            onClick={() => { setAddingNew(true); setEditingId(null); }}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            + Add Song
          </button>
        )}
      </div>

      {addingNew && (
        <SongForm
          onSave={handleCreate}
          onCancel={() => setAddingNew(false)}
        />
      )}

      {duplicating && (
        <SongForm
          initial={duplicating}
          submitLabel="Create"
          onSave={handleDuplicateSave}
          onCancel={() => setDuplicating(null)}
        />
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-zinc-500">
          {songs.length === 0 ? (
            <>
              <p className="text-lg">Your song library is empty.</p>
              <p className="mt-2">Add songs here, or they will be created automatically when you add songs to setlists.</p>
            </>
          ) : (
            <p>No songs match &ldquo;{search}&rdquo;</p>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <div className="grid grid-cols-[1fr_80px_120px_60px_60px_auto] gap-2 px-4 py-2 text-xs text-zinc-500 uppercase tracking-wide">
            <span>Title</span>
            <span>Key</span>
            <span>Lead</span>
            <span className="text-center">Charts</span>
            <span className="text-center">Shows</span>
            <span></span>
          </div>
          {filtered.map((song) =>
            editingId === song.id ? (
              <SongForm
                key={song.id}
                initial={song}
                onSave={(title, key, lead, notes) => handleUpdate(song.id, { title, key, lead, notes })}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <SongRow
                key={song.id}
                song={song}
                isOwner={isOwner}
                onEdit={() => { setEditingId(song.id); setAddingNew(false); }}
                onDelete={() => handleDelete(song.id, song.title, song.show_count ?? 0)}
                onManageCharts={() => setManagingId(song.id)}
                onDuplicate={() => handleDuplicate(song)}
              />
            ),
          )}
        </div>
      )}

      {managingSong && (
        <ManageChartsModal
          songTitle={managingSong.title}
          charts={managingSong.charts ?? []}
          isOwner={isOwner}
          onClose={() => setManagingId(null)}
          onChartsChanged={(charts) => handleChartsChanged(managingSong.id, charts)}
        />
      )}
    </div>
  );
}

function SongRow({
  song,
  isOwner,
  onEdit,
  onDelete,
  onManageCharts,
  onDuplicate,
}: {
  song: Song;
  isOwner: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onManageCharts: () => void;
  onDuplicate: () => void;
}) {
  const count = song.chart_count ?? 0;
  // Owners can always manage (incl. add to an empty song); collaborators can open
  // only to preview when charts exist.
  const canManage = isOwner || count > 0;

  return (
    <div className="grid grid-cols-[1fr_80px_120px_60px_60px_auto] gap-2 items-center px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-colors">
      <span className="font-medium truncate">{song.title}</span>
      <span>
        {song.key && (
          <span className="inline-block px-2 py-0.5 rounded bg-zinc-800 text-xs text-zinc-300">
            {song.key}
          </span>
        )}
      </span>
      <span className="text-sm text-zinc-400 truncate">{song.lead || '—'}</span>
      <span className="text-center">
        {canManage ? (
          <button
            onClick={onManageCharts}
            className="text-sm text-zinc-400 hover:text-blue-400 transition-colors"
          >
            {count > 0 ? `${count} ›` : '+ Add'}
          </button>
        ) : (
          <span className="text-sm text-zinc-500">{count}</span>
        )}
      </span>
      <span className="text-sm text-zinc-500 text-center">{song.show_count ?? 0}</span>
      <div className="flex gap-2">
        {isOwner && (
          <>
            <button
              onClick={onEdit}
              className="text-xs text-zinc-600 hover:text-blue-400 transition-colors"
            >
              Edit
            </button>
            <button
              onClick={onDuplicate}
              className="text-xs text-zinc-600 hover:text-blue-400 transition-colors"
            >
              Duplicate
            </button>
            <button
              onClick={onDelete}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SongForm({
  initial,
  onSave,
  onCancel,
  submitLabel,
}: {
  initial?: { title: string; key: string | null; lead: string; notes: string };
  onSave: (title: string, key: string, lead: string, notes: string) => Promise<string | null>;
  onCancel: () => void;
  submitLabel?: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [key, setKey] = useState(initial?.key ?? '');
  const [lead, setLead] = useState(initial?.lead ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError('');
    const err = await onSave(title.trim(), key.trim(), lead.trim(), notes.trim());
    if (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 py-3 rounded-lg bg-zinc-900 border border-blue-600/50 space-y-3">
      <div className="grid grid-cols-[1fr_80px_120px] gap-2">
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Song title"
          maxLength={200}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
        />
        <input
          type="text"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Key"
          maxLength={10}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
        />
        <input
          type="text"
          value={lead}
          onChange={(e) => setLead(e.target.value)}
          placeholder="Lead vocalist"
          maxLength={100}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
        />
      </div>
      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        maxLength={500}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-zinc-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!title.trim() || saving}
          className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : (submitLabel ?? (initial ? 'Update' : 'Create'))}
        </button>
      </div>
    </form>
  );
}
