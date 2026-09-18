-- VoIP push tokens are NOT Expo push tokens (push_tokens.expo_push_token) —
-- PushKit hands the native module a raw APNs device token, and only a
-- direct HTTP/2 connection to APNs authenticated with the VoIP Services
-- Certificate can deliver to it. Expo's push service has no concept of a
-- VoIP push at all. Kept in its own table rather than a column on
-- push_tokens because the two token TYPES are delivered to entirely
-- different APNs endpoints/topics and must never be conflated.
create table public.voip_push_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  apns_token text not null,
  device_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, apns_token)
);

alter table public.voip_push_tokens enable row level security;

create policy "Users can view their own VoIP push tokens"
on public.voip_push_tokens for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can register their own VoIP push token"
on public.voip_push_tokens for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can remove their own VoIP push token"
on public.voip_push_tokens for delete
to authenticated
using ((select auth.uid()) = user_id);

-- Separate trigger from notify_incoming_call (020_call_push.sql), which
-- keeps sending the existing Expo push as a fallback for devices with no
-- VoIP token registered yet (e.g. this build hasn't reached them). This one
-- calls a DIFFERENT function (send-voip-push) that speaks APNs directly.
create or replace function public.notify_incoming_call_voip()
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
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-voip-push',
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

create trigger on_call_notify_voip_push
  after insert on public.calls
  for each row execute function public.notify_incoming_call_voip();

revoke execute on function public.notify_incoming_call_voip() from anon, public, authenticated;
