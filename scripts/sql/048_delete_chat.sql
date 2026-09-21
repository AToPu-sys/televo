-- Two distinct "delete chat" actions, neither of which existed before:
-- per-participant "delete for me" (hides the chat locally, leaves the other
-- person's copy untouched), and a real "delete for both" (removes the
-- conversation and, via the existing CASCADE FK, every message in it).

-- "Delete for me": a participant-scoped soft delete. The conversation row
-- and every message stay exactly as they are for the other participant(s) —
-- only this row's owner stops seeing the chat. Nullable, defaults unset:
-- most participant rows are never deleted, so this stays cheap to scan past.
alter table public.conversation_participants
  add column if not exists deleted_at timestamptz;

-- Re-opening a conversation (a new message arrives, or you message them
-- again) should un-hide it rather than requiring a separate "restore"
-- action — matches how a soft-deleted chat is expected to behave elsewhere
-- (Telegram, WhatsApp): sending or receiving effectively "restarts" it.
-- Handled client-side by clearing deleted_at on send/receive rather than
-- here, since a trigger firing on every message insert for every recipient
-- is needless overhead on the hot path — this column only needs to be
-- correct at read time, not instantaneously on every write.

-- "Delete for both": lets any participant remove the conversation outright.
-- The existing CASCADE on messages.conversation_id (and on
-- conversation_participants, encrypted_session_keys, calls, etc., all
-- already FK'd to conversations with on delete cascade from earlier
-- migrations) does the rest — this is the one missing policy that was
-- blocking it entirely; there was no DELETE policy on conversations at all
-- before this.
create policy "Participants can delete their conversation"
on public.conversations for delete
to authenticated
using (
  exists (
    select 1 from public.conversation_participants
    where conversation_id = conversations.id
      and user_id = (select auth.uid())
  )
);
