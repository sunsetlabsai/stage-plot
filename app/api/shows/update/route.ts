import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKeySafe } from '@/lib/normalize';
import type { SetlistSong } from '@/lib/types';

// Three-state override resolution for hydrating inline setlist
function resolveOverride(
  override: string | null | undefined,
  fallback: string | null | undefined,
  emptyAs?: string,
): string | undefined {
  if (override === '') return emptyAs;
  if (override != null) return override;
  return fallback ?? undefined;
}

// PUT /api/shows/update — save show config (authenticated)
// Now uses rpc_save_show for atomic entries + inline dual-write.
// Falls back to direct update for non-migrated shows without setlist entries.
export async function PUT(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json();
  const { id, config, name, venue, show_date, entries } = body;

  if (!id || !config) {
    return Response.json({ error: 'id and config are required' }, { status: 400 });
  }

  const effectiveName = name || config.showInfo?.showName || config.showInfo?.bandName || 'Untitled';

  // If entries are provided (migrated show), use RPC for atomic save
  if (entries) {
    const admin = getSupabaseAdmin();

    // Verify caller is owner or editor
    const { data: show } = await admin
      .from('shows')
      .select('owner_id')
      .eq('id', id)
      .single();

    if (!show) {
      return Response.json({ error: 'Show not found' }, { status: 404 });
    }

    if (show.owner_id !== user.id) {
      const { data: collab } = await admin
        .from('show_collaborators')
        .select('role')
        .eq('show_id', id)
        .eq('user_id', user.id)
        .single();

      if (!collab || collab.role !== 'editor') {
        return Response.json({ error: 'Not authorized' }, { status: 403 });
      }
    }

    // Hydrate inline setlist for dual-write
    const songIds = entries
      .map((e: { song_id: string }) => e.song_id)
      .filter(Boolean);

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

    const inlineSetlist = entries.map((e: {
      song_id: string;
      position: number;
      key_override?: string | null;
      lead_override?: string | null;
      notes_override?: string | null;
      scene_note?: string | null;
    }) => {
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
      p_entries: entries,
      p_inline_setlist: inlineSetlist,
    });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ updated_at: data.updated_at, slug: data.slug });
  }

  // Legacy path: direct update (non-migrated shows, or shows without song references)
  // Still uses RLS-enforced authenticated client
  const updatePayload: Record<string, unknown> = {
    config,
    name: effectiveName,
    venue: venue || config.showInfo?.venue || null,
    show_date: show_date || config.showInfo?.eventDate || null,
  };

  // Strip songId from inline setlist before persisting (defense in depth)
  if (config.setlist && Array.isArray(config.setlist)) {
    const setlist = config.setlist as SetlistSong[];
    const songKeys = setlist
      .map((s) => normalizeSongKeySafe(s.title))
      .filter((k): k is string => k !== null);

    // If setlist has songIds, we should be using the entries path
    // but handle gracefully for backwards compat
    updatePayload.config = {
      ...config,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setlist: setlist.map(({ songId, charts, ...rest }) => rest),
    };
    void songKeys; // suppress unused
  }

  const { data, error } = await supabase
    .from('shows')
    .update(updatePayload)
    .eq('id', id)
    .select('updated_at, slug')
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 403 });
  }

  return Response.json({ updated_at: data.updated_at, slug: data.slug });
}
