-- Push notification tokens. One row per (user, device) -- a user signed in
-- on two devices gets a push on both. Tokens are Expo push tokens
-- ("ExponentPushToken[...]"), not raw APNs/FCM tokens -- Expo's push service
-- is the one thing actually sending the notification, using these.
create table public.push_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null,
  device_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, expo_push_token)
);

alter table public.push_tokens enable row level security;

create policy "Users can view their own push tokens"
on public.push_tokens for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can register their own push token"
on public.push_tokens for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can remove their own push token"
on public.push_tokens for delete
to authenticated
using ((select auth.uid()) = user_id);

-- Fires an async webhook to the send-push-notification Edge Function
-- whenever a new text/image/document message lands, so every OTHER
-- participant in that conversation gets a push. Mirrors the AI assistant's
-- webhook pattern (notify_ai_assistant / ai-assistant-reply).
create or replace function public.notify_new_message_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-push-notification',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '<rotated -- see scripts/sql/015>'
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

create trigger on_message_notify_push
  after insert on public.messages
  for each row execute function public.notify_new_message_push();

revoke execute on function public.notify_new_message_push() from anon, public, authenticated;
