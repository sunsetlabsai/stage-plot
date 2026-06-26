-- Migration 011: stale-edit optimistic-concurrency guard on save_builder_chart
--
-- The edit loop (chunk 5) re-opens a builder chart's source_spec, lets the owner
-- edit/regenerate it, and saves it back into the SAME (owner, song_key, role)
-- slot. The bare save has no idea the slot may have changed since it was loaded —
-- e.g. a concurrent "Replace with file" upserts that row IN PLACE (same id) and
-- nulls source_spec, de-buildering it. A stale edit save would then silently
-- re-upsert source_spec, RE-buildering a chart the owner just converted to a file.
--
-- Fix: two OPTIONAL params (p_expected_chart_id, p_expected_updated_at). The EDIT
-- path passes the values the GET read door returned; the CREATE path passes null
-- and behaviour is unchanged. RACE-FREE by construction (Codex R2/R3): the slot
-- row is locked FOR UPDATE before the precondition is checked, so a concurrent
-- Replace cannot land between the check and this save's upsert — it serializes
-- behind our lock. On a precondition mismatch we raise SQLSTATE 'PT409', which the
-- route maps to 409 Conflict ("this chart changed since you opened it — reload").
--
-- The argument list changes, so CREATE OR REPLACE would create a second overload
-- rather than replace; drop the old 13-arg signature first.
--
-- SECURITY BOUNDARY unchanged: execute is granted to service_role ONLY; the server
-- route is the ownership boundary and calls it via the admin client.

drop function if exists save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb
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
  p_expected_updated_at timestamptz default null
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
  -- edit/replace on the SAME (owner, song_key, role) behind us, so the
  -- precondition check below and the upsert that follows are atomic with respect
  -- to that row. (On the create path there is no row to lock; the upsert handles
  -- the insert. v_old_path is still captured so the route can reclaim the prior
  -- object after the commit lands.)
  select id, storage_path, updated_at
    into v_existing_id, v_old_path, v_existing_updated_at
    from chart_library
    where owner_id = p_owner and song_key = p_song_key and role = p_role
    for update;

  -- EDIT-path optimistic-concurrency precondition. Enforced ONLY when the caller
  -- supplied the expected slot identity (create path passes null → no precondition,
  -- behaviour unchanged). A mismatch means the slot changed since the editor loaded
  -- it (a Replace-with-file de-buildered it, or another edit landed) — refuse
  -- rather than clobber, raising PT409 → 409 Conflict at the route.
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
    storage_path, mime_type, file_size, source_spec
  ) values (
    p_owner, p_song_key, p_song_title, p_role, p_file_name,
    p_storage_path, p_mime_type, p_file_size, p_source_spec
  )
  on conflict (owner_id, song_key, role) do update set
    song_title = excluded.song_title,
    file_name = excluded.file_name,
    storage_path = excluded.storage_path,
    mime_type = excluded.mime_type,
    file_size = excluded.file_size,
    source_spec = excluded.source_spec,
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
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz
) from public;

revoke all on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz
) from authenticated, anon;

grant execute on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz
) to service_role;
