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

  // If not the owner, verify collaborator access (must collaborate on a show owned by this owner)
  if (ownerId !== user.id) {
    const admin = getSupabaseAdmin();
    // Direct join: find any show where this user is a collaborator AND the show is owned by ownerId
    const { data: collabCheck } = await admin
      .from('show_collaborators')
      .select('show_id, shows!inner(owner_id)')
      .eq('user_id', user.id)
      .eq('shows.owner_id', ownerId)
      .limit(1);

    if (!collabCheck || collabCheck.length === 0) {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }
  }

  const admin = getSupabaseAdmin();

  // Query songs with chart_count and show_count via subqueries
  const { data: songs, error } = await admin
    .from('songs')
    .select('*')
    .eq('owner_id', ownerId)
    .order('title');

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Enrich with counts (setlist_entries has no client RLS, so admin client is required)
  // Batch-fetch all chart counts and show counts for efficiency
  const songKeys = songs?.map((s) => s.song_key) || [];
  const songIds = songs?.map((s) => s.id) || [];

  const chartCounts: Record<string, number> = {};
  const chartsBySong: Record<string, Array<Record<string, unknown>>> = {};
  let showCounts: Record<string, number> = {};

  if (songKeys.length > 0) {
    const { data: charts } = await admin
      .from('chart_library')
      .select('id, song_key, role, file_name, storage_path, mime_type, updated_at')
      .eq('owner_id', ownerId)
      .in('song_key', songKeys);

    for (const c of charts || []) {
      chartCounts[c.song_key] = (chartCounts[c.song_key] || 0) + 1;
      if (!chartsBySong[c.song_key]) chartsBySong[c.song_key] = [];
      // Same shape the show GET uses so charts attach + cache identically
      chartsBySong[c.song_key].push({
        role: c.role,
        url: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/charts/${c.storage_path}`,
        fileId: c.id,
        mimeType: c.mime_type,
        modifiedTime: c.updated_at,
        label: c.file_name,
      });
    }
  }

  if (songIds.length > 0) {
    // Fetch distinct show_ids per song for accurate show_count
    const { data: entries } = await admin
      .from('setlist_entries')
      .select('song_id, show_id')
      .in('song_id', songIds);

    const songShowSets: Record<string, Set<string>> = {};
    for (const e of entries || []) {
      if (!songShowSets[e.song_id]) songShowSets[e.song_id] = new Set();
      songShowSets[e.song_id].add(e.show_id);
    }
    showCounts = Object.fromEntries(
      Object.entries(songShowSets).map(([k, v]) => [k, v.size]),
    );
  }

  const enriched = (songs || []).map((song) => ({
    ...song,
    chart_count: chartCounts[song.song_key] || 0,
    charts: chartsBySong[song.song_key] || [],
    show_count: showCounts[song.id] || 0,
  }));

  return Response.json({ songs: enriched, is_owner: ownerId === user.id });
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
