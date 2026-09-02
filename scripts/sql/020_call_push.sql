-- Push a notification when someone is called, so an incoming call reaches
-- the device even when the app is closed. Without this a call only rings if
-- the app already happens to be open and subscribed.
--
-- A full-screen system call UI (Telegram-style) needs CallKit/ConnectionService
-- + PushKit, which is native code unavailable in Expo Go — this is the
-- notification-based approximation: tapping it opens the app on the answer
-- screen.
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
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-push-notification',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', new.id,
        'conversation_id', new.conversation_id,
        'sender_id', new.caller_id,
        'kind', 'call',
        'body', case when new.kind = 'video' then 'Incoming video call' else 'Incoming call' end
      )
    )
  );
  return new;
end;
$$;

create trigger on_call_notify_push
  after insert on public.calls
  for each row execute function public.notify_incoming_call();

revoke execute on function public.notify_incoming_call() from anon, public, authenticated;
