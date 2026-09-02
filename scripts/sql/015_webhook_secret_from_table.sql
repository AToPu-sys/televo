-- SECURITY FIX: 010 and 011 hardcoded the live webhook shared secret
-- directly in committed SQL. Since both Edge Functions are deployed with
-- --no-verify-jwt, that header was the ONLY thing gating them — anyone with
-- repo access could inject assistant-authored messages into any conversation,
-- burn Anthropic credit, or send arbitrary push notification text to any
-- user's device.
--
-- The secret has been rotated and now lives in private.app_secrets (a schema
-- with no grants to anon/authenticated, readable only by these SECURITY
-- DEFINER functions) and in the Edge Functions' own env. Neither copy is in
-- git.

create or replace function public.notify_ai_assistant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_assistant_conversation boolean;
  secret text;
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

  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/ai-assistant-reply',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
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

create or replace function public.notify_new_message_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  -- Don't fan out pushes for the assistant's own replies.
  if new.sender_id = '00000000-0000-0000-0000-000000000001' then
    return new;
  end if;

  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-push-notification',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
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

revoke execute on function public.notify_ai_assistant() from anon, public, authenticated;
revoke execute on function public.notify_new_message_push() from anon, public, authenticated;
