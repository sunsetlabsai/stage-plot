# Design: Song Library Manager

**Status:** Draft v1.3 (addresses Codex rounds 1-2)
**Date:** 2025-06-03
**Depends on:** Supabase backend (migration 003 chart_library)

---

## Problem

Songs exist only as inline JSON in show configs — no canonical entity, no cross-show visibility, no standalone CRUD. Charts are matched by normalized title (`song_key`) in `chart_library`, but there's no `songs` table to anchor them. Users can't browse, search, or manage their song catalog outside of individual shows. Editing a song's key or lead requires updating every show individually.

---

## Architecture Decision: Reference, Not Copy

Show setlists **reference** songs by ID from the owner's library. The `songs` table is the single source of truth for song metadata. Shows store an ordered list of references with optional per-show overrides.

**Why:**
- One edit updates everywhere — fix a typo once, not in every show
- Charts are already library-scoped (`chart_library`); songs should match
- No data drift between shows
- Natural foundation for "used in X shows" and cross-show reporting

**Per-show overrides:** A setlist entry can override `key`, `lead`, and `notes` for a specific show (e.g., "Rachel sings lead tonight" or "key change for this venue"). Null override = use library default. This preserves show-level flexibility without polluting the canonical record.

---

## Permissions Model

**Songs:**
- **Owner:** Full CRUD (create, read, update, delete).
- **Editor collaborators:** Read-only. Can browse the owner's song library for autocomplete when adding songs to setlists. Cannot create, edit, or delete songs. If an editor needs a song that doesn't exist, they ask the owner to create it (or they type a title inline, which the *owner's* next save will persist — see "Add from Library" below).

**Setlist entries:**
- **Owner + editors:** Can add/remove/reorder songs in a show's setlist and set per-show overrides. Matches existing `shows` editor permissions.

**Implementation:** All song and setlist writes go through server-side API routes using the admin (service_role) client. The API verifies the caller is the owner (for song CRUD) or owner/editor (for setlist mutations) before writing.

---

## Data Model

### New `songs` table

```sql
-- Migration 006: Canonical songs table + setlist entries + RPCs

CREATE TABLE songs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  song_key text NOT NULL,
  title text NOT NULL,
  key text,
  lead text DEFAULT '',
  notes text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(owner_id, song_key)
);

ALTER TABLE songs ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER set_songs_updated_at
  BEFORE UPDATE ON songs
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

CREATE INDEX songs_owner_idx ON songs(owner_id);

-- RLS: owner can read/write; collaborators can read (for autocomplete)
CREATE POLICY "Owner full access" ON songs
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Collaborator read" ON songs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM show_collaborators sc
      JOIN shows s ON s.id = sc.show_id
      WHERE s.owner_id = songs.owner_id
        AND sc.user_id = auth.uid()
    )
  );
```

### New `setlist_entries` table

```sql
CREATE TABLE setlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id uuid NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  song_id uuid NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  key_override text,
  lead_override text,
  notes_override text,
  scene_note text,
  UNIQUE(show_id, position)
);

ALTER TABLE setlist_entries ENABLE ROW LEVEL SECURITY;

CREATE INDEX setlist_entries_show_idx ON setlist_entries(show_id);
CREATE INDEX setlist_entries_song_idx ON setlist_entries(song_id);

-- RLS: no direct client policies. All access via service_role through RPCs/API routes.
-- RLS is enabled to block direct client access; only service_role bypasses RLS.
```

**ON DELETE RESTRICT on song_id:** Prevents accidental song deletion when referenced by shows. The song delete RPC explicitly removes entries (with position renumbering) before deleting the song.

### Migration marker on shows

```sql
ALTER TABLE shows ADD COLUMN setlist_migrated boolean NOT NULL DEFAULT false;
```

Distinguishes "not migrated" (read inline `config.setlist`) from "migrated with empty setlist" (read empty `setlist_entries`). Set to `true` by the migration script after converting each show's inline setlist to entries.

### RPC security

All RPCs use `SECURITY DEFINER` with locked-down access:

```sql
-- Revoke public/anon/authenticated access to RPCs
-- (applied after each CREATE FUNCTION below)
REVOKE EXECUTE ON FUNCTION rpc_save_show(...) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_save_show(...) TO service_role;

-- Safe search_path on all definer functions
-- (included in each CREATE FUNCTION via SET search_path = public)
```

Only the service_role (used by admin client in API routes) can call RPCs. Direct client calls are blocked.

---

## Atomic Operations

### `rpc_save_show(show_id, config, setlist_entries[], inline_setlist_json)`

**One transaction for the entire show save.** Updates show metadata/config, replaces setlist_entries, and writes inline `config.setlist` for dual-write compatibility — all atomically.

```sql
CREATE OR REPLACE FUNCTION rpc_save_show(
  p_show_id uuid,
  p_config jsonb,
  p_name text,
  p_venue text,
  p_show_date text,
  p_entries jsonb,           -- array of { song_id, position, key_override, lead_override, notes_override, scene_note }
  p_inline_setlist jsonb     -- hydrated setlist for dual-write into config.setlist (null to skip)
) RETURNS jsonb AS $$
DECLARE
  v_final_config jsonb;
  v_result jsonb;
BEGIN
  -- Merge inline setlist into config for dual-write
  IF p_inline_setlist IS NOT NULL THEN
    v_final_config := jsonb_set(p_config, '{setlist}', p_inline_setlist);
  ELSE
    v_final_config := p_config;
  END IF;

  -- Update show metadata + config
  UPDATE shows SET
    config = v_final_config,
    name = p_name,
    venue = NULLIF(p_venue, ''),
    show_date = NULLIF(p_show_date, '')
  WHERE id = p_show_id;

  -- Replace setlist entries
  DELETE FROM setlist_entries WHERE show_id = p_show_id;

  IF p_entries IS NOT NULL AND jsonb_array_length(p_entries) > 0 THEN
    INSERT INTO setlist_entries (show_id, song_id, position, key_override, lead_override, notes_override, scene_note)
    SELECT
      p_show_id,
      (e->>'song_id')::uuid,
      (e->>'position')::integer,
      NULLIF(e->>'key_override', ''),
      NULLIF(e->>'lead_override', ''),
      NULLIF(e->>'notes_override', ''),
      NULLIF(e->>'scene_note', '')
    FROM jsonb_array_elements(p_entries) AS e;
  END IF;

  SELECT jsonb_build_object(
    'updated_at', (SELECT updated_at FROM shows WHERE id = p_show_id),
    'slug', (SELECT slug FROM shows WHERE id = p_show_id)
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION rpc_save_show FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_save_show TO service_role;
```

### `rpc_create_song_and_add_to_setlist(...)`

Creates a new song + setlist entry atomically. Owner-only (verified by API route).

```sql
CREATE OR REPLACE FUNCTION rpc_create_song_and_add_to_setlist(
  p_owner_id uuid,
  p_title text,
  p_song_key text,
  p_key text,
  p_lead text,
  p_notes text,
  p_show_id uuid,
  p_position integer
) RETURNS uuid AS $$
DECLARE
  v_song_id uuid;
BEGIN
  INSERT INTO songs (owner_id, song_key, title, key, lead, notes)
  VALUES (p_owner_id, p_song_key, p_title, NULLIF(p_key, ''), p_lead, p_notes)
  RETURNING id INTO v_song_id;

  INSERT INTO setlist_entries (show_id, song_id, position)
  VALUES (p_show_id, v_song_id, p_position);

  RETURN v_song_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION rpc_create_song_and_add_to_setlist FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_create_song_and_add_to_setlist TO service_role;
```

### `rpc_delete_song(song_id, owner_id)`

Deletes a song, renumbers affected setlists, deletes chart_library entries. **Returns storage_paths** for blob cleanup.

```sql
CREATE OR REPLACE FUNCTION rpc_delete_song(
  p_song_id uuid,
  p_owner_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_song_key text;
  v_affected_shows uuid[];
  v_storage_paths text[];
BEGIN
  -- Verify ownership
  SELECT song_key INTO v_song_key FROM songs WHERE id = p_song_id AND owner_id = p_owner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Song not found or not owned';
  END IF;

  -- Collect affected shows
  SELECT array_agg(DISTINCT show_id) INTO v_affected_shows
  FROM setlist_entries WHERE song_id = p_song_id;

  -- Delete setlist entries
  DELETE FROM setlist_entries WHERE song_id = p_song_id;

  -- Renumber positions in affected shows
  IF v_affected_shows IS NOT NULL THEN
    FOR i IN 1..array_length(v_affected_shows, 1) LOOP
      WITH numbered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY position) AS new_pos
        FROM setlist_entries WHERE show_id = v_affected_shows[i]
      )
      UPDATE setlist_entries SET position = numbered.new_pos
      FROM numbered WHERE setlist_entries.id = numbered.id;
    END LOOP;
  END IF;

  -- Collect storage paths before deleting chart rows
  SELECT array_agg(storage_path) INTO v_storage_paths
  FROM chart_library WHERE owner_id = p_owner_id AND song_key = v_song_key;

  -- Delete chart_library entries
  DELETE FROM chart_library WHERE owner_id = p_owner_id AND song_key = v_song_key;

  -- Delete the song
  DELETE FROM songs WHERE id = p_song_id;

  RETURN jsonb_build_object(
    'affected_shows', to_jsonb(COALESCE(v_affected_shows, '{}'::uuid[])),
    'storage_paths', to_jsonb(COALESCE(v_storage_paths, '{}'::text[]))
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION rpc_delete_song FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_delete_song TO service_role;
```

The API route calls this RPC, then deletes storage blobs using the returned `storage_paths`.

---

## Show Resolution + PR A Compatibility

### Adapter: emit today's `SetlistSong` shape

The hydrated result must match the existing `SetlistSong` interface exactly so all client code works unchanged:

```typescript
// In the show resolution API, after hydration query:
const setlist: SetlistSong[] = hydratedRows.map(row => ({
  id: row.entry_id,                                    // maps to SetlistSong.id
  position: row.position,
  title: row.title,
  key: row.key_override ?? row.default_key ?? undefined,
  lead: row.lead_override ?? row.default_lead ?? '',
  notes: row.notes_override ?? row.default_notes ?? '',
  sceneNote: row.scene_note ?? undefined,              // camelCase, not snake_case
  // charts hydrated separately (same as today)
}));
```

This is injected into `config.setlist` before returning. The client receives the exact same `AppConfig` shape it always has. Export/import (`show-file.ts`), AI (`agent.ts`), offline cache, rendering — all unchanged.

### Dual-read

```typescript
let setlist: SetlistSong[];
if (showData.setlist_migrated) {
  setlist = await hydrateFromEntries(admin, showData.id, showData.owner_id);
} else {
  setlist = (showData.config as { setlist?: SetlistSong[] })?.setlist ?? [];
}
const config = { ...showData.config, setlist };
```

### Dual-write

`rpc_save_show` accepts both `p_entries` (structured) and `p_inline_setlist` (hydrated JSON for `config.setlist`). Both are written atomically. The API route hydrates the setlist entries into `SetlistSong[]` format and passes both to the RPC.

---

## API Routes

### `GET /api/songs` — List owner's song library

Uses authenticated client (RLS allows owner + collaborator read):

```sql
SELECT s.*,
  (SELECT COUNT(*) FROM chart_library cl
   WHERE cl.owner_id = s.owner_id AND cl.song_key = s.song_key) AS chart_count,
  (SELECT COUNT(DISTINCT se.show_id) FROM setlist_entries se
   WHERE se.song_id = s.id) AS show_count
FROM songs s
WHERE s.owner_id = $1
ORDER BY s.title;
```

### `POST /api/songs` — Create a song (owner-only)

Admin client, after verifying caller is the song's owner. Normalizes title -> `song_key`. Returns 409 on collision.

### `PUT /api/songs` — Update a song (owner-only)

If title changes, recomputes `song_key`. Cascades to `chart_library`. Returns 409 on collision.

### `DELETE /api/songs` — Delete a song (owner-only)

Calls `rpc_delete_song` via admin client. Deletes storage blobs from returned `storage_paths`. Confirms with user if `show_count > 0`.

### `PUT /api/shows/update` — Save show (updated)

Calls `rpc_save_show` via admin client, after verifying caller is owner or editor. Passes config + setlist entries + inline setlist JSON (for dual-write).

---

## UI

### Song Library page at `/library`

New top-level route, authenticated only.

```
+--------------------------------------------------+
|  Song Library                     [+ Add Song]   |
|                                                  |
|  Search songs...                                 |
|                                                  |
|  +----------------------------------------------+|
|  | Title          Key   Lead     Charts  |  ...  ||
|  |----------------------------------------------||
|  | Mustang Sally   E    Graham   Gtr Vox |  ...  ||
|  | Respect         C    Rachel   Gtr Vox |  ...  ||
|  | Superstition    Eb   Graham   Gtr     |  ...  ||
|  +----------------------------------------------+|
+--------------------------------------------------+
```

**Columns:** Title, Key (pill), Lead, Charts (role pills), Actions (Edit, Delete w/ confirmation)

**Expanded row:** Inline edit fields + chart upload/delete + "Used in X shows"

**Search:** Client-side filter on title.

### Config tab: "Add from Library" autocomplete

- "+ Add Song" opens a text input with typeahead against the owner's song library (via `GET /api/songs`, available to editors via collaborator-read RLS)
- Selecting a library song adds a `setlist_entries` reference with no overrides
- Typing a new title that doesn't match any library song: **owner sees "Create & Add"** button (creates song via `rpc_create_song_and_add_to_setlist`). **Editors cannot create** — they see "Song not found. Ask the show owner to add it to the library."
- Inline editing of key/lead/notes in the setlist sets per-show overrides
- "Reset to default" clears overrides

### Dashboard nav update

Add "Library" link.

---

## Middleware / Auth

- `/library`: redirect to `/sign-in` if not authenticated.
- `/api/songs` GET: authenticated client with RLS (owner + collaborator read).
- `/api/songs` POST/PUT/DELETE: admin client, owner-only verification.
- `/api/shows/update`: admin client, owner-or-editor verification.

---

## Files Changed

| File | Change |
|------|--------|
| `supabase/migrations/006_songs.sql` | `songs`, `setlist_entries`, 3 RPCs with REVOKE/GRANT, `shows.setlist_migrated` |
| `lib/types.ts` | `Song`, `SetlistEntry` types (internal). `SetlistSong` unchanged (adapter handles). |
| `app/api/songs/route.ts` | GET (authenticated, subquery counts) + POST (admin, owner-only) |
| `app/api/songs/update/route.ts` | PUT (admin, owner-only, song_key cascade) |
| `app/api/songs/delete/route.ts` | DELETE (admin, rpc_delete_song + blob cleanup) |
| `app/api/shows/[owner]/[show]/route.ts` | Hydrate setlist via adapter (entries or inline) |
| `app/api/shows/update/route.ts` | Save via rpc_save_show (atomic config + entries + inline) |
| `app/library/page.tsx` | New song library page |
| `app/dashboard/page.tsx` | Add "Library" nav link |
| `app/[owner]/[show]/page.tsx` | Config tab autocomplete, override UI, owner-vs-editor gate |
| `middleware.ts` | Add `/library` auth protection |
| `scripts/migrate-setlists.ts` | Seed songs, convert inline setlists, set migrated flag |

---

## Migration Strategy

1. **PR A — Additive:**
   - Migration 006: tables, RPCs, migrated flag
   - Seed script: populate songs, convert inline setlists to entries, set `setlist_migrated = true`
   - Show resolution: adapter (dual-read, emits `SetlistSong[]`)
   - Show save: `rpc_save_show` (atomic, dual-write)
   - Library page + song API routes
   - Config tab autocomplete

2. **PR B — Cleanup (after UAT):**
   - Remove dual-write (stop writing inline `config.setlist`)
   - Remove dual-read fallback
   - Strip setlist from `shows.config` JSONB
   - Remove `setlist_migrated` flag

---

## Test Plan

### Song CRUD
- [ ] Create song (owner) — verify in library
- [ ] Create song (editor) — verify 403
- [ ] Duplicate title — verify 409
- [ ] Edit title — verify song_key cascades to chart_library
- [ ] Edit key/lead/notes — verify shows reflect updated defaults
- [ ] Delete song (not in shows) — verify song + charts + blobs deleted (paths from RPC)
- [ ] Delete song (in shows) — confirm prompt, entries removed, positions renumbered atomically

### Library page
- [ ] Load (owner) — verify songs with correct chart_count and show_count (no inflation)
- [ ] Load (editor collaborator) — verify read-only (no create/edit/delete)
- [ ] Search — instant filter
- [ ] Upload/delete chart from library

### Setlist (reference-based)
- [ ] Add library song (owner) — verify entry created
- [ ] Add library song (editor) — verify entry created
- [ ] Add new song (owner) — verify song + entry created atomically
- [ ] Add new song (editor) — verify blocked with guidance message
- [ ] Reorder — verify positions updated
- [ ] Set override — verify stored, library default unchanged
- [ ] Reset override — verify reverts
- [ ] Remove song from setlist — verify entry deleted, song stays in library

### Show resolution (adapter)
- [ ] Migrated show — hydrated from entries, emits `SetlistSong[]` shape
- [ ] Non-migrated show — hydrated from `config.setlist`
- [ ] Empty migrated setlist — returns `[]` (not legacy fallback)
- [ ] Verify `id`, `sceneNote` (camelCase), `charts` all present in hydrated output
- [ ] Offline fallback — cached hydrated data works
- [ ] YAML export/import — works with hydrated config

### Atomic operations
- [ ] rpc_save_show — verify config + entries + inline all written or none
- [ ] rpc_create_song_and_add_to_setlist — verify both rows or neither
- [ ] rpc_delete_song — verify entries removed, renumbered, charts deleted, paths returned

### Security
- [ ] RPCs not callable by authenticated/anon clients (REVOKE verified)
- [ ] setlist_entries not readable/writable by authenticated client (RLS enabled, no policies)
- [ ] songs readable by collaborators, writable only by owner
- [ ] /library unauthenticated — redirect to sign-in

### Migration
- [ ] Seed script populates songs from chart_library + show configs
- [ ] Setlist entries match original inline data
- [ ] `setlist_migrated` flag set per-show
- [ ] Dual-read: migrated uses entries, non-migrated uses inline
- [ ] Dual-write: both paths written atomically

---

## Out of Scope

- Cross-user song sharing
- Batch import from Spotify/Apple Music
- Song metadata beyond title/key/lead/notes
- "Sync library defaults to all shows" bulk action
- Setlist templates
