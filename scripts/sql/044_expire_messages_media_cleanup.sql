-- delete_expired_messages() (032_expire_messages_cron.sql) only ever did
-- `delete from messages` — it never removed the chat-media Storage object a
-- media message pointed at, because plain SQL can't call the Storage HTTP
-- API. Every self-destructing photo/video/document therefore left its file
-- in the bucket forever: the row (and the promise "this disappears") is
-- gone, the actual bytes are not. This mirrors the fix already applied to
-- the user-initiated delete path (src/hooks/useMessages.ts's deleteMessage)
-- for the timer-based path instead.
create or replace function public.delete_expired_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
  media_paths text[];
  secret text;
begin
  -- Collect storage paths BEFORE deleting the rows — the row is the only
  -- record of where the object lives. media_url is stored as either
  -- "path" or "path#nonce" (src/lib/media.ts's parseMediaRef); split_part
  -- on '#' strips the nonce fragment to get the real Storage key.
  select array_agg(split_part(media_url, '#', 1))
    into media_paths
    from public.messages
   where expires_at is not null
     and expires_at < now()
     and media_url is not null
     and kind in ('image', 'video', 'document')
     -- Local file:// refs mean the upload never completed — nothing on the
     -- server to remove, and not a valid Storage key besides.
     and media_url not like 'file:%'
     and media_url not like 'content:%'
   limit 5000;

  with doomed as (
    select id
      from public.messages
     where expires_at is not null
       and expires_at < now()
     limit 5000
  )
  delete from public.messages m
   using doomed
   where m.id = doomed.id;

  get diagnostics deleted_count = row_count;

  -- Fire-and-forget, same pattern as notify_incoming_call /
  -- notify_new_message_push: a Storage cleanup failure must not roll back
  -- or block the message deletion itself — the row disappearing is the part
  -- users and PRIVACY_POLICY.md's promise are about; an orphaned Storage
  -- object left behind on a rare HTTP failure is a (much smaller, already
  -- pre-existing) cleanup gap, not a correctness regression.
  if media_paths is not null and array_length(media_paths, 1) > 0 then
    select value into secret from private.app_secrets where key = 'webhook_shared_secret';

    perform net.http_post(
      url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/cleanup-expired-media',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', secret
      ),
      body := jsonb_build_object('paths', to_jsonb(media_paths))
    );
  end if;

  return deleted_count;
end;
$$;
