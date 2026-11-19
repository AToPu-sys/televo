-- 088: stronger at-rest encryption for regular (cloud) chats, and no more
-- decryption oracle.
--
-- 1. New message bodies are encrypted with AES-256 instead of pgcrypto's
--    default AES-128. Old rows keep decrypting: the cipher is recorded in
--    each ciphertext's own header.
-- 2. decrypt_message_body(text) was executable by every signed-in user,
--    because messages_decrypted is a security_invoker view (076). It took raw
--    ciphertext, so anyone who got hold of another chat's ciphertext could
--    turn it into plaintext with one RPC call. The view now decrypts through
--    decrypt_message_for(id), which reads the body itself and only answers
--    for a message in a chat the caller belongs to, with MFA satisfied.
--    decrypt_message_body goes back to service_role and definer functions.

create or replace function public.encrypt_message_body(p_plaintext text)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_key bytea;
begin
  if p_plaintext is null then
    return null;
  end if;
  select decode(decrypted_secret, 'base64') into v_key
  from vault.decrypted_secrets
  where name = 'message_body_encryption_key';
  if v_key is null then
    raise exception 'message_body_encryption_key not found in Vault';
  end if;
  return encode(
    extensions.pgp_sym_encrypt(p_plaintext, encode(v_key, 'hex'), 'cipher-algo=aes256, compress-algo=0'),
    'base64'
  );
end;
$$;
revoke all on function public.encrypt_message_body(text) from public, anon, authenticated;

create or replace function public.decrypt_message_for(p_message_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.decrypt_message_body(m.body)
  from public.messages m
  where m.id = p_message_id
    and public.is_conversation_participant(m.conversation_id, (select auth.uid()))
    and public.session_meets_mfa_requirement();
$$;
revoke all on function public.decrypt_message_for(uuid) from public, anon;
grant execute on function public.decrypt_message_for(uuid) to authenticated;

create or replace view public.messages_decrypted
with (security_invoker = true)
as
select
  id, conversation_id, sender_id, kind,
  public.decrypt_message_for(id) as body,
  media_url, shared_activity_id, shared_profile_id,
  document_name, document_size_bytes, media_duration_ms, waveform,
  reply_to_id, forwarded_from_message_id, forwarded_from_sender_id,
  created_at, edited_at, expires_at
from public.messages;

revoke execute on function public.decrypt_message_body(text) from public, anon, authenticated;
grant execute on function public.decrypt_message_body(text) to service_role;
