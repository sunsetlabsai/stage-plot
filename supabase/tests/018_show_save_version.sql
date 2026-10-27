-- Scratch-DB proof for migration 018 (docs/design-version-checked-save.md §8 "SQL").
-- Run against a THROWAWAY database with 001..018 applied (see PR for the harness);
-- each statement is its own transaction (psql autocommit), so now() moves between
-- them. Every check raises on failure; a clean run ends with "ALL PASSED".
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users(id) values ('00000000-0000-0000-0000-0000000000a1');
insert into profiles(id, owner_slug) values ('00000000-0000-0000-0000-0000000000a1', 'tester') on conflict (id) do update set owner_slug = 'tester';
insert into songs(id, owner_id, song_key, title, key, lead, notes) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', 'song a', 'Song A', 'G', '', ''),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a1', 'song b', 'Song B', 'C', '', ''),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a1', 'song c', 'Song C', 'D', '', '');
insert into shows(id, owner_id, slug, name, config, setlist_migrated) values
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-0000000000a1', 'one', 'One', '{}', true),
  ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-0000000000a1', 'two', 'Two', '{}', true),
  ('00000000-0000-0000-0000-000000000053', '00000000-0000-0000-0000-0000000000a1', 'three', 'Three', '{}', true);
insert into setlist_entries(show_id, song_id, position) values
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-00000000005a', 1),
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-00000000005b', 2),
  ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-00000000005a', 1);

create table t_prev as select id, updated_at from shows;
create function t_snap() returns void language sql as $$ truncate t_prev; insert into t_prev select id, updated_at from shows $$;
create function t_moved(p uuid) returns boolean language sql as $$
  select s.updated_at <> t.updated_at from shows s join t_prev t using (id) where s.id = p $$;
create function t_cur(p uuid) returns timestamptz language sql as $$ select updated_at from shows where id = p $$;

-- 1. the old 7-arg signature is gone; exactly one rpc_save_show remains
do $$ begin
  assert (select count(*) from pg_proc where proname = 'rpc_save_show') = 1, 'exactly one rpc_save_show';
  assert to_regprocedure('rpc_save_show(uuid,jsonb,text,text,text,jsonb,jsonb)') is null, 'old 7-arg signature still exists';
  assert (select proconfig from pg_proc where proname = 'rpc_save_show') = '{search_path=public}', 'search_path pinned';
end $$;

-- 2. grants: service_role only; trigger functions not callable by clients
do $$ declare f text; begin
  foreach f in array array['rpc_save_show(uuid,jsonb,text,text,text,jsonb,jsonb,timestamptz)', 'rpc_delete_song(uuid,uuid)'] loop
    assert not has_function_privilege('anon', f, 'execute'), f || ' anon';
    assert not has_function_privilege('authenticated', f, 'execute'), f || ' authenticated';
    assert has_function_privilege('service_role', f, 'execute'), f || ' service_role';
  end loop;
  foreach f in array array['bump_shows_from_entries()', 'bump_shows_from_song()'] loop
    assert not has_function_privilege('anon', f, 'execute'), f || ' anon';
    assert not has_function_privilege('authenticated', f, 'execute'), f || ' authenticated';
  end loop;
end $$;

-- 3. matching base saves; the returned updated_at is the row's FINAL value
select t_snap();
do $$ declare r jsonb; begin
  r := rpc_save_show('00000000-0000-0000-0000-000000000051', '{"a":1}', 'One', '', '', '[{"song_id":"00000000-0000-0000-0000-00000000005a","position":1}]', null,
                     t_cur('00000000-0000-0000-0000-000000000051'));
  assert (r->>'updated_at')::timestamptz = t_cur('00000000-0000-0000-0000-000000000051'), 'returned updated_at <> row final value';
end $$;
do $$ begin assert t_moved('00000000-0000-0000-0000-000000000051'), 'save did not move the version'; end $$;

-- 4. a stale base raises PT409 and writes nothing
do $$ declare stale timestamptz := (select updated_at from t_prev where id = '00000000-0000-0000-0000-000000000051'); cfg jsonb; begin
  begin
    perform rpc_save_show('00000000-0000-0000-0000-000000000051', '{"a":2}', 'One', '', '', '[]', null, stale);
    raise exception 'stale base was accepted';
  exception when sqlstate 'PT409' then null;
  end;
  select config into cfg from shows where id = '00000000-0000-0000-0000-000000000051';
  assert cfg = '{"a":1}', 'stale save wrote';
