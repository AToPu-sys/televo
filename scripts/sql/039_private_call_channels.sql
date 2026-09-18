-- Call signalling ran over PUBLIC Realtime broadcast channels named
-- `call:<call id>` and `call-status:<call id>`. Any authenticated Televo user
-- who learned a call's UUID could subscribe and receive that call's SDP and
-- ICE candidates, or inject their own — the one place in the app where
-- protection rested on an identifier staying secret rather than on an
-- authorization check.
--
-- Exploiting it needs the UUID to leak first (128 random bits, and the
-- `calls` row itself is participant-gated by RLS), and the media stream is
-- separately protected by DTLS-SRTP — so this was never an open door. But a
-- secret identifier is a weaker guarantee than a server-side check, and this
-- closes the gap.
--
-- RLS is already enabled on realtime.messages by Supabase; only policies are
-- needed. The helper lives in `public` because creating functions inside the
-- `realtime` schema is denied.
create or replace function public.call_id_from_topic(topic text)
returns uuid
language plpgsql
immutable
security definer
set search_path = public
as $$
declare
  raw text;
begin
  if topic like 'call:%' then
    raw := substring(topic from 6);
  elsif topic like 'call-status:%' then
    raw := substring(topic from 13);
  else
    return null;
  end if;

  -- A malformed suffix must deny rather than raise: an exception inside an
  -- RLS policy surfaces as a broken subscription instead of a clean refusal.
  begin
    return raw::uuid;
  exception when others then
    return null;
  end;
end;
$$;

grant execute on function public.call_id_from_topic(text) to authenticated;

drop policy if exists "Call participants can read call channels" on realtime.messages;
drop policy if exists "Call participants can write call channels" on realtime.messages;

-- Only the people on a call may join or send on its signalling channels.
-- Reuses is_conversation_participant so there is one definition of
-- "is in this conversation" rather than a second copy that can drift.
create policy "Call participants can read call channels"
on realtime.messages
for select
to authenticated
using (
  exists (
    select 1
      from public.calls c
     where c.id = public.call_id_from_topic(realtime.topic())
       and public.is_conversation_participant(c.conversation_id, (select auth.uid()))
  )
);

create policy "Call participants can write call channels"
on realtime.messages
for insert
to authenticated
with check (
  exists (
    select 1
      from public.calls c
     where c.id = public.call_id_from_topic(realtime.topic())
       and public.is_conversation_participant(c.conversation_id, (select auth.uid()))
  )
);
