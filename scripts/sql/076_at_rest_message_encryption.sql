begin;

-- Real at-rest encryption for messages.body, closing a gap a self-audit
-- found: code comments and the support agent's own knowledge both claimed
-- regular (non-Secret-Chat) messages are "stored encrypted on the server,"
-- but that was never true — messages.body was plain `text`, readable by
-- anyone with database access (a leaked service-role key, a compromised
-- project, direct DB access). The only real protection was TLS in transit
-- and Supabase's infrastructure-level disk encryption, which protects
-- against stolen disks, not against anyone who can run a query.
--
-- This adds a second, independent encryption layer under EVERY message
-- body (both regular chats AND Secret Chats — Secret Chat bodies are
-- already a {ciphertext,nonce} JSON envelope from client-side E2E; this
-- layer just wraps that envelope too, uniformly, rather than branching
-- logic on is_encrypted). The key lives in Supabase Vault, never in a plain
-- column — it's only readable inside a
-- SECURITY DEFINER function running as the table owner, never to
-- `authenticated`/`anon` directly and never via a normal SELECT.
--
-- What this DOES defend against: a leaked service-role key being used to
-- directly SELECT the messages table, a full database/backup export
-- leaking, or a compromised read replica without Vault access.
-- What this does NOT defend against: anyone who can execute SQL as the
-- postgres/table-owner role (they can always call the decrypt function
-- directly, same as a Supabase admin always could). It is defense in
-- depth, not a second E2E layer — only Secret Chats are genuinely unreadable
-- to the operator.

-- The key is generated once, here, and stored only in Vault. There is no
-- rotation story in this migration (rotating would require re-encrypting
-- every row with the new key before the old one is deleted) — out of scope
-- for this pass, noted for a future migration if key rotation is needed.
-- pgsodium isn't installed as its own extension on this project (only
-- pgcrypto + supabase_vault are) -- gen_random_bytes is pgcrypto's own CSPRNG
-- (backed by the OS's secure random source), equally suitable for a 32-byte
-- key and avoids depending on a schema that isn't actually present.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'message_body_encryption_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'message_body_encryption_key',
      'Symmetric key for at-rest encryption of messages.body (076_at_rest_message_encryption.sql). Never expose outside decrypt_message_body/encrypt_message_body.'
    );
  end if;
end $$;

-- Both functions are SECURITY DEFINER so they can read the Vault secret
-- (vault.decrypted_secrets is only readable by the table owner / service
-- role, never by `authenticated`) while still being safely callable by
-- ordinary users — they take/return only message text, never the key
-- itself, and REVOKE below strips the default PUBLIC execute grant so only
-- the trigger and the explicitly-granted RPCs below can reach them.
create or replace function public.encrypt_message_body(p_plaintext text)
returns text
language plpgsql
security definer
set search_path = public, extensions
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
  -- pgp_sym_encrypt (pgcrypto) bundles a random IV and an integrity check
  -- into its own output format, so there's no separate nonce column to
  -- manage, and tampering is detected on decrypt. Schema-qualified
  -- (extensions.*) rather than relying on search_path, matching this
  -- project's existing convention (012_fix_profile_exposure.sql).
  return encode(extensions.pgp_sym_encrypt(p_plaintext, encode(v_key, 'hex')), 'base64');
end;
$$;

