-- Self-destructing messages were only ever deleted by a setInterval running
-- inside an OPEN chat screen (src/hooks/useMessages.ts). That means a message
-- whose timer elapsed while nobody had the conversation on screen was never
-- deleted at all — it simply sat in Postgres, readable by the server, for as
-- long as the row lived.
--
-- PRIVACY_POLICY.md and the in-app self-destruct UI both promise these
-- messages disappear. Until this migration, that promise was only kept when
-- someone happened to be watching. This makes it true at rest, independent of
-- any client being open.
create extension if not exists pg_cron;

-- Deletes in bounded batches rather than one unbounded statement. A single
-- `delete from messages where expires_at < now()` would take a lock
-- proportional to however large the backlog is; capping it keeps each run
-- short and predictable, and anything left over is simply picked up by the
-- next minute's run.
create or replace function public.delete_expired_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
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
  return deleted_count;
end;
$$;

-- Not callable by users: this is a maintenance routine, and SECURITY DEFINER
-- means it bypasses RLS. cron.schedule runs it as the job owner, which does
-- not go through these grants.
revoke all on function public.delete_expired_messages() from public;
revoke all on function public.delete_expired_messages() from authenticated;
revoke all on function public.delete_expired_messages() from anon;

-- Every minute: the shortest self-destruct option the app offers is 30
-- seconds, so a message can outlive its timer by at most ~1 minute. Finer
-- granularity would cost a job run per interval for no meaningful privacy
-- gain, since the client already hides expired messages on sight.
select cron.unschedule('delete-expired-messages')
 where exists (select 1 from cron.job where jobname = 'delete-expired-messages');

select cron.schedule(
  'delete-expired-messages',
  '* * * * *',
  $$select public.delete_expired_messages()$$
);

-- Without this the sweep degrades into a full table scan of messages every
-- minute. Partial: only rows that can ever expire are of interest, which on a
-- normal chat history is a small fraction of the table.
create index if not exists messages_expires_at_idx
  on public.messages (expires_at)
  where expires_at is not null;
