-- content_reports had no insert rate limit, and 036_moderation_trigger.sql
-- fires a Claude classification synchronously for every row. A single
-- authenticated account could therefore loop inserts and bill the project's
-- Anthropic account at whatever rate PostgREST accepts writes — the one
-- application-layer cost-abuse hole in an otherwise secret-gated backend.
--
-- Volumetric DDoS is Supabase's edge to absorb; this is the part that is
-- ours: an attacker who holds one valid login turning our own moderation
-- pipeline into a spend amplifier.
create or replace function public.enforce_report_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  select count(*)
    into recent_count
    from public.content_reports
   where reporter_id = new.reporter_id
     and created_at > now() - interval '1 hour';

  -- 20/hour is far above any honest use — a person reporting genuine abuse
  -- files a handful — while capping the worst case at a bounded, affordable
  -- number of classifier calls per account per hour.
  if recent_count >= 20 then
    raise exception 'report rate limit exceeded'
      using hint = 'You have filed too many reports recently. Please try again later.';
  end if;

  -- One report per user per message: refiling the same message repeatedly
  -- adds nothing for moderation and was the cheapest way to multiply calls.
  if exists (
    select 1 from public.content_reports
     where reporter_id = new.reporter_id
       and message_id is not distinct from new.message_id
       and new.message_id is not null
  ) then
    raise exception 'duplicate report'
      using hint = 'You have already reported this message.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_report_rate_limit_trigger on public.content_reports;
create trigger enforce_report_rate_limit_trigger
  before insert on public.content_reports
  for each row execute function public.enforce_report_rate_limit();

-- Supports the per-reporter window scan above.
create index if not exists content_reports_reporter_created_idx
  on public.content_reports (reporter_id, created_at desc);
