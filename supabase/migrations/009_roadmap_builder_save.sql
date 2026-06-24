-- Migration 009: Roadmap Builder save path (chunk 3)
-- Two parts:
--  1. chart_library gains source_spec jsonb — the AUTHORED RoadmapSpec that a
--     builder chart was rendered from (null for uploaded/converted charts). This
--     is the source of truth for re-key/edit (chunks 4-5); the PDF + calibration
--     are derived artifacts.
--  2. save_builder_chart RPC — commits a builder save ATOMICALLY across both
--     chart_library (upsert by owner/song/role) and chart_calibration (upsert by
--     chart_id/source_hash). The route stages the hash-addressed PDF object FIRST,
--     then calls this; an all-or-nothing DB commit means a torn write can never
--     leave a library row pointing at a calibration that isn't there (or vice
--     versa). Returns the prior storage_path so the route can best-effort delete
--     the now-orphaned object after a successful re-render.

alter table chart_library add column source_spec jsonb;

create or replace function save_builder_chart(
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
  p_calibration jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_chart_id uuid;
  v_old_path text;
begin
  -- Ownership guard: SECURITY DEFINER bypasses RLS, so the function itself must
  -- prove the caller owns the row it writes. auth.uid() reads the caller's JWT
  -- (the route invokes this with the user-scoped client, not the admin client).
  if p_owner is null or p_owner <> auth.uid() then
    raise exception 'not authorized to save for owner %', p_owner using errcode = '42501';
  end if;

  -- Capture the object the live row currently points at (if any) so the route can
  -- reclaim it once this commit lands and the new hash-addressed object is live.
  select storage_path into v_old_path
    from chart_library
    where owner_id = p_owner and song_key = p_song_key and role = p_role;

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
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb
) from public;

grant execute on function save_builder_chart(
  uuid, text, text, text, text, text, text, integer, jsonb, text, integer, text, jsonb
) to authenticated;
