-- Reports were write-only. 017_content_reports.sql created the table and gave
-- users an RLS policy to read their OWN reports — but no policy lets anyone
-- read everyone's, and no function exists to act on one. So the queue filled
-- up and nothing could ever be reviewed: the app promised moderation it had
-- no mechanism to perform.
--
-- Apple's Guideline 1.2 expects reports to actually be acted on, and removal
-- after launch is the usual consequence of ignoring them. This gives the
-- operator a way to see and resolve the queue.

-- Who may moderate. Deliberately a table rather than a role check: adding a
-- moderator must not require a schema change or a Postgres role grant.
create table if not exists public.moderators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.moderators enable row level security;
-- No policies: membership is managed out-of-band (SQL editor / service role).
-- Clients must never be able to read who the moderators are, let alone add
-- themselves.

create or replace function public.is_moderator(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.moderators m where m.user_id = uid);
$$;

-- The queue, oldest unresolved first. SECURITY DEFINER so it can read across
-- users, but it refuses outright unless the caller is a moderator — the check
-- is inside the function precisely because RLS cannot express it here.
create or replace function public.review_queue()
returns table (
  id uuid,
  reporter_id uuid,
  reported_user_id uuid,
  message_id uuid,
  reason text,
  reported_content text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_moderator(auth.uid()) then
    raise exception 'not authorised';
  end if;

  return query
  select r.id, r.reporter_id, r.reported_user_id, r.message_id, r.reason,
         r.reported_content, r.status, r.created_at
    from public.content_reports r
   where r.status = 'pending'
   order by r.created_at
   limit 200;
end;
$$;

create or replace function public.resolve_report(report_id uuid, outcome text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_moderator(auth.uid()) then
    raise exception 'not authorised';
  end if;

  if outcome not in ('actioned', 'dismissed') then
    raise exception 'outcome must be actioned or dismissed';
  end if;

  update public.content_reports
     set status = outcome
   where id = report_id;
end;
$$;

revoke all on function public.review_queue() from public, anon;
revoke all on function public.resolve_report(uuid, text) from public, anon;
grant execute on function public.review_queue() to authenticated;
grant execute on function public.resolve_report(uuid, text) to authenticated;

-- Pending reports are the only ones ever queried, and they are a small
-- fraction of the table once moderation is running.
create index if not exists content_reports_pending_idx
  on public.content_reports (created_at)
  where status = 'pending';
