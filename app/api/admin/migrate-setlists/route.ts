import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKeySafe } from '@/lib/normalize';
import { checkRateLimit, getIp, authenticate } from '@/lib/admin-rate-limit';

interface SetlistItem {
  title: string;
  key?: string;
  lead?: string;
  notes?: string;
  sceneNote?: string;
}

// POST /api/admin/migrate-setlists — one-shot backfill of the song library.
// Ports scripts/migrate-setlists.ts so it can run on Vercel (no local box).
// Auth: Authorization: Bearer <ADMIN_SECRET>.
// Pass ?dry_run=true to preview counts without writing.
// Run migration 006_songs.sql in the Supabase SQL editor BEFORE calling this.
export async function POST(request: NextRequest) {
  const ip = getIp(request);
  if (!checkRateLimit(ip, 'migrate-setlists')) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }
  if (!authenticate(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun = request.nextUrl.searchParams.get('dry_run') === 'true';
  const admin = getSupabaseAdmin();
  const warnings: string[] = [];

  // Precheck: confirm migration 006 has been applied.
  const { error: schemaErr } = await admin.from('songs').select('id').limit(1);
  if (schemaErr) {
    return Response.json(
      { error: 'songs table not found — apply migration 006_songs.sql in the Supabase SQL editor first.', detail: schemaErr.message },
      { status: 412 },
    );
  }

  // 1. Existing songs from chart_library.
  const { data: charts } = await admin
    .from('chart_library')
    .select('owner_id, song_key, song_title');

  // 2. Unmigrated shows.
  const { data: shows } = await admin
    .from('shows')
    .select('id, owner_id, config, setlist_migrated')
    .eq('setlist_migrated', false);

  if (!shows || shows.length === 0) {
    return Response.json({ dry_run: dryRun, songs_created: 0, shows_migrated: 0, message: 'No unmigrated shows found.', warnings });
  }

  // 3. Build unique songs per owner (chart_library first, then setlists).
  const ownerSongs = new Map<string, Map<string, { title: string; key?: string; lead?: string; notes?: string }>>();

  for (const c of charts || []) {
    if (!c.song_key) continue;
    if (!ownerSongs.has(c.owner_id)) ownerSongs.set(c.owner_id, new Map());
    const songs = ownerSongs.get(c.owner_id)!;
    if (!songs.has(c.song_key)) songs.set(c.song_key, { title: c.song_title });
  }

  for (const show of shows) {
    const setlist = (show.config as { setlist?: SetlistItem[] })?.setlist || [];
    if (!ownerSongs.has(show.owner_id)) ownerSongs.set(show.owner_id, new Map());
    const songs = ownerSongs.get(show.owner_id)!;
    for (const item of setlist) {
      if (!item.title) continue;
      const songKey = normalizeSongKeySafe(item.title);
      if (!songKey) continue;
      if (!songs.has(songKey)) {
        songs.set(songKey, { title: item.title, key: item.key, lead: item.lead, notes: item.notes });
      }
    }
  }

  // 4. Insert songs (skip duplicates).
  let songsCreated = 0;
  for (const [ownerId, songs] of ownerSongs) {
    for (const [songKey, meta] of songs) {
      if (dryRun) { songsCreated++; continue; }
      const { error } = await admin.from('songs').insert({
        owner_id: ownerId,
        song_key: songKey,
        title: meta.title,
        key: meta.key || null,
        lead: meta.lead || '',
        notes: meta.notes || '',
      });
      if (!error) songsCreated++;
      else if (error.code !== '23505') warnings.push(`song "${meta.title}" (${ownerId}): ${error.message}`);
    }
  }

  // 5. Convert inline setlists to setlist_entries + flip setlist_migrated.
  let showsMigrated = 0;
  for (const show of shows) {
    const setlist = (show.config as { setlist?: SetlistItem[] })?.setlist || [];

    if (setlist.length === 0) {
      if (!dryRun) await admin.from('shows').update({ setlist_migrated: true }).eq('id', show.id);
      showsMigrated++;
      continue;
    }

    const entries: Array<{
      show_id: string; song_id: string; position: number;
      key_override: string | null; lead_override: string | null;
      notes_override: string | null; scene_note: string | null;
    }> = [];
    let position = 0;

    for (const item of setlist) {
      if (!item.title) continue;
      const songKey = normalizeSongKeySafe(item.title);
      if (!songKey) {
        warnings.push(`show ${show.id}: skipped unnormalizable title "${item.title}"`);
        continue;
      }
      position++;

      const { data: song } = await admin
        .from('songs')
        .select('id, key, lead, notes')
        .eq('owner_id', show.owner_id)
        .eq('song_key', songKey)
        .single();

      if (!song) {
        warnings.push(`show ${show.id}: song not found for "${item.title}", skipped`);
        continue;
      }

      const keyOverride = item.key !== undefined
        ? (item.key === (song.key ?? '') ? null : (item.key || ''))
        : null;
      const leadOverride = (item.lead ?? '') === song.lead ? null : (item.lead ?? '');
      const notesOverride = (item.notes ?? '') === song.notes ? null : (item.notes ?? '');

      entries.push({
        show_id: show.id,
        song_id: song.id,
        position,
        key_override: keyOverride,
        lead_override: leadOverride,
        notes_override: notesOverride,
        scene_note: item.sceneNote || null,
      });
    }

    if (dryRun) { showsMigrated++; continue; }

    if (entries.length > 0) {
      // Retry-safe: clear any partial entries before re-inserting.
      await admin.from('setlist_entries').delete().eq('show_id', show.id);
      const { error } = await admin.from('setlist_entries').insert(entries);
      if (error) {
        warnings.push(`show ${show.id}: entries insert failed — ${error.message}`);
        continue;
      }
    }

    await admin.from('shows').update({ setlist_migrated: true }).eq('id', show.id);
    showsMigrated++;
  }

  return Response.json({
    dry_run: dryRun,
    songs_created: songsCreated,
    shows_migrated: showsMigrated,
    shows_scanned: shows.length,
    warnings,
  });
}
