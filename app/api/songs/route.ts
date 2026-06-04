import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKey } from '@/lib/normalize';

// GET /api/songs — list owner's song library
// Uses admin client (setlist_entries has no client RLS policies, so show_count needs service_role)
export async function GET(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Determine which owner's library to show
  const ownerParam = request.nextUrl.searchParams.get('owner_id');
  const ownerId = ownerParam || user.id;

  // If not the owner, verify collaborator access
  if (ownerId !== user.id) {
    const admin = getSupabaseAdmin();
    const { data: collab } = await admin
      .from('show_collaborators')
      .select('show_id')
      .eq('user_id', user.id)
      .limit(1);

    // Check if any of those shows belong to this owner
    if (collab && collab.length > 0) {
      const showIds = collab.map((c) => c.show_id);
      const { data: ownerShow } = await admin
        .from('shows')
        .select('id')
        .eq('owner_id', ownerId)
        .in('id', showIds)
        .limit(1);

      if (!ownerShow || ownerShow.length === 0) {
        return Response.json({ error: 'Not authorized' }, { status: 403 });
      }
    } else {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }
  }

  const admin = getSupabaseAdmin();
  const { data: songs, error } = await admin.rpc('get_songs_with_counts', {
    p_owner_id: ownerId,
  });

  if (error) {
    // Fallback: RPC may not exist yet, query directly
    const { data: fallbackSongs, error: fbError } = await admin
      .from('songs')
      .select('*')
      .eq('owner_id', ownerId)
      .order('title');

    if (fbError) {
      return Response.json({ error: fbError.message }, { status: 500 });
    }
    return Response.json({ songs: fallbackSongs || [], is_owner: ownerId === user.id });
  }

  return Response.json({ songs: songs || [], is_owner: ownerId === user.id });
}

// POST /api/songs — create a song (owner-only)
export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json();
  const { title, key, lead, notes } = body;

  if (typeof title !== 'string' || !title.trim()) {
    return Response.json({ error: 'Title is required' }, { status: 400 });
  }

  const trimmedTitle = title.trim().slice(0, 200);
  let songKey: string;
  try {
    songKey = normalizeSongKey(trimmedTitle);
  } catch {
    return Response.json({ error: 'Title must contain at least one letter or number' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('songs')
    .insert({
      owner_id: user.id,
      song_key: songKey,
      title: trimmedTitle,
      key: key || null,
      lead: lead || '',
      notes: notes || '',
    })
    .select('id, song_key, title, key, lead, notes, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return Response.json({ error: 'A song with this title already exists in your library' }, { status: 409 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data, { status: 201 });
}
