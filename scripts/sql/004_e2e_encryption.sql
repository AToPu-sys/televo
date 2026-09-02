-- Opt-in end-to-end encryption for direct chats ("Secret Chats"), modeled on
-- Telegram's design: a per-device X25519 keypair, a random per-conversation
-- session key wrapped (nacl.box) to each participant's public key, and
-- message bodies encrypted client-side before they ever reach the server.
-- The server (and the DB owner) can see ciphertext, key material it cannot
-- decrypt, and metadata (who/when) -- never plaintext message content.

-- Device public key. Private key never leaves the device (expo-secure-store).
alter table public.profiles
  add column e2e_public_key text;

-- Marks a conversation as a Secret Chat. Only meaningful for kind='direct' --
-- group E2E is out of scope for this pass.
alter table public.conversations
  add column is_encrypted boolean not null default false;

-- One row per (conversation, recipient): the conversation's random session
-- key, encrypted with nacl.box to that recipient's public key, plus the
-- nonce nacl.box needs. Only the intended recipient can decrypt their row.
create table public.encrypted_session_keys (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  sender_public_key text not null,
  encrypted_key text not null,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, recipient_id)
);

alter table public.encrypted_session_keys enable row level security;

-- Only the intended recipient can ever read their wrapped key -- this is the
-- whole point: even a participant in the conversation can't read the OTHER
-- participant's wrapped copy (it's wrapped to a different public key anyway,
-- but RLS keeps it from even being fetchable).
create policy "Recipients can read their own wrapped session key"
on public.encrypted_session_keys for select
to authenticated
using ((select auth.uid()) = recipient_id);

-- Either participant can deposit a wrapped key for the other, but only if
-- they're actually a participant in that conversation.
create policy "Participants can deposit a wrapped session key"
on public.encrypted_session_keys for insert
to authenticated
with check (is_conversation_participant(conversation_id, (select auth.uid())));

alter publication supabase_realtime add table public.encrypted_session_keys;

-- messages.body already stores arbitrary text; for an encrypted conversation
-- the app puts a JSON envelope ({ciphertext, nonce}) there instead of
-- plaintext. No schema change needed for that -- it's still just `text`.
