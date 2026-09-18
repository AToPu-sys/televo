-- repairMissingSessionKeys (src/hooks/useE2ee.tsx) needs to deposit a wrapped
-- session key for a peer WITHOUT touching a row that already exists (that
-- would desync a peer who already has a working key, wrapped under a key
-- this device may no longer even hold). It used
-- upsert(..., {ignoreDuplicates: true}), i.e. Postgres
-- INSERT ... ON CONFLICT DO NOTHING -- but ON CONFLICT DO NOTHING still runs
-- the INSERT policy's WITH CHECK against the proposed row before conflict
-- detection, even when the row turns out to already exist and nothing is
-- ultimately written. Since the SELECT policy on this table is
-- recipient-only (004_e2e_encryption.sql:36-39), a device can never read
-- whether a peer's row already exists to skip the attempt client-side either
-- -- so the "existing row" case reliably threw an RLS violation.
--
-- The fix is a SECURITY DEFINER function: it runs as the table owner, so it
-- can check existence across all recipients (not just its own row) and only
-- attempt the insert when there's truly nothing there yet, all in one
-- atomic, race-free statement.
create or replace function public.deposit_session_key_if_missing(
  p_conversation_id uuid,
  p_recipient_id uuid,
  p_sender_public_key text,
  p_encrypted_key text,
  p_nonce text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_conversation_participant(p_conversation_id, auth.uid()) then
    raise exception 'not a participant of this conversation';
  end if;

  insert into public.encrypted_session_keys
    (conversation_id, recipient_id, sender_public_key, encrypted_key, nonce)
  values
    (p_conversation_id, p_recipient_id, p_sender_public_key, p_encrypted_key, p_nonce)
  on conflict (conversation_id, recipient_id) do nothing;

  return found;
end;
$$;

revoke all on function public.deposit_session_key_if_missing from public;
grant execute on function public.deposit_session_key_if_missing to authenticated;
