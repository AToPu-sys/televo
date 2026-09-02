-- Lets any conversation participant delete a message that has already
-- expired (self-destruct timer elapsed), not just the sender. Without this,
-- only the sender's own client could ever clean up an expired message,
-- leaving it sitting in the recipient's view (or in the database
-- indefinitely if the sender's app never reopens that chat).
--
-- This is intentionally narrow: it does NOT let a participant delete an
-- unexpired message that isn't theirs -- the existing sender-only policy
-- still covers normal deletion. The two policies are additive (OR'd by
-- Postgres RLS).
create policy "Participants can delete expired messages"
on public.messages for delete
to authenticated
using (
  expires_at is not null
  and expires_at < now()
  and is_conversation_participant(conversation_id, (select auth.uid()))
);
