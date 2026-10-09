-- Voice messages, step 2 of 2. The audio file lives in chat-media like any
-- other media (media_url, with a #nonce suffix when encrypted for a Secret
-- Chat). Duration and a small amplitude waveform are stored as plain columns
-- so the bubble can render its length and shape before the audio downloads.
alter table public.messages
  add column if not exists media_duration_ms integer,
  add column if not exists waveform text;

alter table public.messages drop constraint message_has_content;
alter table public.messages add constraint message_has_content check (
  (kind = 'text' and body is not null)
  or (kind in ('image', 'video', 'document', 'voice') and media_url is not null)
  or (kind = 'activity_share' and shared_activity_id is not null)
  or (kind = 'contact_share' and shared_profile_id is not null)
);

-- Same as 044, plus 'voice': a self-destructing voice message must take its
-- audio file with it, or "this disappears" would be false for voice notes.
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
     and kind in ('image', 'video', 'document', 'voice')
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
