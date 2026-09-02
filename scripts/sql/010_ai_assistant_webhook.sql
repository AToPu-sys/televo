-- Fires the ai-assistant-reply Edge Function whenever a new text message
-- lands in a conversation the assistant participates in, sent by someone
-- other than the assistant. Uses pg_net (async HTTP from Postgres) so the
-- INSERT that triggers this isn't blocked waiting on the Claude API call.

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_ai_assistant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_assistant_conversation boolean;
begin
  if new.kind <> 'text' or new.sender_id = '00000000-0000-0000-0000-000000000001' then
    return new;
  end if;

  select exists (
    select 1 from public.conversation_participants
    where conversation_id = new.conversation_id
      and user_id = '00000000-0000-0000-0000-000000000001'
  ) into is_assistant_conversation;

  if not is_assistant_conversation then
    return new;
  end if;

  -- Fire-and-forget async POST; the Edge Function re-validates everything
  -- and does its own DB reads, so this payload only needs to identify which
  -- row triggered it.
  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/ai-assistant-reply',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '<rotated -- see scripts/sql/015>'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'messages',
      'record', jsonb_build_object(
        'id', new.id,
        'conversation_id', new.conversation_id,
        'sender_id', new.sender_id,
        'kind', new.kind,
        'body', new.body
      )
    )
  );

  return new;
end;
$$;

create trigger on_message_notify_ai_assistant
  after insert on public.messages
  for each row execute function public.notify_ai_assistant();

revoke execute on function public.notify_ai_assistant() from anon, public, authenticated;
