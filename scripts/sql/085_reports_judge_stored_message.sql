-- Reports: the text in a report came from the reporter, and a report with no
-- message named any reported_user_id unchecked, so three made-up "threats"
-- against anyone added up to a permanent ban. Now: a report must name a real
-- message; moderate-report judges the stored message, never the reporter's
-- copy, and sends Secret Chat reports to a human; automatic verdicts stop at
-- a 7-day suspension.

create or replace function public.verify_report_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_real_sender uuid;
  v_conversation uuid;
begin
  if new.message_id is null then
    raise exception 'a report must name a message';
  end if;
  select sender_id, conversation_id into v_real_sender, v_conversation from public.messages where id = new.message_id;
  if v_real_sender is null then
    raise exception 'reported message not found';
  end if;
  if not exists (
    select 1 from public.conversation_participants
     where conversation_id = v_conversation and user_id = new.reporter_id
  ) then
    raise exception 'reporter is not a participant in the reported conversation';
  end if;
  new.reported_user_id := v_real_sender;
  new.conversation_id := v_conversation;
  return new;
end;
$function$;

create or replace function public.notify_content_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  secret text;
begin
  select value into secret from private.app_secrets where key = 'webhook_shared_secret';
  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/moderate-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    body := jsonb_build_object('record', jsonb_build_object(
      'id', new.id,
      'reporter_id', new.reporter_id,
      'reported_user_id', new.reported_user_id,
      'message_id', new.message_id,
      'reason', new.reason
    ))
  );
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apply_moderation_decision(p_report_id uuid, p_severity text, p_rationale text, p_decided_by text DEFAULT 'auto'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if v_strikes >= 6 and p_decided_by not like 'auto:%' then
    v_action := 'banned_permanent';
    v_ban_until := 'infinity'::timestamptz;
  elsif v_strikes >= 6 then
    -- An automatic verdict never bans for good; that takes a person.
    v_action := 'suspended_7d';
    v_ban_until := now() + interval '7 days';
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
$function$;
