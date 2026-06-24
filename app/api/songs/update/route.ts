import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKey } from '@/lib/normalize';

// PUT /api/songs/update — update a song (owner-only)
export async function PUT(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json();
  const { id, title, artist, key, lead, notes } = body;

  if (!id) {
    return Response.json({ error: 'Song id is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Verify ownership
  const { data: existing } = await admin
    .from('songs')
    .select('id, song_key, owner_id')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single();

  if (!existing) {
    return Response.json({ error: 'Song not found or not owned' }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};
  if (artist !== undefined) updates.artist = artist || '';
  if (lead !== undefined) updates.lead = lead;
  if (notes !== undefined) updates.notes = notes;
  if (key !== undefined) updates.key = key || null;

  // If title changed, recompute song_key and cascade to chart_library
  if (typeof title === 'string' && title.trim()) {
    const trimmedTitle = title.trim().slice(0, 200);
    let newSongKey: string;
    try {
      newSongKey = normalizeSongKey(trimmedTitle);
    } catch {
      return Response.json({ error: 'Title must contain at least one letter or number' }, { status: 400 });
    }

    updates.title = trimmedTitle;
    updates.song_key = newSongKey;

    // Cascade song_key to chart_library if it changed
    if (newSongKey !== existing.song_key) {
      // Check for collision
      const { data: collision } = await admin
        .from('songs')
        .select('id')
        .eq('owner_id', user.id)
        .eq('song_key', newSongKey)
        .neq('id', id)
        .limit(1);

      if (collision && collision.length > 0) {
        return Response.json({ error: 'A song with this title already exists in your library' }, { status: 409 });
      }

      await admin
        .from('chart_library')
        .update({ song_key: newSongKey, song_title: trimmedTitle })
        .eq('owner_id', user.id)
        .eq('song_key', existing.song_key);
    }
  }

  const { data, error } = await admin
    .from('songs')
    .update(updates)
    .eq('id', id)
    .select('id, song_key, title, artist, key, lead, notes, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return Response.json({ error: 'A song with this title already exists in your library' }, { status: 409 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
