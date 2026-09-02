-- The pre-existing message_has_content check constraint didn't account for
-- the new 'document' kind added in 005_privacy_and_features.sql, so every
-- document message insert failed outright. Documents store their file at
-- media_url (same as image/video), so they belong in that branch.
alter table public.messages drop constraint message_has_content;

alter table public.messages add constraint message_has_content check (
  (kind = 'text' and body is not null)
  or (kind in ('image', 'video', 'document') and media_url is not null)
  or (kind = 'activity_share' and shared_activity_id is not null)
  or (kind = 'contact_share' and shared_profile_id is not null)
);
