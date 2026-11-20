-- 090: a disappearing message stayed readable through the API until the
-- once-a-minute cleanup job deleted it, up to a minute after its timer ran
-- out. Reads now stop the moment it expires, whatever the job is doing.
drop policy if exists "expired_messages_are_gone" on public.messages;
create policy "expired_messages_are_gone" on public.messages
  as restrictive for select to authenticated
  using (expires_at is null or expires_at > now());
