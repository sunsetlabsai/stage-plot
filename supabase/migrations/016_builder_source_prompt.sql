-- Migration 016: persist the builder's last-used prompt (PR B)
--
-- Design: docs/design-roadmap-prompt-persistence.md (promotes edit-loop §7).
-- We persist the *spec*, not the natural-language *prompt* that produced it, so a
-- re-opened builder chart's refine box was empty and Regenerate was dead. Store the
-- prompt as a nullable sibling column so a re-opened chart pre-fills the refine box.
--
-- The prompt is a re-prompt SEED, not a mirror of the spec (full-replace refine,
-- Graham 2026-08-29). It is metadata only: never rendered, hashed, or part of the
-- validated RoadmapSpec — so it does not belong inside source_spec jsonb, and it
-- cannot affect any chart's rendered bytes or calibration.
--
-- Additive + nullable: every existing row gets source_prompt = null, which the
-- builder treats exactly like today's empty box (no backfill).
--
-- The argument list of save_builder_chart changes (15 → 16 args), so CREATE OR
-- REPLACE would create a second overload rather than replace; drop the current
-- 15-arg signature (from migration 011) first, exactly as 011 did to 009's 13-arg.
--
-- SECURITY BOUNDARY unchanged: execute is granted to service_role ONLY; the server
-- route is the ownership boundary and calls it via the admin client.

alter table chart_library add column source_prompt text;

drop function if exists save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz
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
  p_source_prompt text default null
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
    storage_path, mime_type, file_size, source_spec, source_prompt
  ) values (
    p_owner, p_song_key, p_song_title, p_role, p_file_name,
    p_storage_path, p_mime_type, p_file_size, p_source_spec, p_source_prompt
  )
  on conflict (owner_id, song_key, role) do update set
    song_title = excluded.song_title,
    file_name = excluded.file_name,
    storage_path = excluded.storage_path,
    mime_type = excluded.mime_type,
    file_size = excluded.file_size,
    source_spec = excluded.source_spec,
    source_prompt = excluded.source_prompt,
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
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz, text
) from public;

revoke all on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz, text
) from authenticated, anon;

grant execute on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb, uuid, timestamptz, text
) to service_role;
