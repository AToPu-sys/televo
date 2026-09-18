-- The chat list used to fetch the 500 most recent messages across ALL of a
-- user's conversations in one query and reduce them client-side. That breaks
-- in two ways as soon as an account is actually used:
--
--   1. The 500 rows are taken globally, newest-first, so a handful of busy
--      chats consume the entire budget. Quieter conversations then come back
--      with NO rows at all and render "No messages yet" with a zero unread
--      badge — not a stale count, a wrong one, on a chat that may well have
--      unread messages in it.
--   2. Every refresh (and the list refreshes on every realtime message in
--      any chat) transfers up to 500 message bodies to compute what is really
--      one row and one integer per conversation.
--
-- This does the reduction where the data lives: one latest message and one
-- exact unread count per conversation, however far back the unread messages
-- go, with no row budget to exhaust.
create or replace function public.chat_list_summary()
returns table (
  conversation_id uuid,
  last_message_body text,
  last_message_kind public.message_kind,
  last_message_at timestamptz,
  last_message_sender_id uuid,
  unread_count integer
)
language sql
security definer
set search_path = public
stable
as $$
  with mine as (
    -- The caller's own membership row carries last_read_at, which is what
    -- makes a message unread. Scoping to auth.uid() here is what keeps this
    -- function from exposing any conversation the caller isn't in — it is
    -- SECURITY DEFINER, so RLS on messages does not apply inside it.
    select cp.conversation_id, cp.last_read_at
      from public.conversation_participants cp
     where cp.user_id = auth.uid()
  ),
  latest as (
    select distinct on (m.conversation_id)
           m.conversation_id,
           m.body,
           m.kind,
           m.created_at,
           m.sender_id
      from public.messages m
      join mine on mine.conversation_id = m.conversation_id
     order by m.conversation_id, m.created_at desc
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

revoke all on function public.chat_list_summary() from public;
grant execute on function public.chat_list_summary() to authenticated;

-- Without these the function degrades into a full scan of messages per
-- conversation as history grows — the exact scaling problem it exists to fix.
create index if not exists messages_conversation_created_at_desc_idx
  on public.messages (conversation_id, created_at desc);

create index if not exists messages_conversation_sender_created_at_idx
  on public.messages (conversation_id, sender_id, created_at);
