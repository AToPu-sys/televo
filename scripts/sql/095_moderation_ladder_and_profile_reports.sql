-- 095: moderation the way the founder asked for it.
--
-- 1. Moderators and system accounts cannot be reported at all.
-- 2. A report can name a whole profile instead of one message; it needs a
--    chat the two share, at most one a day per person reported.
-- 3. One strike per confirmed violation, whatever its severity:
--    1st = 1 hour without sending, 2nd = 1 day, 3rd = 1 week, 4th = forever.
--    A permanent ban is announced to every moderator in Televo Moderation.
-- Also: "forever" used to be stored as 'infinity', which the app could not
-- parse (new Date("infinity") is Invalid Date), so a permanently banned user
-- never saw the ban screen. It is now a far-future date.

create or replace function public.is_report_exempt(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.is_system_account(p_user) or exists (select 1 from public.moderators where user_id = p_user);
$$;
revoke all on function public.is_report_exempt(uuid) from public, anon, authenticated;

create or replace function public.verify_report_target()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_real_sender uuid;
  v_conversation uuid;
begin
  if new.message_id is not null then
    select sender_id, conversation_id into v_real_sender, v_conversation from public.messages where id = new.message_id;
    if v_real_sender is null then
      raise exception 'reported message not found';
    end if;
    if not exists (select 1 from public.conversation_participants
                    where conversation_id = v_conversation and user_id = new.reporter_id) then
      raise exception 'reporter is not a participant in the reported conversation';
    end if;
    new.reported_user_id := v_real_sender;
    new.conversation_id := v_conversation;
  else
    -- A report on a profile: allowed only between people who share a chat.
    if new.reported_user_id is null or new.reported_user_id = new.reporter_id then
      raise exception 'a report must name a message or another person';
    end if;
    if public.is_report_exempt(new.reported_user_id) then
      raise exception 'this account cannot be reported' using errcode = 'check_violation';
    end if;
    select a.conversation_id into v_conversation
      from public.conversation_participants a
      join public.conversation_participants b on b.conversation_id = a.conversation_id
     where a.user_id = new.reporter_id and b.user_id = new.reported_user_id
     limit 1;
    if v_conversation is null then
      raise exception 'you can only report someone you have a chat with';
    end if;
    if exists (select 1 from public.content_reports
                where reporter_id = new.reporter_id and reported_user_id = new.reported_user_id
                  and message_id is null and created_at > now() - interval '1 day') then
      raise exception 'duplicate report' using hint = 'You already reported this person today.';
    end if;
    new.conversation_id := coalesce(new.conversation_id, v_conversation);
  end if;
  if public.is_report_exempt(new.reported_user_id) then
    raise exception 'this account cannot be reported' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.apply_moderation_decision(p_report_id uuid, p_severity text, p_rationale text, p_decided_by text default 'auto')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_reported uuid;
  v_message uuid;
  v_strikes integer;
  v_action text;
  v_ban_until timestamptz;
  v_name text;
  v_mod uuid;
begin
  if p_severity not in ('none', 'low', 'medium', 'high') then
    raise exception 'severity must be none, low, medium or high';
  end if;

  select reported_user_id, message_id into v_reported, v_message
    from public.content_reports where id = p_report_id;
  if v_reported is null then
    raise exception 'report % not found', p_report_id;
  end if;

  if p_severity = 'none' or public.is_report_exempt(v_reported) then
    update public.content_reports set status = 'dismissed' where id = p_report_id;
    insert into public.moderation_decisions (report_id, reported_user_id, severity, action, rationale, decided_by)
    values (p_report_id, v_reported, p_severity, 'dismissed', p_rationale, p_decided_by);
    return jsonb_build_object('action', 'dismissed', 'strikes', 0);
  end if;

  -- The same message already cost its sender a strike through another report.
  if v_message is not null and exists (
    select 1 from public.moderation_decisions d
      join public.content_reports r on r.id = d.report_id
     where r.message_id = v_message and r.id <> p_report_id
       and d.action not in ('dismissed', 'reversed', 'duplicate')
  ) then
    update public.content_reports set status = 'actioned' where id = p_report_id;
    insert into public.moderation_decisions (report_id, reported_user_id, severity, action, rationale, decided_by)
    values (p_report_id, v_reported, p_severity, 'duplicate', 'Already actioned for this message', p_decided_by);
    select strikes into v_strikes from public.user_moderation where user_id = v_reported;
    return jsonb_build_object('action', 'duplicate', 'strikes', coalesce(v_strikes, 0));
  end if;

  insert into public.user_moderation (user_id, strikes, updated_at)
  values (v_reported, 1, now())
  on conflict (user_id) do update set strikes = public.user_moderation.strikes + 1, updated_at = now()
  returning strikes into v_strikes;

  if v_strikes >= 4 then
    v_action := 'banned_permanent';
    v_ban_until := '2999-12-31 00:00:00+00';
  elsif v_strikes = 3 then
    v_action := 'suspended_7d';
    v_ban_until := now() + interval '7 days';
  elsif v_strikes = 2 then
    v_action := 'suspended_24h';
    v_ban_until := now() + interval '1 day';
  else
    v_action := 'suspended_1h';
    v_ban_until := now() + interval '1 hour';
  end if;

  update public.user_moderation
     set banned_until = greatest(coalesce(banned_until, now()), v_ban_until),
         banned_reason = p_rationale, updated_at = now()
   where user_id = v_reported;

  update public.content_reports set status = 'actioned' where id = p_report_id;
  insert into public.moderation_decisions (report_id, reported_user_id, severity, action, rationale, decided_by)
  values (p_report_id, v_reported, p_severity, v_action, p_rationale, p_decided_by);

  if v_action = 'banned_permanent' then
    select display_name into v_name from public.profiles where id = v_reported;
    for v_mod in select user_id from public.moderators loop
      perform public.moderation_say(v_mod,
        'Бан навсегда (4-й страйк): ' || coalesce(public.one_line(v_name, 60), 'пользователь') || E'\n'
        || 'Televo ID: ' || v_reported || E'\n'
        || 'Причина: ' || public.one_line(p_rationale, 300) || E'\n\n'
        || 'Если человек попросит разблокировку, запрос придёт сюда.');
    end loop;
  end if;

  return jsonb_build_object('action', v_action, 'strikes', v_strikes);
end;
$$;
revoke all on function public.apply_moderation_decision(uuid, text, text, text) from public, anon, authenticated;

update public.user_moderation set banned_until = '2999-12-31 00:00:00+00' where banned_until = 'infinity';
