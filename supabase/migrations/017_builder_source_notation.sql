-- Migration 017: persist the builder chart's baked notation (Numbers ⇄ Letters)
--
-- Design: docs/design-roadmap-notation-toggle.md.
-- The builder's Numbers⇄Letters toggle now bakes into the ONE stored PDF: save
-- renders the selected notation and the show renders that PDF as-is. The toggle
-- defaults to 'numbers', so a chart saved in Letters that is re-opened and saved
-- again WITHOUT re-toggling would silently re-bake to numbers. Persist the notation
-- so the read door can seed the toggle on re-open — the silent-flip guard.
--
-- Metadata only: it does NOT enter source_spec (the spec is always canonical
-- degrees). It DOES determine the rendered bytes, but it is not itself rendered or
-- hashed — the bytes are, and their hash keys calibration exactly as before.
--
-- Additive + nullable: every existing row gets source_notation = null, which the
-- builder and the show badge treat as 'numbers' (today's reality). No backfill.
-- A CHECK pins the domain so a bad client/RPC value can't land a third state.
--
-- The argument list of save_builder_chart changes (16 → 17 args), so drop the
-- current 16-arg signature (from migration 016) first, exactly as 016 did to 011.
--
-- SECURITY BOUNDARY unchanged: execute is granted to service_role ONLY.

alter table chart_library
  add column source_notation text
  check (source_notation is null or source_notation in ('numbers', 'letters'));

drop function if exists save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz, text
);

create function save_builder_chart(
  p_owner uuid,
  p_song_key text,
  p_song_title text,
  p_role text,
  p_file_name text,
  p_storage_path text,
  p_mime_type text,
  p_file_size integer,
  p_source_spec jsonb,
  p_source_hash text,
  p_schema_version integer,
  p_status text,
  p_calibration jsonb,
  p_expected_chart_id uuid default null,
  p_expected_updated_at timestamptz default null,
  p_source_prompt text default null,
  p_source_notation text default null
) returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_chart_id uuid;
  v_old_path text;
  v_existing_id uuid;
  v_existing_updated_at timestamptz;
begin
  if p_owner is null then
    raise exception 'p_owner is required' using errcode = '22004';
  end if;

  -- No auth.uid() check here: this runs as service_role (granted below), called
  -- only by the server route, which has already authenticated the user and sets
  -- p_owner = that user's id. The service_role-only grant is the ownership guard.

  -- Lock the live slot row (if any) for the rest of this transaction and capture
  -- its identity + version + storage path. FOR UPDATE serializes a concurrent
  -- edit/replace on the SAME (owner, song_key, role) behind us.
  select id, storage_path, updated_at
    into v_existing_id, v_old_path, v_existing_updated_at
    from chart_library
    where owner_id = p_owner and song_key = p_song_key and role = p_role
    for update;

  -- EDIT-path optimistic-concurrency precondition (unchanged from 011). Enforced
  -- ONLY when the caller supplied the expected slot identity.
  if p_expected_chart_id is not null then
    if v_existing_id is null then
      raise exception 'stale edit: chart no longer exists for this slot'
        using errcode = 'PT409';
    elsif v_existing_id <> p_expected_chart_id
       or v_existing_updated_at is distinct from p_expected_updated_at then
      raise exception 'stale edit: chart changed since it was opened'
        using errcode = 'PT409';
    end if;
  end if;

  insert into chart_library (
    owner_id, song_key, song_title, role, file_name,
    storage_path, mime_type, file_size, source_spec, source_prompt, source_notation
  ) values (
    p_owner, p_song_key, p_song_title, p_role, p_file_name,
    p_storage_path, p_mime_type, p_file_size, p_source_spec, p_source_prompt, p_source_notation
  )
  on conflict (owner_id, song_key, role) do update set
    song_title = excluded.song_title,
    file_name = excluded.file_name,
    storage_path = excluded.storage_path,
    mime_type = excluded.mime_type,
    file_size = excluded.file_size,
    source_spec = excluded.source_spec,
    source_prompt = excluded.source_prompt,
    source_notation = excluded.source_notation,
    updated_at = now()
  returning id into v_chart_id;

  insert into chart_calibration (
    chart_id, source_hash, schema_version, status, graph
  ) values (
    v_chart_id, p_source_hash, p_schema_version, p_status, p_calibration
  )
  on conflict (chart_id, source_hash) do update set
    schema_version = excluded.schema_version,
    status = excluded.status,
    graph = excluded.graph,
    updated_at = now();

  return jsonb_build_object('chart_id', v_chart_id, 'old_storage_path', v_old_path);
end;
$$;

revoke all on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz, text, text
) from public;

revoke all on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz, text, text
) from authenticated, anon;

grant execute on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz, text, text
) to service_role;
