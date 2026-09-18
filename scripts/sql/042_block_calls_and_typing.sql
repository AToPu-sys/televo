-- Blocking was only enforced on messages (see "Participants can send
-- messages"), never on calls or typing indicators. A blocked user could
-- still call the person who blocked them (the VoIP push trigger fires and
-- the blocker's phone rings) and could still see/send typing indicators in
-- the shared conversation. Mirrors the exact is_blocked_between check the
-- messages policy already uses.

drop policy if exists "Participants can start a call" on public.calls;
create policy "Participants can start a call"
  on public.calls for insert
  with check (
    auth.uid() = caller_id
    and is_conversation_participant(conversation_id, auth.uid())
    and not exists (
      select 1
      from conversations c
      join conversation_participants other
        on other.conversation_id = c.id and other.user_id <> auth.uid()
      where c.id = calls.conversation_id
        and c.kind = 'direct'
        and is_blocked_between(auth.uid(), other.user_id)
    )
  );

-- UPDATE (answer/decline/end) is intentionally left unrestricted by block
-- status: a blocked-but-still-a-participant user must still be able to
-- decline/end a call that already exists (e.g. one that started before the
-- block), or the row would be stuck at 'ringing' forever with no way for
-- either side to close it out. The INSERT check above is what stops a NEW
-- call from being placed once blocked.

drop policy if exists "Conversation participants can write typing channel" on realtime.messages;
create policy "Conversation participants can write typing channel"
  on realtime.messages for insert
  with check (
    is_conversation_participant(conversation_id_from_typing_topic(realtime.topic()), auth.uid())
    and not exists (
      select 1
      from conversations c
      join conversation_participants other
        on other.conversation_id = c.id and other.user_id <> auth.uid()
      where c.id = conversation_id_from_typing_topic(realtime.topic())
        and c.kind = 'direct'
        and is_blocked_between(auth.uid(), other.user_id)
    )
  );
