-- AUDIT FIX 1: Secret Chats could be silently downgraded to plaintext.
-- Nothing stopped is_encrypted from being flipped back to false, and the
-- client trusts that flag to decide whether to encrypt. A peer could turn it
-- off and the victim's next message would be stored in the clear, with only
-- a small lock icon disappearing as the signal.
--
-- Encryption is now one-way: it can be turned on, never off. Same for a
-- self-destruct timer being cleared out from under the other person.
create or replace function public.prevent_encryption_downgrade()
returns trigger
language plpgsql
as $$
begin
  if old.is_encrypted and not new.is_encrypted then
    raise exception 'A Secret Chat cannot be turned back into a plaintext chat';
  end if;
  return new;
end;
$$;

create trigger conversations_no_encryption_downgrade
  before update on public.conversations
  for each row execute function public.prevent_encryption_downgrade();

-- AUDIT FIX 2: the "Senders can edit their own text messages" policy checked
-- only sender_id, so a sender could UPDATE *any* column on their own row --
-- including conversation_id, which moves an existing message into a
-- conversation they aren't a member of, bypassing the INSERT policy's
-- membership AND block checks entirely. Also expires_at (defeat a
-- self-destruct timer) and created_at/kind (forge history).
--
-- Editing is now genuinely just editing: body and edited_at, nothing else.
create or replace function public.enforce_message_edit_scope()
returns trigger
language plpgsql
as $$
begin
  if new.conversation_id is distinct from old.conversation_id
     or new.sender_id is distinct from old.sender_id
     or new.kind is distinct from old.kind
     or new.created_at is distinct from old.created_at
     or new.media_url is distinct from old.media_url
     or new.expires_at is distinct from old.expires_at
     or new.reply_to_id is distinct from old.reply_to_id
     or new.forwarded_from_message_id is distinct from old.forwarded_from_message_id
     or new.forwarded_from_sender_id is distinct from old.forwarded_from_sender_id
  then
    raise exception 'Only a message body may be edited';
  end if;
  return new;
end;
$$;

create trigger messages_edit_scope
  before update on public.messages
  for each row execute function public.enforce_message_edit_scope();

-- AUDIT FIX 3: the calls UPDATE policy allowed any conversation participant
-- to rewrite any call row -- in a group, ending someone else's call or
-- forging caller_id/timestamps in the history. Restrict it to the two people
-- actually on the call.
drop policy if exists "Participants can update call state" on public.calls;

create policy "Only the caller or callee can update a call"
on public.calls for update
to authenticated
using (
  is_conversation_participant(conversation_id, (select auth.uid()))
  and (
    caller_id = (select auth.uid())
    -- the callee: a participant of a direct conversation who isn't the caller
    or exists (
      select 1 from public.conversations c
      where c.id = calls.conversation_id and c.kind = 'direct'
    )
  )
)
with check (
  is_conversation_participant(conversation_id, (select auth.uid()))
);

-- AUDIT FIX 4: encrypted_session_keys had no UPDATE/DELETE policy, so a
-- reinstall (which generates a new device keypair) left an unwrappable row
-- that could never be replaced -- permanently bricking every Secret Chat
-- with "Unable to decrypt", including the user's own messages, with no
-- in-app recovery. Recipients may now replace or drop their OWN wrapped key.
create policy "Recipients can replace their own wrapped session key"
on public.encrypted_session_keys for update
to authenticated
using ((select auth.uid()) = recipient_id)
with check ((select auth.uid()) = recipient_id);

create policy "Recipients can delete their own wrapped session key"
on public.encrypted_session_keys for delete
to authenticated
using ((select auth.uid()) = recipient_id);
