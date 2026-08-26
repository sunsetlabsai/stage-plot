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

  -- ── Serialize every mutation of ONE user's secret ────────────────────────
  -- Transaction-scoped, so it releases on commit or rollback with no unlock
  -- path to forget. Keyed on the user, so two different users never contend.
  --
  -- Without it, read-then-branch below is a check-then-act across two
  -- concurrent PUTs. The precise damage is NOT what it first looks like:
  -- `vault.secrets` has a UNIQUE index on `name` (measured:
  -- `secrets_name_idx UNIQUE (name) WHERE name IS NOT NULL`) and every secret
  -- here is named `byoa-<user_id>`, so two concurrent FIRST-TIME creates for
  -- the same user cannot both succeed — the second blocks and then fails,
  -- turning a legitimate save into a 500 rather than orphaning anything.
  --
  -- The path that DOES orphan is Replace racing Remove: the delete fires the
  -- AFTER DELETE trigger and removes vault row A, while the replace has
  -- already read A and passed its `exists` check, and then writes a pointer to
  -- a secret that is gone. This lock closes both.
  --
  -- ⚠ Advisory locks require the DIRECT connection or the SESSION-mode pooler.
  -- They are silently useless on the transaction pooler (port 6543), which is
  -- the standing reason this project never uses it.
  perform pg_advisory_xact_lock(hashtextextended('user_secrets:' || p_user_id::text, 0));

  v_hint := left(p_key, 7) || '…' || right(p_key, 4);

  -- ── FOR UPDATE is about lock ORDER, not about this read ─────────────────
  -- The advisory lock above serializes the two RPC paths against each other,
  -- but it cannot help against a path that never takes it — and the
  -- `auth.users` CASCADE is exactly that. It arrives as plain SQL and locks
  -- the user_secrets row directly, then its AFTER DELETE trigger goes for the
  -- vault row.
  --
  -- So without this, the two paths grab the same two objects in OPPOSITE
  -- order: this function would hold the vault row (from update_secret) and
  -- want the user_secrets row, while the cascade holds the user_secrets row
  -- and wants the vault row. That is a cycle, and Postgres resolves cycles by
  -- killing one side — a deadlock error on a user saving their key.
  --
  -- Taking the user_secrets row FIRST makes both paths agree on the order
  -- (user_secrets, then vault), so the cycle cannot form. On a first-time
  -- save there is no row and this locks nothing, which is correct: there is
  -- also nothing for a cascade to be deleting.
  --
  -- ⚠ Deliberately NOT a BEFORE DELETE trigger taking the advisory lock, which
  -- is the obvious-looking fix. A BEFORE DELETE *row* trigger fires after the
  -- row is already locked, making that path `row -> advisory` while this one
  -- is `advisory -> row`. That REINTRODUCES the deadlock it was meant to cure.
  select vault_secret_id into v_existing
    from user_secrets where user_id = p_user_id
    for update;

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
  -- SAME lock, SAME order as set_user_secret: advisory first, then the row.
  -- Without this, Remove and Replace were not serialized against each other at
  -- all — the advisory lock in set_user_secret only excluded other setters,
  -- which is half a mutual exclusion and therefore none.
  --
  -- Taken BEFORE the delete statement, not in a trigger, precisely so the
  -- order stays `advisory -> row`. See the note in set_user_secret for why a
  -- BEFORE DELETE trigger would invert that and deadlock.
  perform pg_advisory_xact_lock(hashtextextended('user_secrets:' || p_user_id::text, 0));

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

-- Defense in depth, deliberately NOT redundant with the advisory lock above.
-- The lock stops the pointer being REPLACED concurrently; this catches a
-- pointer being replaced AT ALL, by any future code path that swaps
-- vault_secret_id without deleting the old secret first. `set_user_secret`
-- reuses the same vault row today, so this fires on no current path — that is
-- the point. It is the net under the invariant "a vault secret is unreachable
-- the moment nothing points at it", not under one function's current shape.
create or replace function delete_replaced_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old.vault_secret_id is not null
     and old.vault_secret_id is distinct from new.vault_secret_id then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return new;
end $fn$;

drop trigger if exists user_secrets_cleanup_replaced_vault on user_secrets;
create trigger user_secrets_cleanup_replaced_vault
  after update of vault_secret_id on user_secrets
  for each row execute function delete_replaced_vault_secret();

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
revoke execute on function delete_replaced_vault_secret() from public, anon, authenticated;

grant execute on function set_user_secret(uuid, text) to service_role;
grant execute on function get_user_secret(uuid)       to service_role;
grant execute on function delete_user_secret(uuid)    to service_role;