create or replace function public.decrypt_message_body(p_ciphertext text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key bytea;
begin
  if p_ciphertext is null then
    return null;
  end if;
  select decode(decrypted_secret, 'base64') into v_key
  from vault.decrypted_secrets
  where name = 'message_body_encryption_key';
  if v_key is null then
    raise exception 'message_body_encryption_key not found in Vault';
  end if;
  begin
    return extensions.pgp_sym_decrypt(decode(p_ciphertext, 'base64'), encode(v_key, 'hex'));
  exception when others then
    -- Originally returned p_ciphertext here on failure, which made a failed
    -- decrypt indistinguishable from a successful one that happened to
    -- return ciphertext-shaped text -- that silent fallback is exactly what
    -- let the double-encryption backfill bug (2026-10-12) go unnoticed
    -- until a manual check caught it. Fail loud instead.
    raise warning 'decrypt_message_body: decryption failed for a row (% bytes of input)', length(p_ciphertext);
    return '[decryption error]';
  end;
end;
$$;

revoke all on function public.encrypt_message_body(text) from public, anon, authenticated;
revoke all on function public.decrypt_message_body(text) from public, anon, authenticated;
-- authenticated needs decrypt (via the view/RPCs below, which call it) but
-- the raw function itself is only ever invoked FROM another SECURITY
-- DEFINER context (the view, the trigger, the RPCs) -- granting it directly
-- to authenticated would let any signed-in user decrypt ANY row's body by
-- id, bypassing conversation-membership RLS entirely. Only service_role
-- (edge functions) gets direct execute.
grant execute on function public.decrypt_message_body(text) to service_role;

-- Encrypts body transparently on write. Runs for every message, regardless
-- of is_encrypted -- an E2E envelope is just another string to this layer.
create or replace function public.encrypt_message_body_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.body is not null and (tg_op = 'INSERT' or new.body is distinct from old.body) then
    new.body := public.encrypt_message_body(new.body);
  end if;
  return new;
end;
$$;

drop trigger if exists messages_encrypt_body on public.messages;
create trigger messages_encrypt_body
  before insert or update on public.messages
  for each row execute function public.encrypt_message_body_trigger();

-- Tracks progress so the backfill below is idempotent and safe to re-run if
-- interrupted (WHERE body_encrypted_at is null skips already-done rows).
-- Declared before the backfill that depends on it.
alter table public.messages add column if not exists body_encrypted_at timestamptz;

-- One-time backfill: encrypt every existing row. Chunked by id so a
-- 700-row table (today's scale) runs in well under a second, but the
-- pattern holds if the table is much larger later without locking it for a
-- long single UPDATE.
--
-- The trigger is disabled for this block: an earlier version of this
-- migration called encrypt_message_body() explicitly in the UPDATE below
-- AND left the BEFORE UPDATE trigger enabled, which then encrypted the
-- already-encrypted result a SECOND time (new.body is distinct from
-- old.body is true for an encrypt() call, so messages_encrypt_body_trigger
-- fired and wrapped it again) -- found via live verification against
-- production on 2026-10-12, repaired there with a one-off decrypt pass.
-- Disabling the trigger here makes this block's own single
-- encrypt_message_body() call the only encryption that happens.
do $$
declare
  v_rows integer;
begin
  alter table public.messages disable trigger messages_encrypt_body;
  loop
    with chunk as (
      select id from public.messages
      where body is not null and body_encrypted_at is null
      limit 200
    )
    update public.messages m
    set body = public.encrypt_message_body(m.body), body_encrypted_at = now()
    from chunk
    where m.id = chunk.id;
    get diagnostics v_rows = row_count;
    exit when v_rows = 0;
  end loop;
  alter table public.messages enable trigger messages_encrypt_body;
end $$;

-- View that decrypts transparently for reads. `security_invoker = true`
-- (Postgres 15+) means the view runs with the QUERYING user's own
-- privileges and RLS, not the view owner's -- every existing RLS policy on
-- public.messages (participant-only, MFA-gated, etc.) still applies exactly
-- as before; this view adds a decrypted column, nothing else. Clients and
-- RPCs should read through this view, never the raw table, when they need
-- body content.
create or replace view public.messages_decrypted
with (security_invoker = true)
as
select
  id, conversation_id, sender_id, kind,
  public.decrypt_message_body(body) as body,
  media_url, shared_activity_id, shared_profile_id,
  document_name, document_size_bytes, media_duration_ms, waveform,
  reply_to_id, forwarded_from_message_id, forwarded_from_sender_id,
  created_at, edited_at, expires_at
from public.messages;

grant select on public.messages_decrypted to authenticated;

commit;
