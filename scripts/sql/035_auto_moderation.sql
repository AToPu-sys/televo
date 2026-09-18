-- Automated triage for content reports.
--
-- Reports arrive faster than a person can read them, and Guideline 1.2 makes
-- acting on them a condition of staying on the App Store. This grades each
-- report automatically and takes graduated action, while keeping every
-- decision reviewable and reversible by a human.
--
-- What this deliberately does NOT do: read message content off the server.
-- Messages are end-to-end encrypted. The only text available is the plaintext
-- snapshot the REPORTER's own device attached to their report — that is a
-- one-sided account, so it grades the report, never the conversation.

-- Strikes accumulate per user; a ban is a consequence of repetition, not of
-- any single accusation, which is what stops one malicious reporter from
-- removing someone.
create table if not exists public.user_moderation (
  user_id uuid primary key references auth.users(id) on delete cascade,
  strikes integer not null default 0,
  banned_until timestamptz,
  banned_reason text,
  updated_at timestamptz not null default now()
);

alter table public.user_moderation enable row level security;

-- A user may see their own standing — being banned without being told is
-- both hostile and a support burden.
create policy "Users can view their own moderation status"
on public.user_moderation for select
to authenticated
using ((select auth.uid()) = user_id);

-- Verdicts, one row per report handled. Kept separate from content_reports so
-- the automated judgement is auditable next to (not instead of) the report.
create table if not exists public.moderation_decisions (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.content_reports(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  severity text not null,
  action text not null,
  rationale text,
  decided_by text not null default 'auto',
  created_at timestamptz not null default now()
);

alter table public.moderation_decisions enable row level security;
-- No client policies: moderation reasoning is operator-only.

create index if not exists moderation_decisions_user_idx
  on public.moderation_decisions (reported_user_id, created_at desc);

-- Applies a verdict. SECURITY DEFINER because it writes tables no client may
-- touch; callable only by the service role (the edge function) and moderators.
create or replace function public.apply_moderation_decision(
  p_report_id uuid,
  p_severity text,
  p_rationale text,
  p_decided_by text default 'auto'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reported uuid;
  v_strikes integer;
  v_action text;
  v_ban_until timestamptz;
begin
  if p_severity not in ('none', 'low', 'medium', 'high') then
    raise exception 'severity must be none, low, medium or high';
  end if;

  select reported_user_id into v_reported
    from public.content_reports where id = p_report_id;

  if v_reported is null then
    raise exception 'report % not found', p_report_id;
  end if;

  -- 'none' closes the report without touching the accused user's record:
  -- a dismissed report must leave no trace on them.
  if p_severity = 'none' then
    update public.content_reports set status = 'dismissed' where id = p_report_id;
    insert into public.moderation_decisions
      (report_id, reported_user_id, severity, action, rationale, decided_by)
    values (p_report_id, v_reported, p_severity, 'dismissed', p_rationale, p_decided_by);
    return jsonb_build_object('action', 'dismissed', 'strikes', 0);
  end if;

  -- High-severity counts double: one credible report of something serious
  -- should not need three repetitions to matter.
  insert into public.user_moderation (user_id, strikes, updated_at)
  values (v_reported, case when p_severity = 'high' then 2 else 1 end, now())
  on conflict (user_id) do update
    set strikes = public.user_moderation.strikes
                  + case when p_severity = 'high' then 2 else 1 end,
        updated_at = now()
  returning strikes into v_strikes;

  -- Graduated. Escalating durations give a user a chance to correct course,
  -- while repetition still ends in a permanent ban.
  if v_strikes >= 6 then
    v_action := 'banned_permanent';
    v_ban_until := 'infinity'::timestamptz;
  elsif v_strikes >= 4 then
    v_action := 'suspended_7d';
    v_ban_until := now() + interval '7 days';
  elsif v_strikes >= 2 then
    v_action := 'suspended_24h';
    v_ban_until := now() + interval '24 hours';
  else
    v_action := 'warned';
    v_ban_until := null;
  end if;

  if v_ban_until is not null then
    update public.user_moderation
       set banned_until = v_ban_until,
           banned_reason = p_rationale,
           updated_at = now()
     where user_id = v_reported;
  end if;

  update public.content_reports set status = 'actioned' where id = p_report_id;

  insert into public.moderation_decisions
    (report_id, reported_user_id, severity, action, rationale, decided_by)
  values (p_report_id, v_reported, p_severity, v_action, p_rationale, p_decided_by);

  return jsonb_build_object('action', v_action, 'strikes', v_strikes);
end;
$$;

revoke all on function public.apply_moderation_decision(uuid, text, text, text)
  from public, anon, authenticated;

-- Lets a moderator undo an automated verdict. Automated moderation without a
-- reversal path is how a false positive becomes permanent.
create or replace function public.reverse_moderation(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_moderator(auth.uid()) then
    raise exception 'not authorised';
  end if;

  update public.user_moderation
     set strikes = 0, banned_until = null, banned_reason = null, updated_at = now()
   where user_id = p_user_id;

  insert into public.moderation_decisions
    (report_id, reported_user_id, severity, action, rationale, decided_by)
  select id, p_user_id, 'none', 'reversed', 'Manually cleared by moderator', 'moderator'
    from public.content_reports
   where reported_user_id = p_user_id
   order by created_at desc
   limit 1;
end;
$$;

revoke all on function public.reverse_moderation(uuid) from public, anon;
grant execute on function public.reverse_moderation(uuid) to authenticated;

-- Enforcement. A banned user must not be able to keep sending: without this
-- the whole pipeline is bookkeeping that changes nothing.
create or replace function public.enforce_ban_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until timestamptz;
begin
  select banned_until into v_until
    from public.user_moderation
   where user_id = new.sender_id;

  if v_until is not null and v_until > now() then
    raise exception 'account suspended'
      using hint = 'Your account is suspended for violating the community rules.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_ban_before_message on public.messages;
create trigger enforce_ban_before_message
  before insert on public.messages
  for each row execute function public.enforce_ban_on_message();
