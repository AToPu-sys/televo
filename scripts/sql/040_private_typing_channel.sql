-- Enabling private_only on the Realtime project setting (required to make
-- `private: true` actually enforce anything — see 039's own gap: policies
-- existed on realtime.messages, but without this project-level setting
-- "Allow public access" stayed on, so private:true on the client had no
-- server-side teeth) affects every broadcast/presence channel in the
-- project, not just the call ones. The typing-indicator channel
-- (`typing:<conversation id>`, src/hooks/useTyping.ts) is the only OTHER
-- broadcast channel in the app — postgres_changes channels (chats-list,
-- messages, read-state, incoming-calls, call-log) are authorized via RLS on
-- their underlying table regardless of this setting, so they need no policy
-- here. This migration is what makes it safe to turn private_only on
-- without breaking typing indicators project-wide.
create or replace function public.conversation_id_from_typing_topic(topic text)
returns uuid
language plpgsql
immutable
security definer
set search_path = public
as $$
declare
  raw text;
begin
  if topic like 'typing:%' then
    raw := substring(topic from 8);
  else
    return null;
  end if;

  begin
    return raw::uuid;
  exception when others then
    return null;
  end;
end;
$$;

grant execute on function public.conversation_id_from_typing_topic(text) to authenticated;

drop policy if exists "Conversation participants can read typing channel" on realtime.messages;
drop policy if exists "Conversation participants can write typing channel" on realtime.messages;

create policy "Conversation participants can read typing channel"
on realtime.messages
for select
to authenticated
using (
  public.is_conversation_participant(
    public.conversation_id_from_typing_topic(realtime.topic()),
    (select auth.uid())
  )
);

create policy "Conversation participants can write typing channel"
on realtime.messages
for insert
to authenticated
with check (
  public.is_conversation_participant(
    public.conversation_id_from_typing_topic(realtime.topic()),
    (select auth.uid())
  )
);
