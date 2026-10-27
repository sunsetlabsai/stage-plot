-- Migration 018: version-checked show save (docs/design-version-checked-save.md §3).
--
-- 1. rpc_save_show takes p_base_updated_at and refuses a save whose base is not the
--    show's current updated_at (PT409 → 409 at the route). The old 7-arg signature is
--    DROPPED, so nothing can call the unchecked version (§3.2).
-- 2. Anything a show save can echo back moves the show's version (§3.1, §3.5):
--    setlist_entries writes, and song title/key/lead/notes changes, bump
--    shows.updated_at for the shows they touch. bpm and artist do not: a show save
--    never writes them.
-- 3. rpc_delete_song locks the affected shows BEFORE deleting entries, so it takes
--    show → entries in the same order as rpc_save_show (no deadlock, §3.5).
--
-- Apply BEFORE the code deploy (Q4): between the two, old code calls the 7-arg
-- function, which no longer exists, and its saves fail loudly.

-- ── 1. rpc_save_show ─────────────────────────────────────────────────────────

drop function if exists rpc_save_show(uuid, jsonb, text, text, text, jsonb, jsonb);

create or replace function rpc_save_show(
  p_show_id uuid,
  p_config jsonb,
  p_name text,
  p_venue text,
  p_show_date text,
  p_entries jsonb,
  p_inline_setlist jsonb,
  p_base_updated_at timestamptz
) returns jsonb as $$
declare
  v_final_config jsonb;
  v_result jsonb;
  v_owner_id uuid;
  v_current timestamptz;
begin
  -- Lock the show first: serialises concurrent saves, and every writer that also
  -- touches entries takes show → entries in this order (rpc_delete_song below).
  select owner_id, updated_at into v_owner_id, v_current
    from shows where id = p_show_id
    for update;
  if not found then
    raise exception 'Show not found';
  end if;
  -- Exact comparison (microseconds): the client echoes the server's string verbatim.
  if v_current is distinct from p_base_updated_at then
    raise exception 'show changed since %', p_base_updated_at using errcode = 'PT409';
  end if;

  if p_entries is not null and jsonb_array_length(p_entries) > 0 then
    if exists (
      select 1 from jsonb_array_elements(p_entries) as e
      left join songs s on s.id = (e->>'song_id')::uuid and s.owner_id = v_owner_id
      where s.id is null
    ) then
      raise exception 'One or more songs not found or not owned by show owner';
    end if;
  end if;

  if p_inline_setlist is not null then
    v_final_config := jsonb_set(p_config, '{setlist}', p_inline_setlist);
  else
    v_final_config := p_config;
  end if;

  update shows set
    config = v_final_config,
    name = p_name,
    venue = nullif(p_venue, ''),
    show_date = nullif(p_show_date, '')::date,
    setlist_migrated = true
  where id = p_show_id;

  delete from setlist_entries where show_id = p_show_id;

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

  -- Read AFTER the entries writes: their trigger bumps this same row, in this
  -- transaction, to the same now(), so this is the row's final version.
  select jsonb_build_object('updated_at', updated_at, 'slug', slug)
    into v_result
    from shows where id = p_show_id;

  return v_result;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function rpc_save_show(uuid, jsonb, text, text, text, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function rpc_save_show(uuid, jsonb, text, text, text, jsonb, jsonb, timestamptz)
  to service_role;

-- ── 2a. setlist_entries writes bump their shows ──────────────────────────────
-- Statement-level with transition tables. Postgres allows a transition table only
-- on a single-event trigger, so one function serves three triggers.

create or replace function bump_shows_from_entries() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    update shows set updated_at = now()
      where id in (select distinct show_id from new_entries);
  elsif tg_op = 'UPDATE' then
    update shows set updated_at = now()
      where id in (select show_id from new_entries union select show_id from old_entries);
  else
    update shows set updated_at = now()
      where id in (select distinct show_id from old_entries);
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function bump_shows_from_entries() from public, anon, authenticated;

drop trigger if exists setlist_entries_bump_show_ins on setlist_entries;
create trigger setlist_entries_bump_show_ins
  after insert on setlist_entries
  referencing new table as new_entries
  for each statement execute function bump_shows_from_entries();

drop trigger if exists setlist_entries_bump_show_upd on setlist_entries;
create trigger setlist_entries_bump_show_upd
  after update on setlist_entries
  referencing old table as old_entries new table as new_entries
  for each statement execute function bump_shows_from_entries();

drop trigger if exists setlist_entries_bump_show_del on setlist_entries;
create trigger setlist_entries_bump_show_del
  after delete on setlist_entries
  referencing old table as old_entries
  for each statement execute function bump_shows_from_entries();

-- ── 2b. song changes a show save can echo back bump the shows using it ───────

create or replace function bump_shows_from_song() returns trigger as $$
begin
  update shows set updated_at = now()
    where id in (select show_id from setlist_entries where song_id = new.id);
  return null;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function bump_shows_from_song() from public, anon, authenticated;

drop trigger if exists songs_bump_shows on songs;
create trigger songs_bump_shows
  after update of title, key, lead, notes on songs
  for each row
  when (
    old.title is distinct from new.title
    or old.key is distinct from new.key
    or old.lead is distinct from new.lead
    or old.notes is distinct from new.notes
  )
  execute function bump_shows_from_song();

-- ── 3. rpc_delete_song: shows first, then entries ────────────────────────────
-- Body as 006 except the lock: the affected shows are locked FOR UPDATE, ordered
-- by id, BEFORE the entries delete (whose trigger then updates those same rows).

create or replace function rpc_delete_song(
  p_song_id uuid,
  p_owner_id uuid
) returns jsonb as $$
declare
  v_song_key text;
  v_affected_shows uuid[];
  v_storage_paths text[];
begin
  select song_key into v_song_key from songs where id = p_song_id and owner_id = p_owner_id;
  if not found then
    raise exception 'Song not found or not owned';
  end if;

  select array_agg(distinct show_id) into v_affected_shows
  from setlist_entries where song_id = p_song_id;

  -- Same order as rpc_save_show: show rows before their entries.
  perform 1 from shows
    where id = any(coalesce(v_affected_shows, '{}'::uuid[]))
    order by id
    for update;

  delete from setlist_entries where song_id = p_song_id;

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

  select array_agg(storage_path) into v_storage_paths
  from chart_library where owner_id = p_owner_id and song_key = v_song_key;

  delete from chart_library where owner_id = p_owner_id and song_key = v_song_key;

  delete from songs where id = p_song_id;

  return jsonb_build_object(
    'affected_shows', to_jsonb(coalesce(v_affected_shows, '{}'::uuid[])),
    'storage_paths', to_jsonb(coalesce(v_storage_paths, '{}'::text[]))
  );
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function rpc_delete_song(uuid, uuid) from public, anon, authenticated;
grant execute on function rpc_delete_song(uuid, uuid) to service_role;

-- Verify (run after applying):
--   select pg_get_function_identity_arguments(p.oid), p.proconfig
--     from pg_proc p where proname = 'rpc_save_show';
--   Expect ONE row ending in `p_base_updated_at timestamp with time zone`,
--   proconfig = {search_path=public}.
--   select has_function_privilege('authenticated',
--     'rpc_save_show(uuid,jsonb,text,text,text,jsonb,jsonb,timestamptz)', 'execute');  -- f
