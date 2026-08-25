-- Try-it quota: non-consuming read.
--
-- `increment_tryit` (001_initial_schema.sql) is the only quota RPC, and it always
-- writes. `resolveKeyMode` needs `consume: false` for the capability probe: a
-- tab-open must not cost a free message (design-ai-key-availability §4). Under
-- Redis that was a plain GET; this is its replacement.
--
-- Window semantics are copied from `increment_tryit`, not reinvented: a row whose
-- window_start has aged past p_window_days reads as 0, exactly as the increment
-- path would reset it to 1. A peek that ignored the window would report an IP as
-- exhausted right up until its next send silently reset it.
--
-- Reads only. No insert, no update — probing an unseen IP must not seed a row.
create or replace function peek_tryit(p_ip_hash text, p_window_days integer)
returns integer as $$
declare
  current_count integer;
begin
  select case
    when window_start < now() - (p_window_days || ' days')::interval then 0
    else message_count
  end
  into current_count
  from tryit_quota
  where ip_hash = p_ip_hash;

  -- No row = never seen = no usage.
  return coalesce(current_count, 0);
end;
-- search_path is pinned, matching every other definer in this repo (006, 007,
-- 009, 011). An unqualified `tryit_quota` inside a SECURITY DEFINER function is
-- resolved against the caller's search_path otherwise.
$$ language plpgsql security definer set search_path = public;

-- `create or replace` on a SECURITY DEFINER function resets EXECUTE to PUBLIC.
-- Re-revoking is mandatory on every redefinition, not just first creation.
revoke execute on function peek_tryit(text, integer) from public, anon, authenticated;

-- REVOKE alone is not enough. SECURITY DEFINER governs privileges INSIDE the
-- function; it does not authorise a caller to invoke it. Every other
-- service-role RPC here pairs revoke with an explicit grant — 006:142, 006:198,
-- 006:303, 007:76, 009:105, 011:131 — and omitting it is not a style slip: an
-- RPC the service role cannot execute returns an error, `quota()` treats an
-- error as an unreachable backend, and the try-it quota falls back OPEN. Not a
-- visible failure — a permanent silent bypass.
grant execute on function peek_tryit(text, integer) to service_role;

-- Same gap, pre-existing, in 001_initial_schema.sql:259: increment_tryit is
-- revoked and never granted. It is fixed here rather than left alone because
-- chunk 2 wires BOTH quota calls through the service role, so shipping this
-- migration without it would leave the consume path bypassable in exactly the
-- way described above. Idempotent — safe if a later grant already exists.
grant execute on function increment_tryit(text, integer, integer) to service_role;
