-- Migration 006: Canonical songs table, setlist_entries, RPCs
-- Part of Song Library feature (PR A — additive)

-- ── songs table ──────────────────────────────────────────────────────────────

create table songs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  song_key text not null check (song_key <> ''),
  title text not null check (title <> ''),
  key text,
  lead text default '',
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(owner_id, song_key)
);

alter table songs enable row level security;

create trigger set_songs_updated_at
  before update on songs
  for each row execute function extensions.moddatetime(updated_at);

create index songs_owner_idx on songs(owner_id);

-- RLS: read-only for all client access. All writes through service_role.
create policy "Owner read" on songs for select
  using (auth.uid() = owner_id);

create policy "Collaborator read" on songs for select
  using (
    exists (
      select 1 from show_collaborators sc
      join shows s on s.id = sc.show_id
      where s.owner_id = songs.owner_id
        and sc.user_id = auth.uid()
    )
  );

-- ── setlist_entries table ────────────────────────────────────────────────────

create table setlist_entries (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references shows(id) on delete cascade,
  song_id uuid not null references songs(id) on delete restrict,
  position integer not null check (position > 0),
  key_override text,
  lead_override text,
  notes_override text,
  scene_note text,
  unique(show_id, position) deferrable initially deferred
);

alter table setlist_entries enable row level security;

create index setlist_entries_show_idx on setlist_entries(show_id);
create index setlist_entries_song_idx on setlist_entries(song_id);

-- No client-facing RLS policies. All access via service_role through RPCs/API routes.

-- ── Migration marker on shows ────────────────────────────────────────────────

alter table shows add column setlist_migrated boolean not null default false;

-- ── RPC: rpc_save_show ───────────────────────────────────────────────────────

create or replace function rpc_save_show(
  p_show_id uuid,
  p_config jsonb,
  p_name text,
  p_venue text,
  p_show_date text,
  p_entries jsonb,
  p_inline_setlist jsonb
) returns jsonb as $$
declare
  v_final_config jsonb;
  v_result jsonb;
  v_owner_id uuid;
begin
  -- Verify show exists
  select owner_id into v_owner_id from shows where id = p_show_id;
  if not found then
    raise exception 'Show not found';
  end if;

  -- Verify owner invariant: every song_id must belong to this show's owner
  if p_entries is not null and jsonb_array_length(p_entries) > 0 then
    if exists (
      select 1 from jsonb_array_elements(p_entries) as e
      left join songs s on s.id = (e->>'song_id')::uuid and s.owner_id = v_owner_id
      where s.id is null
    ) then
      raise exception 'One or more songs not found or not owned by show owner';
    end if;
  end if;

  -- Merge inline setlist into config for dual-write
  if p_inline_setlist is not null then
    v_final_config := jsonb_set(p_config, '{setlist}', p_inline_setlist);
  else
    v_final_config := p_config;
  end if;

  -- Update show metadata + config + flip setlist_migrated
  update shows set
    config = v_final_config,
    name = p_name,
    venue = nullif(p_venue, ''),
    show_date = nullif(p_show_date, ''),
    setlist_migrated = true
  where id = p_show_id;

  -- Replace setlist entries
  delete from setlist_entries where show_id = p_show_id;

  -- Override semantics: null = use library default, '' = explicitly blank
  if p_entries is not null and jsonb_array_length(p_entries) > 0 then
    insert into setlist_entries (show_id, song_id, position, key_override, lead_override, notes_override, scene_note)
    select
      p_show_id,
      (e->>'song_id')::uuid,
      (e->>'position')::integer,
      e->>'key_override',
      e->>'lead_override',
      e->>'notes_override',
      e->>'scene_note'
    from jsonb_array_elements(p_entries) as e;
  end if;

  select jsonb_build_object(
    'updated_at', (select updated_at from shows where id = p_show_id),
    'slug', (select slug from shows where id = p_show_id)
  ) into v_result;

  return v_result;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function rpc_save_show from public, anon, authenticated;
grant execute on function rpc_save_show to service_role;

-- ── RPC: rpc_delete_song ─────────────────────────────────────────────────────

create or replace function rpc_delete_song(
  p_song_id uuid,
  p_owner_id uuid
) returns jsonb as $$
declare
  v_song_key text;
  v_affected_shows uuid[];
  v_storage_paths text[];