end $$;

-- 5. a base one microsecond off is stale (exact comparison)
do $$ begin
  begin
    perform rpc_save_show('00000000-0000-0000-0000-000000000051', '{"a":3}', 'One', '', '', '[]', null,
                          t_cur('00000000-0000-0000-0000-000000000051') + interval '1 microsecond');
    raise exception 'off-by-1us base was accepted';
  exception when sqlstate 'PT409' then null;
  end;
end $$;

-- 6. entries writes bump their show (insert, update, delete), and only their show
select t_snap();
insert into setlist_entries(show_id, song_id, position) values ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-00000000005b', 2);
do $$ begin
  assert t_moved('00000000-0000-0000-0000-000000000052'), 'entry insert did not bump';
  assert not t_moved('00000000-0000-0000-0000-000000000051'), 'entry insert bumped another show';
end $$;
select t_snap();
update setlist_entries set scene_note = 'x' where show_id = '00000000-0000-0000-0000-000000000052' and position = 2;
do $$ begin assert t_moved('00000000-0000-0000-0000-000000000052'), 'entry update did not bump'; end $$;
select t_snap();
delete from setlist_entries where show_id = '00000000-0000-0000-0000-000000000052' and position = 2;
do $$ begin assert t_moved('00000000-0000-0000-0000-000000000052'), 'entry delete did not bump'; end $$;

-- 7. song title/key/lead/notes bump every show using it; bpm/artist bump none
select t_snap();
update songs set key = 'A' where id = '00000000-0000-0000-0000-00000000005a';
do $$ begin
  assert t_moved('00000000-0000-0000-0000-000000000051') and t_moved('00000000-0000-0000-0000-000000000052'), 'song key change did not bump its shows';
  assert not t_moved('00000000-0000-0000-0000-000000000053'), 'song key change bumped an unrelated show';
end $$;
select t_snap();
update songs set bpm = 120 where id = '00000000-0000-0000-0000-00000000005a';
update songs set artist = 'Someone' where id = '00000000-0000-0000-0000-00000000005a';
update songs set key = 'A' where id = '00000000-0000-0000-0000-00000000005a';  -- unchanged value
do $$ begin
  assert not t_moved('00000000-0000-0000-0000-000000000051'), 'bpm/artist/no-op change bumped a show';
end $$;
select t_snap();
-- (show 1's entries were replaced in step 3: it now uses only Song A)
update songs set notes = 'n' where id = '00000000-0000-0000-0000-00000000005a';
do $$ begin assert t_moved('00000000-0000-0000-0000-000000000051'), 'notes change did not bump'; end $$;
select t_snap();
update songs set notes = 'n2' where id = '00000000-0000-0000-0000-00000000005b';
do $$ begin assert not t_moved('00000000-0000-0000-0000-000000000051'), 'unused song bumped a show'; end $$;

-- 8. rpc_delete_song bumps the shows that used the song
insert into setlist_entries(show_id, song_id, position) values ('00000000-0000-0000-0000-000000000053', '00000000-0000-0000-0000-00000000005c', 1);
select t_snap();
select rpc_delete_song('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a1');
do $$ begin assert t_moved('00000000-0000-0000-0000-000000000053'), 'delete_song did not bump'; end $$;

-- 9. create with setlist stores scene_note and rebuilds config.setlist with sceneNote
do $$ declare r jsonb; sid uuid; begin
  r := rpc_create_show_with_setlist('00000000-0000-0000-0000-0000000000a1', 'Four', 'four', '', '', '{"setlist":[]}',
        '[{"title":"Song B","song_key":"song b","key":"C","lead":"","notes":"","scene_note":"lights down"}]');
  sid := (r->>'show_id')::uuid;
  assert (select scene_note from setlist_entries where show_id = sid) = 'lights down', 'scene_note not stored';
  assert (select config->'setlist'->0->>'sceneNote' from shows where id = sid) = 'lights down', 'sceneNote not in rebuilt config';
end $$;

-- 10. deleting a show (entries cascade → entries trigger) still works
delete from shows where id = '00000000-0000-0000-0000-000000000053';
do $$ begin assert not exists (select 1 from shows where id = '00000000-0000-0000-0000-000000000053'), 'show delete failed'; end $$;

\echo ALL PASSED
