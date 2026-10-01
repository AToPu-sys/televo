-- The gettelevo.space landing page's beta waitlist form (index.html's
-- waitlist-form) has only ever written rows into public.waitlist — nothing
-- sent a confirmation email, so "we'll email you" on the page was a promise
-- the backend never kept. Fires an async webhook to the send-waitlist-email
-- Edge Function on every new signup, mirroring the existing
-- notify_new_message_push / notify_new_waitlist_signup webhook pattern
-- (011_push_tokens.sql) and reading the shared secret the same way
-- delete_expired_messages() does (044_expire_messages_media_cleanup.sql).
create or replace function public.notify_new_waitlist_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-waitlist-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object('email', new.email)
    )
  );
  return new;
end;
$$;

create trigger on_waitlist_signup_notify
  after insert on public.waitlist
  for each row execute function public.notify_new_waitlist_signup();

revoke execute on function public.notify_new_waitlist_signup() from anon, public, authenticated;
