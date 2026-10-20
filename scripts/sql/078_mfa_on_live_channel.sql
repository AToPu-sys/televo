-- 078: 2FA covers live updates too; read receipts honour the privacy switch.
--
-- 018 made reading messages require AAL2 for users who enrolled TOTP, but 077
-- added two ways around it:
--  - the private channel "user:<uid>" only checked the topic, and its
--    triggers send message rows already decrypted, so a session that knew
--    only the password (aal1) received every new and edited message live;
--  - chat_list_summary (security definer) decrypted each chat's last message
--    for that same aal1 session.
-- Both now require session_meets_mfa_requirement(), the check 018 uses.
-- Users without 2FA are unaffected (it is always true for them).
--
-- Also: participant_update carried last_read_at to everyone in the chat even
-- when the reader had turned read receipts off (profiles.show_read_receipts);
-- now it goes only to the reader's own devices in that case.

drop policy if exists "Users can read their own user channel" on realtime.messages;
create policy "Users can read their own user channel"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() = 'user:' || (select auth.uid())::text
    and (select public.session_meets_mfa_requirement())
  );

create or replace function public.chat_list_summary()
returns table(
  conversation_id uuid,
  last_message_body text,
  last_message_kind message_kind,
  last_message_at timestamp with time zone,
  last_message_sender_id uuid,
  unread_count integer
)
language sql
stable
security definer
set search_path = 'public'
as $$
  with mine as (
    select cp.conversation_id, cp.last_read_at
      from public.conversation_participants cp
     where cp.user_id = auth.uid()
       and public.session_meets_mfa_requirement()
  ),
  latest as (
    select mine.conversation_id,
           public.decrypt_message_body(l.body) as body,
           l.kind,
           l.created_at,
           l.sender_id
      from mine
      cross join lateral (
        select m.body, m.kind, m.created_at, m.sender_id
          from public.messages m
         where m.conversation_id = mine.conversation_id
         order by m.created_at desc
         limit 1
      ) l
  ),
  unread as (
    select m.conversation_id, count(*)::integer as unread_count
      from public.messages m
      join mine on mine.conversation_id = m.conversation_id
     where m.sender_id <> auth.uid()
       and (mine.last_read_at is null or m.created_at > mine.last_read_at)
     group by m.conversation_id
  )
  select mine.conversation_id,
         latest.body,
         latest.kind,
         latest.created_at,
         latest.sender_id,
         coalesce(unread.unread_count, 0)
    from mine
    left join latest on latest.conversation_id = mine.conversation_id
    left join unread on unread.conversation_id = mine.conversation_id;
$$;

create or replace function private.broadcast_participant_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipts boolean;
  payload jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.last_read_at is not distinct from old.last_read_at
       and new.deleted_at is not distinct from old.deleted_at
       and new.is_admin is not distinct from old.is_admin then
      return new;
    end if;
    payload := jsonb_build_object(
      'conversation_id', new.conversation_id,
      'user_id', new.user_id,
      'last_read_at', new.last_read_at
    );
    select coalesce(p.show_read_receipts, true) into receipts from public.profiles p where p.id = new.user_id;
    if coalesce(receipts, true) then
      perform private.send_to_conversation(new.conversation_id, 'participant_update', payload);
    else
      -- read receipts off: only the reader's own devices learn it
      perform private.send_to_user(new.user_id, 'participant_update', payload);
    end if;
    -- Whether a chat is hidden is the owner's business only.
    if new.deleted_at is distinct from old.deleted_at or new.is_admin is distinct from old.is_admin then
      perform private.send_to_user(
        new.user_id,
        'membership',
        jsonb_build_object('conversation_id', new.conversation_id, 'user_id', new.user_id, 'op', 'update')
      );
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform private.send_to_conversation(
      new.conversation_id,
      'membership',
      jsonb_build_object('conversation_id', new.conversation_id, 'user_id', new.user_id, 'op', 'join')
    );
    return new;
  end if;

  -- DELETE: the row is gone, so tell the removed user directly as well.
  perform private.send_to_user(
    old.user_id,
    'membership',
    jsonb_build_object('conversation_id', old.conversation_id, 'user_id', old.user_id, 'op', 'leave')
  );
  perform private.send_to_conversation(
    old.conversation_id,
    'membership',
    jsonb_build_object('conversation_id', old.conversation_id, 'user_id', old.user_id, 'op', 'leave')
  );
  return old;
end;
$$;
