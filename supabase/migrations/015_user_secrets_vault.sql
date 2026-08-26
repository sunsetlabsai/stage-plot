-- 015_user_secrets_vault.sql
-- Chunk 3: BYOA keys move from a plaintext column to Supabase Vault, and all
-- writes move server-side. Design: docs/design-single-backend.md §4, §8.1.
--
-- Applied to prod BEFORE the code merges. That ordering is safe here and it is
-- measured, not assumed: `grep -rn user_secrets app/ lib/ components/ tests/`
-- returns NOTHING on main, so no running code reads the column being dropped.
-- (Contrast 013, where the merge->migration window forced the 42501
-- fail-closed branch in quota(). There is no such window this time.)

-- ---------------------------------------------------------------------------
-- 1. Drop both write policies (§4.2)
-- ---------------------------------------------------------------------------
-- NOT for the reason v1 of the design gave. The real reasons are forced:
--   (a) an authenticated browser client cannot create a Vault secret, so a
--       client-side insert cannot produce the representation this design needs;
--   (b) there is no DELETE policy, so §4.6's mandatory Remove action could
--       never have worked client-side either.
-- Leaving them would preserve a second, unused write path capable of storing a
-- PLAINTEXT key into a column the rest of the design assumes holds a uuid.
-- That is a live foot-gun, not harmless dead weight.
drop policy if exists "User write own secrets"  on user_secrets;
drop policy if exists "User update own secrets" on user_secrets;

-- NO select policy and NO delete policy are added here. Their ABSENCE is what
-- enforces write-only (§4.6.1) — a browser client holding a valid session still
-- cannot read its own key back. service_role bypasses RLS for the server read.

-- ---------------------------------------------------------------------------
-- 2. Reshape the table (§8.1)
-- ---------------------------------------------------------------------------
-- A drop rather than a rename+backfill: measured 0 rows in prod 2026-08-26,
-- so there is nothing to migrate and no plaintext to shred.
alter table user_secrets drop column claude_api_key;
alter table user_secrets add  column vault_secret_id uuid;
alter table user_secrets add  column key_hint        text;

-- One user's pointer cannot alias another's secret.
alter table user_secrets
  add constraint user_secrets_vault_secret_id_key unique (vault_secret_id);

-- Structural, not advisory: an Anthropic key is ~100 chars, so writing a whole
-- key into the hint column is a database error rather than a silent leak.
alter table user_secrets
  add constraint user_secrets_key_hint_is_a_hint
  check (key_hint is null or length(key_hint) <= 20);

-- ---------------------------------------------------------------------------
-- 3. Vault access lives behind SECURITY DEFINER wrappers in `public`
-- ---------------------------------------------------------------------------
-- PostgREST only exposes `public`, so supabase-js cannot reach vault.* at all.
-- These wrappers are the entire Vault surface. They are SECURITY DEFINER and
-- owned by postgres, so they can touch vault regardless of the caller's own
-- vault privileges.
--
-- Every function below pins search_path. `activate_invites` (001:262) and
-- `increment_tryit` (001:234) both lack this; new code does not join that list.

-- Create or replace the caller's stored key. Returns the masked hint.
-- The hint is computed HERE, not passed in, so it can never disagree with the
-- key or be spoofed by a caller.
create or replace function set_user_secret(p_user_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_existing uuid;
  v_hint     text;
  v_name     text := 'byoa-' || p_user_id::text;
begin
  if p_key is null or length(p_key) < 20 then
    -- Below this length the hint would reveal most of the key, and no real
    -- Anthropic key is this short.
    raise exception 'key is too short to store safely';
  end if;

  v_hint := left(p_key, 7) || '…' || right(p_key, 4);

  select vault_secret_id into v_existing
    from user_secrets where user_id = p_user_id;

  -- Reuse the existing vault row on Replace so no orphan is created.
  if v_existing is not null
     and exists (select 1 from vault.secrets where id = v_existing) then
    perform vault.update_secret(v_existing, p_key);
  else
    v_existing := vault.create_secret(p_key, v_name, 'ShowRunr BYOA key');
  end if;

  insert into user_secrets (user_id, vault_secret_id, key_hint, updated_at)
  values (p_user_id, v_existing, v_hint, now())
  on conflict (user_id) do update
    set vault_secret_id = excluded.vault_secret_id,
        key_hint        = excluded.key_hint,
        updated_at      = now();

  return v_hint;
end $fn$;

-- The ONLY path that returns plaintext. Not reachable by any route: it exists
-- so the server can call Anthropic. §8.1 states the honest limit plainly —
-- Vault does not protect against a compromised service_role key, because the
-- server must decrypt in order to use the key at all.
create or replace function get_user_secret(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id  uuid;
  v_key text;
begin
  select vault_secret_id into v_id
    from user_secrets where user_id = p_user_id;

  if v_id is null then
    return null;
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets where id = v_id;

  return v_key;
end $fn$;

-- Remove. Deletes the pointer; the trigger below removes the secret itself.
create or replace function delete_user_secret(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count int;
begin
  delete from user_secrets where user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $fn$;

-- ---------------------------------------------------------------------------
-- 4. The orphan trigger — §4.6.4's cascade claim is otherwise FALSE
-- ---------------------------------------------------------------------------
-- §4.6.4 says account deletion is already handled by
-- `references auth.users(id) on delete cascade`. That was true when the key
-- lived in this table. It is NOT true once the key lives in Vault: deleting an
-- account cascades the POINTER away and orphans the SECRET, leaving a third
-- party's encrypted credential in vault.secrets forever, with `user_secrets`
-- looking perfectly clean and nothing anywhere able to detect it.
--
-- On the trigger rather than in delete_user_secret() so it holds for EVERY
-- delete path: the Remove button, the auth.users cascade, and hand-written SQL.
create or replace function delete_orphaned_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end $fn$;

drop trigger if exists user_secrets_cleanup_vault on user_secrets;
create trigger user_secrets_cleanup_vault
  after delete on user_secrets
  for each row execute function delete_orphaned_vault_secret();

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
-- ⚠ MEASURED 2026-08-26, and it corrects this repo's standing assumption:
-- Supabase's default privileges on schema `public` already grant EXECUTE to
-- anon, authenticated AND service_role on every newly created function, and no
-- revoke in this repo has ever named service_role. So the revokes below are
-- what actually does the work; the grants are belt-and-braces that make the
-- privilege explicit and independent of a platform default that could change.
-- Do NOT repeat 013's claim that a missing grant causes a silent bypass — that
-- was refuted by querying prod.
revoke execute on function set_user_secret(uuid, text)    from public, anon, authenticated;
revoke execute on function get_user_secret(uuid)          from public, anon, authenticated;
revoke execute on function delete_user_secret(uuid)       from public, anon, authenticated;
revoke execute on function delete_orphaned_vault_secret() from public, anon, authenticated;

grant execute on function set_user_secret(uuid, text) to service_role;
grant execute on function get_user_secret(uuid)       to service_role;
grant execute on function delete_user_secret(uuid)    to service_role;
