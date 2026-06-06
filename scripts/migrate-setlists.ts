/**
 * Seed script: populate songs from existing show configs + chart_library,
 * convert inline setlists to setlist_entries, set setlist_migrated = true.
 *
 * Run with: npx tsx scripts/migrate-setlists.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from '@supabase/supabase-js';

const LEADING_ARTICLES = /^(the|a|an)\s+/i;

function normalizeSongKey(title: string): string | null {
  const key = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_ARTICLES, '');
  return key || null;
}

interface SetlistItem {
  title: string;
  key?: string;
  lead?: string;
  notes?: string;
  sceneNote?: string;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const admin = createClient(url, key);

  // 1. Gather all existing song_keys from chart_library
  const { data: charts } = await admin
    .from('chart_library')
    .select('owner_id, song_key, song_title');

  const chartSongs = new Map<string, { owner_id: string; song_key: string; title: string }>();
  for (const c of charts || []) {
    const mapKey = `${c.owner_id}:${c.song_key}`;
    if (!chartSongs.has(mapKey)) {
      chartSongs.set(mapKey, { owner_id: c.owner_id, song_key: c.song_key, title: c.song_title });
    }
  }

  // 2. Gather songs from show setlists
  const { data: shows } = await admin
    .from('shows')
    .select('id, owner_id, config, setlist_migrated')
    .eq('setlist_migrated', false);

  if (!shows || shows.length === 0) {
    console.log('No unmigrated shows found.');
    return;
  }

  // 3. Build unique songs per owner
  const ownerSongs = new Map<string, Map<string, { title: string; key?: string; lead?: string; notes?: string }>>();

  // From chart_library first
  for (const [, cs] of chartSongs) {
    if (!ownerSongs.has(cs.owner_id)) ownerSongs.set(cs.owner_id, new Map());
    const songs = ownerSongs.get(cs.owner_id)!;
    if (!songs.has(cs.song_key)) {
      songs.set(cs.song_key, { title: cs.title });
    }
  }

  // From show setlists
  for (const show of shows) {
    const setlist = (show.config as { setlist?: SetlistItem[] })?.setlist || [];
    if (!ownerSongs.has(show.owner_id)) ownerSongs.set(show.owner_id, new Map());
    const songs = ownerSongs.get(show.owner_id)!;

    for (const item of setlist) {
      if (!item.title) continue;
      const songKey = normalizeSongKey(item.title);
      if (!songKey) continue;

      if (!songs.has(songKey)) {
        songs.set(songKey, {
          title: item.title,
          key: item.key,
          lead: item.lead,
          notes: item.notes,
        });
      }
    }
  }

  // 4. Insert songs (skip if exists)
  let songsCreated = 0;
  for (const [ownerId, songs] of ownerSongs) {
    for (const [songKey, meta] of songs) {
      const { error } = await admin
        .from('songs')
        .insert({
          owner_id: ownerId,
          song_key: songKey,
          title: meta.title,
          key: meta.key || null,
          lead: meta.lead || '',
          notes: meta.notes || '',
        });

      if (!error) {
        songsCreated++;
      } else if (error.code !== '23505') {
        console.error(`Failed to insert song "${meta.title}" for ${ownerId}:`, error.message);
      }
    }
  }
  console.log(`Created ${songsCreated} songs.`);

  // 5. Convert inline setlists to setlist_entries
  let showsMigrated = 0;
  for (const show of shows) {
    const setlist = (show.config as { setlist?: SetlistItem[] })?.setlist || [];
    if (setlist.length === 0) {
      // No setlist — just mark as migrated
      await admin.from('shows').update({ setlist_migrated: true }).eq('id', show.id);
      showsMigrated++;
      continue;
    }

    const entries = [];
    let position = 0;

    for (const item of setlist) {
      if (!item.title) continue;
      const songKey = normalizeSongKey(item.title);
      if (!songKey) continue;

      position++;

      // Look up song ID
      const { data: song } = await admin
        .from('songs')
        .select('id, key, lead, notes')
        .eq('owner_id', show.owner_id)
        .eq('song_key', songKey)
        .single();

      if (!song) {
        console.warn(`Song not found for "${item.title}" in show ${show.id}, skipping.`);
        continue;
      }

      // Compute overrides (three-state)
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

    if (entries.length > 0) {
      const { error } = await admin.from('setlist_entries').insert(entries);
      if (error) {
        console.error(`Failed to insert entries for show ${show.id}:`, error.message);
        continue;
      }
    }

    await admin.from('shows').update({ setlist_migrated: true }).eq('id', show.id);
    showsMigrated++;
  }

  console.log(`Migrated ${showsMigrated} shows.`);
  console.log('Done.');
}

main().catch(console.error);
