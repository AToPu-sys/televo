-- Extends deposit_session_key_if_missing (022_deposit_session_key_rpc.sql)
-- with the ML-KEM ciphertext parameter now produced by wrapSessionKey
-- (023/024_*.sql). Postgres can't add a parameter to an existing function
-- signature, so the old one is dropped and recreated with the same
-- ON CONFLICT DO NOTHING / SECURITY DEFINER shape plus the new column.
drop function if exists public.deposit_session_key_if_missing(uuid, uuid, text, text, text);

create or replace function public.deposit_session_key_if_missing(
  p_conversation_id uuid,
  p_recipient_id uuid,
  p_sender_public_key text,
  p_encrypted_key text,
  p_nonce text,
  p_kem_ciphertext text default null
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
    (conversation_id, recipient_id, sender_public_key, encrypted_key, nonce, kem_ciphertext)
  values
    (p_conversation_id, p_recipient_id, p_sender_public_key, p_encrypted_key, p_nonce, p_kem_ciphertext)
  on conflict (conversation_id, recipient_id) do nothing;

  return found;
end;
$$;

revoke all on function public.deposit_session_key_if_missing(uuid, uuid, text, text, text, text) from public;
grant execute on function public.deposit_session_key_if_missing(uuid, uuid, text, text, text, text) to authenticated;
