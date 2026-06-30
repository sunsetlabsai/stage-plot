import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKeySafe } from '@/lib/normalize';
import { resolveOverride } from '@/lib/overrides';
import type { SetlistSong } from '@/lib/types';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// Hydrate setlist from setlist_entries + songs tables
async function hydrateFromEntries(
  admin: ReturnType<typeof getSupabaseAdmin>,
  showId: string,
): Promise<SetlistSong[]> {
  const { data: entries } = await admin
    .from('setlist_entries')
    .select('id, song_id, position, key_override, lead_override, notes_override, scene_note')
    .eq('show_id', showId)
    .order('position');

  if (!entries || entries.length === 0) return [];

  const songIds = [...new Set(entries.map((e) => e.song_id))];
  const { data: songs } = await admin
    .from('songs')
    .select('id, title, key, lead, notes, bpm')
    .in('id', songIds);

  const songsMap = Object.fromEntries(
    (songs || []).map((s) => [s.id, s]),
  );

  return entries.map((row) => {
    const song = songsMap[row.song_id];
    return {
      id: row.id,
      songId: row.song_id,
      position: row.position,
      title: song?.title ?? 'Unknown',
      key: resolveOverride(row.key_override, song?.key),
      lead: resolveOverride(row.lead_override, song?.lead, '') ?? '',
      notes: resolveOverride(row.notes_override, song?.notes, '') ?? '',
      sceneNote: row.scene_note ?? undefined,
      // 5b chunk 2: the stated tempo for the clock's static-BPM rung. Migrated songs
      // carry it; a legacy/inline song has none ⇒ undefined ⇒ manual rung (honest floor).
      bpm: song?.bpm ?? null,
    };
  });
}

// GET /api/shows/[owner]/[show] — anonymous show resolution by owner + slug (no auth required)
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; show: string }> },
) {
  const { owner, show } = await params;

  if (!owner || !SLUG_RE.test(owner) || !show || !SLUG_RE.test(show)) {
    return Response.json({ error: 'Invalid owner or show slug' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Resolve owner_slug -> owner_id
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('owner_slug', owner)
    .single();

  if (!profile) {
    return Response.json({ error: 'Owner not found' }, { status: 404 });
  }

  // Fetch show by (owner_id, slug) pair
  const { data: showData, error } = await admin
    .from('shows')
    .select('id, config, name, venue, show_date, owner_id, setlist_migrated')
    .eq('owner_id', profile.id)
    .eq('slug', show)
    .single();

  if (error || !showData) {
    return Response.json({ error: 'Show not found' }, { status: 404 });
  }

  // Dual-read: hydrate from entries if migrated, otherwise from inline config
  let setlist: SetlistSong[];
  if (showData.setlist_migrated) {
    setlist = await hydrateFromEntries(admin, showData.id);
  } else {
    setlist = ((showData.config as { setlist?: SetlistSong[] })?.setlist ?? []);
  }

  // Inject hydrated setlist into config
  const config = { ...(showData.config as Record<string, unknown>), setlist };

  // Resolve charts from owner's library by normalized song titles
  const songKeys = setlist
    .map((s) => normalizeSongKeySafe(s.title))
    .filter((k): k is string => k !== null);

  const chartsBySong: Record<string, Array<Record<string, unknown>>> = {};

  if (songKeys.length > 0) {
    const { data: charts } = await admin
      .from('chart_library')
      .select('id, song_key, role, file_name, storage_path, mime_type, file_size, updated_at, source_spec')
      .eq('owner_id', showData.owner_id)
      .in('song_key', songKeys);

    for (const c of charts || []) {
      if (!chartsBySong[c.song_key]) chartsBySong[c.song_key] = [];
      // Builder origin + authored key (chunk 4). is_builder = a stored source_spec;
      // authored_key = its renderKey (informational — the live key is resolved in
      // chrome from the setlist, never this field). charted_key is reserved (null)
      // until import-time key capture exists.
      const sourceSpec = c.source_spec as { renderKey?: string } | null;
      chartsBySong[c.song_key].push({
        id: c.id,
        song_key: c.song_key,
        role: c.role,
        file_name: c.file_name,
        mime_type: c.mime_type,
        file_size: c.file_size,
        updated_at: c.updated_at,
        url: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/charts/${c.storage_path}`,
        is_builder: sourceSpec != null,
        authored_key: sourceSpec?.renderKey ?? null,
        charted_key: null,
      });
    }
  }

  return Response.json({
    config,
    charts: chartsBySong,
    slug: show,
    show_id: showData.id,
    owner_id: showData.owner_id,
    setlist_migrated: showData.setlist_migrated,
  });
}
