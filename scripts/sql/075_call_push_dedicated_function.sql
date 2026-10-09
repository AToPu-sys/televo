-- Repoints the Expo-push leg of an incoming call (notify_incoming_call,
-- 020_call_push.sql) at the new send-call-push function instead of
-- send-push-notification.
--
-- Why this had to change: send-push-notification filters recipients on
-- notify_messages and only ever put `conversationId` in the push's `data`
-- payload — so a call pushed through it (a) rang someone who'd muted calls
-- but not messages (and vice versa — stayed silent for someone who wanted
-- calls but had muted messages), and (b) gave the client no way to tell a
-- call push apart from a message push, so a tap (or Android's foreground
-- delivery) could only ever open the chat, never the call screen. This is
-- the entire reason "calling Android, or Android calling out, don't
-- actually connect" was happening — see send-call-push's own header
-- comment for the full picture.
--
-- The VoIP push leg (027_voip_push_tokens.sql, notify_incoming_call_voip)
-- is untouched: it's iOS-only and already correct.
create or replace function public.notify_incoming_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  if new.status <> 'ringing' then
    return new;
  end if;

  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-call-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', new.id,
        'conversation_id', new.conversation_id,
        'caller_id', new.caller_id,
        'kind', new.kind
      )
    )
  );
  return new;
end;
$$;