begin
  -- Verify ownership
  select song_key into v_song_key from songs where id = p_song_id and owner_id = p_owner_id;
  if not found then
    raise exception 'Song not found or not owned';
  end if;

  -- Collect affected shows
  select array_agg(distinct show_id) into v_affected_shows
  from setlist_entries where song_id = p_song_id;

  -- Delete setlist entries
  delete from setlist_entries where song_id = p_song_id;

  -- Renumber positions in affected shows
  if v_affected_shows is not null then
    for i in 1..array_length(v_affected_shows, 1) loop
      with numbered as (
        select id, row_number() over (order by position) as new_pos
        from setlist_entries where show_id = v_affected_shows[i]
      )
      update setlist_entries set position = numbered.new_pos
      from numbered where setlist_entries.id = numbered.id;
    end loop;
  end if;

  -- Collect storage paths before deleting chart rows
  select array_agg(storage_path) into v_storage_paths
  from chart_library where owner_id = p_owner_id and song_key = v_song_key;

  -- Delete chart_library entries
  delete from chart_library where owner_id = p_owner_id and song_key = v_song_key;

  -- Delete the song
  delete from songs where id = p_song_id;

  return jsonb_build_object(
    'affected_shows', to_jsonb(coalesce(v_affected_shows, '{}'::uuid[])),
    'storage_paths', to_jsonb(coalesce(v_storage_paths, '{}'::text[]))
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function rpc_delete_song from public, anon, authenticated;
grant execute on function rpc_delete_song to service_role;

-- ── RPC: rpc_create_show_with_setlist ────────────────────────────────────────

create or replace function rpc_create_show_with_setlist(
  p_owner_id uuid,
  p_name text,
  p_slug text,
  p_venue text,
  p_show_date text,
  p_config jsonb,
  p_setlist_songs jsonb
) returns jsonb as $$
declare
  v_show_id uuid;
  v_song record;
  v_song_id uuid;
  v_song_key text;
  v_position integer := 0;
  v_inline_setlist jsonb := '[]'::jsonb;
begin
  -- Create the show
  insert into shows (owner_id, name, slug, venue, show_date, config, setlist_migrated)
  values (p_owner_id, p_name, p_slug, nullif(p_venue, ''), nullif(p_show_date, ''), p_config, true)
  returning id into v_show_id;

  -- Resolve or create each song, then insert setlist entry
  for v_song in select * from jsonb_array_elements(coalesce(p_setlist_songs, '[]'::jsonb))
  loop
    v_position := v_position + 1;

    -- Use pre-computed song_key from API route
    v_song_key := v_song.value->>'song_key';

    if v_song_key is null or v_song_key = '' then
      raise exception 'Empty song_key at position %', v_position;
    end if;

    -- Upsert: insert if new, get id if existing
    insert into songs (owner_id, song_key, title, key, lead, notes)
    values (
      p_owner_id,
      v_song_key,
      v_song.value->>'title',
      nullif(v_song.value->>'key', ''),
      coalesce(v_song.value->>'lead', ''),
      coalesce(v_song.value->>'notes', '')
    )
    on conflict (owner_id, song_key) do nothing;

    select id into v_song_id from songs
    where owner_id = p_owner_id and song_key = v_song_key;

    -- Compute overrides: three-state semantics
    insert into setlist_entries (
      show_id, song_id, position,
      key_override, lead_override, notes_override, scene_note
    )
    select
      v_show_id, v_song_id, v_position,
      case
        when v_song.value->>'key' is null then
          case when s.key is not null then '' else null end
        when v_song.value->>'key' = coalesce(s.key, '') then null
        else v_song.value->>'key'
      end,
      case
        when coalesce(v_song.value->>'lead', '') = s.lead then null
        else coalesce(v_song.value->>'lead', '')
      end,
      case
        when coalesce(v_song.value->>'notes', '') = s.notes then null
        else coalesce(v_song.value->>'notes', '')
      end,
      nullif(v_song.value->>'scene_note', '')
    from songs s where s.id = v_song_id;
  end loop;

  -- Dual-write: build inline setlist for config.setlist
  select jsonb_agg(jsonb_build_object(
    'title', s.title,
    'key', case when se.key_override = '' then null
                else coalesce(se.key_override, s.key) end,
    'lead', coalesce(se.lead_override, s.lead),
    'notes', coalesce(se.notes_override, s.notes),
    'sceneNote', se.scene_note,
    'position', se.position
  ) order by se.position)
  into v_inline_setlist
  from setlist_entries se
  join songs s on s.id = se.song_id
  where se.show_id = v_show_id;

  -- Update config with inline setlist
  update shows set config = jsonb_set(config, '{setlist}', coalesce(v_inline_setlist, '[]'::jsonb))
  where id = v_show_id;

  return jsonb_build_object(
    'show_id', v_show_id,
    'slug', (select slug from shows where id = v_show_id)
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function rpc_create_show_with_setlist from public, anon, authenticated;
grant execute on function rpc_create_show_with_setlist to service_role;
