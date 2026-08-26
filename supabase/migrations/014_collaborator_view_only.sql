-- Migration 014: collaborators are VIEW ONLY — the `editor` role is DELETED.
-- Spec: docs/design-single-backend.md §3.3c (chunk 6).
--
-- ⚠ THE APPLICATION CODE SHIPS FIRST. This migration runs only after the chunk-6
-- code is merged and deployed. The reverse order leaves live routes selecting a
-- column that no longer exists.
--
-- ⚠ THE STATEMENT ORDER BELOW IS NORMATIVE, not cosmetic:
--   * Postgres will not drop a function while a policy depends on it, so the
--     dependent policy comes down BEFORE the function.
--   * `is_show_collaborator` changes SIGNATURE (it loses `p_role`), so
--     `create or replace` is NOT enough — it would leave the 2-arg overload
--     standing, and that overload's body reads `role`, making the column
--     undroppable at step 6.
--
-- ⚠ Supabase's SQL editor splits on `;`, and the function body below contains
-- `;` inside `$$`. Run each numbered block as a SEPARATE paste.
--
-- Measured against prod immediately before writing this (2026-08-25):
--   select role, count(*) from show_collaborators group by role;  -- NO ROWS
--   pg_policies where qual like '%is_show_collaborator%';         -- exactly 2
--   pg_get_function_identity_arguments                            -- 'p_show_id uuid, p_role text'
--   information_schema.columns                                    -- role text, is_nullable = NO


-- ── 1 ────────────────────────────────────────────────────────────────────────
-- Convert any surviving editor rows to viewer.
--
-- Currently a no-op: the table measured EMPTY. The statement stays anyway
-- because `role` is `not null check (role in ('editor','viewer'))` (001:39), so
-- one stray 'editor' row inserted between the measurement and this run would
-- block step 6. A migration must not assume the count it measured.
update show_collaborators set role = 'viewer' where role = 'editor';


-- ── 2 ────────────────────────────────────────────────────────────────────────
-- Drop the editor write grant on `shows` (002:39).
--
-- This is the ONLY surviving 'editor' grant. 002's four chart policies died with
-- `drop table charts` (003:13) — dropping a table drops its policies — and the
-- replacement `chart_library` was created owner-only from the start (003:58-68).
-- There is nothing to recreate here.
drop policy if exists "Editor update" on shows;


-- ── 3 ────────────────────────────────────────────────────────────────────────
-- Drop the policy that DEPENDS on the helper, so the helper can be replaced.
-- Recreated at step 5 — steps 3-5 must land together or collaborators lose read.
drop policy if exists "Collaborator read" on shows;


-- ── 4 ────────────────────────────────────────────────────────────────────────
-- Drop the 2-arg helper. `p_role` is removed from the signature rather than left
-- as an ignored parameter — a parameter that silently does nothing is the next
-- reader's trap.
drop function if exists is_show_collaborator(uuid, text);


-- ── 5 ────────────────────────────────────────────────────────────────────────
-- Recreate as (uuid). Body no longer reads `role`, which is what frees step 6.
--
-- `set search_path = public` is NEW relative to 002. This is `security definer`;
-- an unpinned search_path on a definer function is a live hazard, and since the
-- function is being rewritten anyway the fix costs nothing here.
--
-- Deliberately NO revoke/grant pair: unlike the service-role RPCs in 006/013,
-- this function is called from RLS policies as the INVOKING user, so it needs
-- the default PUBLIC execute that `is_show_owner` (002:7) also relies on.
-- Revoking here would break every policy that calls it.
create function is_show_collaborator(p_show_id uuid)
returns boolean as $$
  select exists (
    select 1 from show_collaborators
    where show_id = p_show_id
      and user_id = auth.uid()
  );
$$ language sql security definer set search_path = public;


-- ── 6 ────────────────────────────────────────────────────────────────────────
-- Recreate the read policy against the new signature. Membership survives as
-- DISCOVERABILITY (§3.3c) — it is what places an invited show on the
-- collaborator's dashboard.
create policy "Collaborator read"
  on shows for select
  using (is_show_collaborator(id));


-- ── 7 ────────────────────────────────────────────────────────────────────────
-- Drop the column.
--
-- The alternative — narrowing the check to ('viewer') — is rejected: a NOT NULL
-- column with one legal value carries no information, and leaving it invites a
-- future 'editor' to be re-added by someone reading the constraint as a menu.
alter table show_collaborators drop column role;


-- ── VERIFY (read-only; run after) ────────────────────────────────────────────
-- Expect: one row, args = 'p_show_id uuid', proconfig = {search_path=public}
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'is_show_collaborator';
--
-- Expect: exactly one row — "Collaborator read" on shows. "Editor update" gone.
--   select tablename, policyname, cmd from pg_policies
--   where qual like '%is_show_collaborator%' or with_check like '%is_show_collaborator%';
--
-- Expect: NO row named 'role'
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'show_collaborators';
