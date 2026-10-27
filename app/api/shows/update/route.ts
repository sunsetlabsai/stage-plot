import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKey, normalizeSongKeySafe } from '@/lib/normalize';
import { resolveOverride, diffOverride } from '@/lib/overrides';
import type { SetlistSong } from '@/lib/types';

interface EntryInput {
  song_id: string | null;
  title?: string;
  position: number;
  key?: string;
  lead?: string;
  notes?: string;
  scene_note?: string | null;
}

// The version-check contract (docs/design-version-checked-save.md §3.4).
const CONFLICT = { error: 'This show was changed somewhere else.', conflict: true } as const;
const NO_BASE = {
  // Q6 (Graham, 2026-10-27): the reload recovers the old tab's edit from its cache
  // (lib/use-show onWritable), so the copy must not tell them to redo it.
  error: 'This page is out of date. Reload — your last change will be checked and kept if it can be.',
} as const;

// PUT /api/shows/update — save show config (authenticated)
// When entries are provided, uses rpc_save_show for atomic dual-write.
// Server-side diffing: client sends effective values, server computes overrides vs library defaults.
// Every save carries base_updated_at — the server version the client's copy is
// built on — and is applied only if the show is still at it (409 otherwise).
export async function PUT(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json();
  const { id, config, name, venue, show_date, entries, base_updated_at } = body;

  if (!id || !config) {
    return Response.json({ error: 'id and config are required' }, { status: 400 });
  }
  // An old bundle sends no base. Accepting it unchecked would keep doing the blind
  // overwrite this contract exists to stop (Q1: 428, and the message says so).
  if (typeof base_updated_at !== 'string' || !base_updated_at) {
    return Response.json(NO_BASE, { status: 428 });
  }

  // Ownership FIRST, for both paths (§3.3). The admin client bypasses RLS, so this
  // check is the control on the entries path; on the legacy path it is what makes a
  // zero-row version-checked update mean "the version moved", never "not allowed".
  // Collaborators are view-only (§3.3c) — no membership grants a non-owner a write.
  const admin = getSupabaseAdmin();
  const { data: show } = await admin
    .from('shows')
    .select('owner_id')
    .eq('id', id)
    .maybeSingle();

  if (!show) {
    return Response.json({ error: 'Show not found' }, { status: 404 });
  }
  if (show.owner_id !== user.id) {
    return Response.json({ error: 'Not authorized' }, { status: 403 });
  }

  const effectiveName = name || config.showInfo?.showName || config.showInfo?.bandName || 'Untitled';

  // If entries are provided (reference-based save), use RPC
  if (entries !== undefined) {
    const entryList = entries as EntryInput[];

    // Resolve songs: by songId if present, otherwise by normalized title
    const resolvedEntries: Array<{
      song_id: string;
      position: number;
      key_override: string | null;
      lead_override: string | null;
      notes_override: string | null;
      scene_note: string | null;
    }> = [];

    if (entryList.length > 0) {
      // Batch-fetch all songs for this owner for efficient lookup
      const { data: ownerSongs } = await admin
        .from('songs')
        .select('id, song_key, title, key, lead, notes')
        .eq('owner_id', show.owner_id);

      const songsById = new Map(
        (ownerSongs || []).map((s) => [s.id, s]),
      );
      const songsByKey = new Map(
        (ownerSongs || []).map((s) => [s.song_key, s]),
      );

      for (const entry of entryList) {
        let song;

        if (entry.song_id) {
          song = songsById.get(entry.song_id);
        }

        // Fallback: resolve by normalized title
        if (!song && entry.title) {
          const songKey = normalizeSongKeySafe(entry.title);
          if (songKey) {
            song = songsByKey.get(songKey);
          }

          // If still not found and user is owner, auto-create the song
          if (!song && show.owner_id === user.id && songKey) {
            try {
              const normalizedKey = normalizeSongKey(entry.title);
              const { data: newSong } = await admin
                .from('songs')
                .insert({
                  owner_id: show.owner_id,
                  song_key: normalizedKey,
                  title: entry.title.trim(),
                  key: entry.key || null,
                  lead: entry.lead || '',
                  notes: entry.notes || '',
                })
                .select('id, song_key, title, key, lead, notes')
                .single();

              if (newSong) {
                song = newSong;
                songsById.set(newSong.id, newSong);
                songsByKey.set(newSong.song_key, newSong);
              }
            } catch {
              // Collision — re-query from DB (concurrent create by another request)
              const songKey2 = normalizeSongKeySafe(entry.title);
              if (songKey2) {
                const { data: existing } = await admin
                  .from('songs')
                  .select('id, song_key, title, key, lead, notes')
                  .eq('owner_id', show.owner_id)
                  .eq('song_key', songKey2)
                  .single();
                if (existing) {
                  song = existing;
                  songsById.set(existing.id, existing);
                  songsByKey.set(existing.song_key, existing);
                }
              }
            }
          }
        }

        if (!song) {
          return Response.json(
            { error: `Song at position ${entry.position} could not be resolved ("${entry.title || 'unknown'}")` },
            { status: 400 },
          );
        }

        // Server-side diffing: compare effective values against library defaults
        // null = use default, '' = explicitly blank, 'value' = override
        const keyOverride = diffOverride(entry.key, song.key);
        const leadOverride = diffOverride(entry.lead, song.lead);
        const notesOverride = diffOverride(entry.notes, song.notes);

        resolvedEntries.push({
          song_id: song.id,
          position: entry.position,
          key_override: keyOverride,
          lead_override: leadOverride,
          notes_override: notesOverride,
          scene_note: entry.scene_note ?? null,
        });
      }
    }

    // Hydrate inline setlist for dual-write
    const songIds = [...new Set(resolvedEntries.map((e) => e.song_id))];
    let songsMap: Record<string, { title: string; key: string | null; lead: string; notes: string }> = {};
    if (songIds.length > 0) {
      const { data: songs } = await admin
        .from('songs')
        .select('id, title, key, lead, notes')
        .in('id', songIds);

      songsMap = Object.fromEntries(
        (songs || []).map((s) => [s.id, s]),
      );
    }

    const inlineSetlist = resolvedEntries.map((e) => {
      const song = songsMap[e.song_id];
      if (!song) return null;
      return {
        id: crypto.randomUUID(),
        songId: e.song_id,
        position: e.position,
        title: song.title,
        key: resolveOverride(e.key_override, song.key),
        lead: resolveOverride(e.lead_override, song.lead, '') ?? '',
        notes: resolveOverride(e.notes_override, song.notes, '') ?? '',
        sceneNote: e.scene_note ?? undefined,
      };
    }).filter(Boolean);

    const { data, error } = await admin.rpc('rpc_save_show', {
      p_show_id: id,
      p_config: config,
      p_name: effectiveName,
      p_venue: venue || config.showInfo?.venue || '',
      p_show_date: show_date || config.showInfo?.eventDate || '',
      p_entries: resolvedEntries,
      p_inline_setlist: inlineSetlist,
      p_base_updated_at: base_updated_at,
    });

    // rpc_save_show raises PT409 under its row lock when the base is stale (018).
    if (error?.code === 'PT409') {
      return Response.json(CONFLICT, { status: 409 });
    }
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ updated_at: data.updated_at, slug: data.slug });
  }

  // Legacy path: direct update (non-migrated shows without song references)
  const updatePayload: Record<string, unknown> = {
    config,
    name: effectiveName,
    venue: venue || config.showInfo?.venue || null,
    show_date: show_date || config.showInfo?.eventDate || null,
  };

  // Strip songId from inline setlist before persisting
  if (config.setlist && Array.isArray(config.setlist)) {
    const setlist = config.setlist as SetlistSong[];
    updatePayload.config = {
      ...config,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setlist: setlist.map(({ songId, charts, ...rest }) => rest),
    };
  }

  const { data, error } = await supabase
    .from('shows')
    .update(updatePayload)
    .eq('id', id)
    .eq('updated_at', base_updated_at)
    .select('updated_at, slug')
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  // Ownership is already proven, so zero rows means the version moved (or the show
  // was deleted in between; the client's follow-up GET then 404s).
  if (!data) {
    return Response.json(CONFLICT, { status: 409 });
  }

  return Response.json({ updated_at: data.updated_at, slug: data.slug });
}
