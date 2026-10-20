-- 077: one private Realtime channel per user, fed by the database itself.
--
-- Until now every live update reached the app through Realtime's
-- postgres_changes: the Realtime server polls the WAL (realtime.list_changes)
-- and, for every changed row, re-checks RLS once per subscriber. The chat
-- list and the call screens subscribed to ALL inserts on messages and calls
-- (no filter), so every message anyone sent was evaluated against every
-- connected user's policies and thrown away for almost all of them.
-- `supabase inspect db calls` on 2026-10-17: realtime.list_changes was 68.6%
-- of all database time (923k calls) — with about twenty users.
--
-- Instead, triggers now push each change once, straight to the people it
-- concerns, on a private broadcast topic per user ("user:<uuid>") —
-- Supabase's "Broadcast from Database". A client keeps ONE channel open
-- (src/lib/userChannel.ts) for messages in every chat, read receipts,
-- membership changes and calls. The message payload carries the row already
-- decrypted at the storage layer (as messages_decrypted would return it; a
-- Secret Chat body is still its E2E envelope), so the app no longer re-fetches
-- every incoming message by id.
--
-- The supabase_realtime publication is left as it is for now: builds up to
-- 92 still use postgres_changes. Once nobody runs them, Realtime stops
-- polling on its own (it only polls while someone is subscribed), and the
-- tables can be dropped from the publication.
--
-- Also here:
--  - a new message un-hides a chat its recipients had "deleted for me"
--    (048) — done by each client on every received message until now, one
--    extra write per message per device;
--  - chat_list_summary decrypts one message per chat instead of every
--    message in every chat (it ran pgp_sym_decrypt on the whole history,
--    then kept the newest — 17.5 ms for 769 messages, growing linearly, on
--    every chat-list refresh);
--  - cron's run log is pruned (61k rows and growing by 1,440 a day);
--  - a duplicate index on messages is dropped.

-- ---------------------------------------------------------------------------
-- Who may listen: only the user themself, only broadcast.
-- ---------------------------------------------------------------------------
drop policy if exists "Users can read their own user channel" on realtime.messages;
create policy "Users can read their own user channel"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() = 'user:' || (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- Fan-out. Never lets a broadcast failure fail the write that caused it: a
-- message must be stored even if Realtime is having a bad minute (clients
-- catch up on reconnect).
-- ---------------------------------------------------------------------------
create or replace function private.send_to_user(p_user_id uuid, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(p_payload, p_event, 'user:' || p_user_id::text, true);
exception when others then
  raise warning 'send_to_user(%): %', p_event, sqlerrm;
end;
$$;

create or replace function private.send_to_conversation(p_conversation_id uuid, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  member uuid;
begin
  for member in
    select cp.user_id from public.conversation_participants cp where cp.conversation_id = p_conversation_id
  loop
    perform private.send_to_user(member, p_event, p_payload);
  end loop;
end;
$$;

revoke all on function private.send_to_user(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.send_to_conversation(uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- messages: message_insert / message_update / message_delete
-- ---------------------------------------------------------------------------
create or replace function private.broadcast_message_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
begin
  if tg_op = 'DELETE' then
    perform private.send_to_conversation(
      old.conversation_id,
      'message_delete',
      jsonb_build_object('id', old.id, 'conversation_id', old.conversation_id)
    );
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Un-hide the chat for anyone who had deleted it "for me" (048).
    update public.conversation_participants
       set deleted_at = null
     where conversation_id = new.conversation_id
       and deleted_at is not null;
  end if;

  -- Exactly the columns of messages_decrypted, body decrypted the same way.
  payload := jsonb_build_object(
    'id', new.id,
    'conversation_id', new.conversation_id,
    'sender_id', new.sender_id,
    'kind', new.kind,
    'body', public.decrypt_message_body(new.body),
    'media_url', new.media_url,
    'shared_activity_id', new.shared_activity_id,
    'shared_profile_id', new.shared_profile_id,
    'document_name', new.document_name,
    'document_size_bytes', new.document_size_bytes,
    'media_duration_ms', new.media_duration_ms,
    'waveform', new.waveform,
    'reply_to_id', new.reply_to_id,
    'forwarded_from_message_id', new.forwarded_from_message_id,
    'forwarded_from_sender_id', new.forwarded_from_sender_id,
    'created_at', new.created_at,
    'edited_at', new.edited_at,
    'expires_at', new.expires_at
  );

  perform private.send_to_conversation(
    new.conversation_id,
    case tg_op when 'INSERT' then 'message_insert' else 'message_update' end,
    payload
  );
  return new;
end;
$$;

drop trigger if exists messages_broadcast on public.messages;
create trigger messages_broadcast
  after insert or update or delete on public.messages
  for each row execute function private.broadcast_message_change();

-- ---------------------------------------------------------------------------
-- conversation_participants: participant_update (read receipts, "deleted for
-- me") and membership (joined / left / removed).
-- ---------------------------------------------------------------------------
create or replace function private.broadcast_participant_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.last_read_at is not distinct from old.last_read_at
       and new.deleted_at is not distinct from old.deleted_at
       and new.is_admin is not distinct from old.is_admin then
      return new;
    end if;
    perform private.send_to_conversation(
      new.conversation_id,
      'participant_update',
      jsonb_build_object(
        'conversation_id', new.conversation_id,
        'user_id', new.user_id,
        'last_read_at', new.last_read_at
      )
    );
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

drop trigger if exists conversation_participants_broadcast on public.conversation_participants;
create trigger conversation_participants_broadcast
  after insert or update or delete on public.conversation_participants
  for each row execute function private.broadcast_participant_change();

-- ---------------------------------------------------------------------------
-- calls: call_insert / call_update (incoming call ring, hangup watchdog,
-- call log).
-- ---------------------------------------------------------------------------
create or replace function private.broadcast_call_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.send_to_conversation(
    new.conversation_id,
    case tg_op when 'INSERT' then 'call_insert' else 'call_update' end,
    jsonb_build_object(
      'id', new.id,
      'conversation_id', new.conversation_id,
      'caller_id', new.caller_id,
      'kind', new.kind,
      'status', new.status,
      'started_at', new.started_at,
      'answered_at', new.answered_at,
      'ended_at', new.ended_at
    )
  );
  return new;
end;
$$;

drop trigger if exists calls_broadcast on public.calls;
create trigger calls_broadcast
  after insert or update on public.calls
  for each row execute function private.broadcast_call_change();

revoke all on function private.broadcast_message_change() from public, anon, authenticated;
revoke all on function private.broadcast_participant_change() from public, anon, authenticated;
revoke all on function private.broadcast_call_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- chat_list_summary: newest message per chat via the (conversation_id,
-- created_at) index, decrypting only that one. Same output as before.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
-- delete_expired_messages runs every minute and logs every run; keep a week.
select cron.unschedule(jobid) from cron.job where jobname = 'prune-cron-run-log';
select cron.schedule(
  'prune-cron-run-log',
  '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
delete from cron.job_run_details where end_time < now() - interval '7 days';

-- Same columns as messages_conversation_created_at_desc_idx; a b-tree reads
-- either direction, so this one only costs writes.
drop index if exists public.messages_conversation_id_created_at_idx;
