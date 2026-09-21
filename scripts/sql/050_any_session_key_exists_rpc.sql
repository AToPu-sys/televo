-- The client-side fix for the reinit-from-zero effect (app/chat/[id].tsx)
-- needs to know "does ANY participant have a session-key row for this
-- conversation" — not just "does the CALLING user have one." A plain
-- `select count(*) from encrypted_session_keys where conversation_id = ...`
-- from the client can't answer that: the table's own SELECT policy
-- (004_e2e_encryption.sql) restricts every row to `recipient_id =
-- auth.uid()`, by design — a participant must never be able to read
-- another participant's wrapped copy of the key. That's exactly right for
-- reading the key itself, but it also hides the answer to "does a row
-- exist at all," which this function needs from the OTHER side of that same
-- wall: SECURITY DEFINER, so it can see every row, while still returning
-- only a boolean — never the wrapped key material itself — to the caller.
create or replace function public.any_session_key_exists(p_conversation_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.encrypted_session_keys
    where conversation_id = p_conversation_id
  );
$$;

revoke all on function public.any_session_key_exists(uuid) from public, anon;
grant execute on function public.any_session_key_exists(uuid) to authenticated;
