-- Migration 007: Fix show_date text->date cast in RPCs
-- shows.show_date is type `date`. The RPCs took p_show_date as text and assigned it
-- directly, which Postgres rejects ("column show_date is of type date but expression is
-- of type text"). The legacy save path worked only because PostgREST coerced the value.
-- Fix: cast nullif(p_show_date, '') to ::date in both RPCs. Re-applies the full function
-- bodies via CREATE OR REPLACE (only the show_date line changed).

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
  select owner_id into v_owner_id from shows where id = p_show_id;
  if not found then
    raise exception 'Show not found';
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

  select jsonb_build_object(
    'updated_at', (select updated_at from shows where id = p_show_id),
    'slug', (select slug from shows where id = p_show_id)
  ) into v_result;

  return v_result;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function rpc_save_show from public, anon, authenticated;
grant execute on function rpc_save_show to service_role;

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
  insert into shows (owner_id, name, slug, venue, show_date, config, setlist_migrated)
  values (p_owner_id, p_name, p_slug, nullif(p_venue, ''), nullif(p_show_date, '')::date, p_config, true)
  returning id into v_show_id;

  for v_song in select * from jsonb_array_elements(coalesce(p_setlist_songs, '[]'::jsonb))
  loop
    v_position := v_position + 1;

    v_song_key := v_song.value->>'song_key';

    if v_song_key is null or v_song_key = '' then
      raise exception 'Empty song_key at position %', v_position;
    end if;

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
