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
$$ language plpgsql security definer;

-- `create or replace` on a SECURITY DEFINER function resets EXECUTE to PUBLIC.
-- Re-revoking is mandatory on every redefinition, not just first creation.
revoke execute on function peek_tryit(text, integer) from public, anon, authenticated;
