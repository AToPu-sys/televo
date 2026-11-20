-- 092: holes found by attacking the ban / unblock system (091).
--
-- 1. A suspended user could build a group with themselves, a moderator and
--    the Televo Moderation account; a casual "да" from the moderator there
--    approved their own unblock request. Answers now count only in the
--    server-made direct chat, and nobody can add a system account to a chat.
-- 2. A plain "Да" applied to whichever request happened to be open, possibly
--    one the moderator had not read. It now applies only to the latest
--    request posted in that chat; otherwise the moderator is asked to reply
--    to the specific message.
-- 3. The suspension only blocked new messages: a suspended user could keep
--    editing old ones, and could still add people to chats.
-- 4. One bad message reported by several people earned strikes once per
--    report. It now counts once.
-- 5. Line breaks in a user's name or request text could forge lines of the
--    case card ("Решение ИИ: none"). They are flattened.

-- 1 + 3: who can be added -------------------------------------------------------
create or replace function public.can_add_participant(p_conversation uuid, p_new_user uuid, p_new_is_admin boolean)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid := auth.uid();
  v_kind public.conversation_kind;
  v_creator uuid;
  v_count integer;
begin
  if v_uid is null then
    return false;
  end if;
  if public.is_system_account(p_new_user) then
    return false;
  end if;
  select kind, created_by into v_kind, v_creator
    from public.conversations where id = p_conversation;
  if not found then
    return false;
  end if;
  select count(*) into v_count
    from public.conversation_participants where conversation_id = p_conversation;

  if p_new_user = v_uid then
    return v_creator = v_uid and v_count = 0 and (not p_new_is_admin or v_kind = 'group');
  end if;

  if exists (select 1 from public.user_moderation where user_id = v_uid and banned_until > now()) then
    return false;
  end if;

  if v_kind = 'direct' then
    return v_creator = v_uid and v_count = 1 and not p_new_is_admin
       and public.is_conversation_participant(p_conversation, v_uid);
  end if;

  return public.is_group_admin(p_conversation, v_uid) and not p_new_is_admin;
end;
$$;

-- 3: suspended users cannot edit messages either --------------------------------
create or replace function public.enforce_ban_on_message_edit()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  -- auth.uid() is set for client requests and null for server jobs; current_user
  -- would always read as the owner inside this security definer function.
  if auth.uid() is not null and exists (
    select 1 from public.user_moderation where user_id = new.sender_id and banned_until > now()
  ) then
    raise exception 'account suspended or deleted'
      using hint = 'This account can no longer edit messages.';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_ban_before_message_edit on public.messages;
create trigger enforce_ban_before_message_edit
  before update on public.messages
  for each row execute function public.enforce_ban_on_message_edit();

-- 4: one message, one set of strikes ----------------------------------------------
create or replace function public.apply_moderation_decision(p_report_id uuid, p_severity text, p_rationale text, p_decided_by text default 'auto')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_reported uuid;
  v_message uuid;
  v_strikes integer;
  v_action text;
  v_ban_until timestamptz;
begin
  if p_severity not in ('none', 'low', 'medium', 'high') then
    raise exception 'severity must be none, low, medium or high';
  end if;

  select reported_user_id, message_id into v_reported, v_message
    from public.content_reports where id = p_report_id;

  if v_reported is null then
    raise exception 'report % not found', p_report_id;
  end if;

  if p_severity = 'none' then
    update public.content_reports set status = 'dismissed' where id = p_report_id;
    insert into public.moderation_decisions
      (report_id, reported_user_id, severity, action, rationale, decided_by)
    values (p_report_id, v_reported, p_severity, 'dismissed', p_rationale, p_decided_by);
    return jsonb_build_object('action', 'dismissed', 'strikes', 0);
  end if;

  -- The same message already cost its sender strikes through an earlier
  -- report: record this one, but don't punish twice.
  if v_message is not null and exists (
    select 1 from public.moderation_decisions d
      join public.content_reports r on r.id = d.report_id
     where r.message_id = v_message and r.id <> p_report_id
       and d.action not in ('dismissed', 'reversed', 'duplicate')
  ) then
    update public.content_reports set status = 'actioned' where id = p_report_id;
    insert into public.moderation_decisions
      (report_id, reported_user_id, severity, action, rationale, decided_by)
    values (p_report_id, v_reported, p_severity, 'duplicate', 'Already actioned for this message', p_decided_by);
    select strikes into v_strikes from public.user_moderation where user_id = v_reported;
    return jsonb_build_object('action', 'duplicate', 'strikes', coalesce(v_strikes, 0));
  end if;

  insert into public.user_moderation (user_id, strikes, updated_at)
  values (v_reported, case when p_severity = 'high' then 2 else 1 end, now())
  on conflict (user_id) do update
    set strikes = public.user_moderation.strikes
                  + case when p_severity = 'high' then 2 else 1 end,
        updated_at = now()
  returning strikes into v_strikes;

  if v_strikes >= 6 and p_decided_by not like 'auto:%' then
    v_action := 'banned_permanent';
    v_ban_until := 'infinity'::timestamptz;
  elsif v_strikes >= 6 then
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
       set banned_until = v_ban_until, banned_reason = p_rationale, updated_at = now()
     where user_id = v_reported;
  end if;

  update public.content_reports set status = 'actioned' where id = p_report_id;

  insert into public.moderation_decisions
    (report_id, reported_user_id, severity, action, rationale, decided_by)
  values (p_report_id, v_reported, p_severity, v_action, p_rationale, p_decided_by);

  return jsonb_build_object('action', v_action, 'strikes', v_strikes);
end;
$$;
revoke all on function public.apply_moderation_decision(uuid, text, text, text) from public, anon, authenticated;

-- 1 + 2: answers only in the real moderation chat, plain answers only for the
-- latest request in it --------------------------------------------------------------
create or replace function public.is_moderation_chat(p_conversation uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.conversations c
     where c.id = p_conversation and c.kind = 'direct' and not c.is_encrypted
       and c.created_by = '00000000-0000-0000-0000-000000000002'
  ) and (select count(*) from public.conversation_participants where conversation_id = p_conversation) = 2;
$$;
revoke all on function public.is_moderation_chat(uuid) from public, anon, authenticated;

create or replace function public.moderation_chat_with(p_user uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_id uuid;
begin
  select c.id into v_id
    from public.conversations c
   where public.is_moderation_chat(c.id)
     and exists (select 1 from public.conversation_participants p where p.conversation_id = c.id and p.user_id = p_user)
   order by c.created_at limit 1;
  if v_id is null then
    insert into public.conversations (id, kind, created_by)
    values (gen_random_uuid(), 'direct', '00000000-0000-0000-0000-000000000002') returning id into v_id;
    insert into public.conversation_participants (conversation_id, user_id)
    values (v_id, '00000000-0000-0000-0000-000000000002'), (v_id, p_user);
  end if;
  return v_id;
end;
$$;
revoke all on function public.moderation_chat_with(uuid) from public, anon, authenticated;

create or replace function public.handle_moderation_reply()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_text text;
  v_word text;
  v_approve boolean;
  v_appeal public.ban_appeals%rowtype;
  v_latest uuid;
  v_name text;
  v_lang text;
  v_until timestamptz;
begin
  if new.kind <> 'text' or new.sender_id = '00000000-0000-0000-0000-000000000002'
     or not exists (select 1 from public.moderators where user_id = new.sender_id)
     or not public.is_moderation_chat(new.conversation_id) then
    return new;
  end if;

  v_text := public.decrypt_message_body(new.body);
  v_word := lower(regexp_replace(coalesce(v_text, ''), '[^[:alpha:]]', '', 'g'));
  if v_word in ('да', 'yes', 'y', 'д') then v_approve := true;
  elsif v_word in ('нет', 'no', 'n', 'н') then v_approve := false;
  else
    perform public.moderation_say(new.sender_id, 'Ответьте «Да» или «Нет» на сообщение с запросом.', new.id);
    return new;
  end if;

  if new.reply_to_id is not null then
    select * into v_appeal from public.ban_appeals
     where status = 'pending' and new.reply_to_id = any(notice_message_ids) limit 1;
    if v_appeal.id is null then
      perform public.moderation_say(new.sender_id, 'Этот запрос уже решён или это не запрос.', new.id);
      return new;
    end if;
  else
    -- Plain answer: only for the most recent request posted in this chat.
    select m.id into v_latest from public.messages m
     where m.conversation_id = new.conversation_id
       and m.sender_id = '00000000-0000-0000-0000-000000000002'
       and exists (select 1 from public.ban_appeals a where m.id = any(a.notice_message_ids))
     order by m.created_at desc limit 1;
    select * into v_appeal from public.ban_appeals
     where status = 'pending' and v_latest = any(notice_message_ids) limit 1;
    if v_appeal.id is null then
      perform public.moderation_say(new.sender_id,
        case when exists (select 1 from public.ban_appeals where status = 'pending')
             then 'Ответьте прямо на нужный запрос (свайп влево по сообщению), чтобы было понятно, о ком речь.'
             else 'Открытых запросов нет.' end, new.id);
      return new;
    end if;
  end if;

  select display_name, coalesce(language, 'en') into v_name, v_lang from public.profiles where id = v_appeal.user_id;

  if v_approve then
    update public.user_moderation
       set strikes = 0, banned_until = null, banned_reason = null, updated_at = now()
     where user_id = v_appeal.user_id;
    insert into public.moderation_decisions (report_id, reported_user_id, severity, action, rationale, decided_by)
    select r.id, v_appeal.user_id, 'none', 'reversed', 'Unblock request approved by a moderator', 'moderator'
      from public.content_reports r where r.reported_user_id = v_appeal.user_id
     order by r.created_at desc limit 1;
  end if;

  update public.ban_appeals
     set status = case when v_approve then 'approved' else 'denied' end,
         decided_at = now(), decided_by = new.sender_id
   where id = v_appeal.id;

  perform public.moderation_say(new.sender_id,
    case when v_approve then 'Готово: ' || coalesce(v_name, 'пользователь') || ' разблокирован.'
         else 'Блокировка ' || coalesce(v_name, 'пользователя') || ' оставлена.' end, new.id);

  select banned_until into v_until from public.user_moderation where user_id = v_appeal.user_id;
  perform public.moderation_say(v_appeal.user_id,
    case
      when v_approve and v_lang = 'ru' then 'Ваша блокировка снята. Пожалуйста, соблюдайте правила Televo.'
      when v_approve then 'Your suspension has been lifted. Please follow the Televo rules.'
      when v_lang = 'ru' then 'Мы рассмотрели ваш запрос и оставили блокировку'
           || case when v_until = 'infinity' then '.' else ' до ' || to_char(v_until at time zone 'UTC', 'DD.MM.YYYY HH24:MI') || ' UTC.' end
      else 'We reviewed your request and kept the suspension'
           || case when v_until = 'infinity' then '.' else ' until ' || to_char(v_until at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.' end
    end);
  return new;
end;
$$;
revoke all on function public.handle_moderation_reply() from public, anon, authenticated;

-- 5: user-controlled text goes into the case card on one line ---------------------
create or replace function public.one_line(p_text text, p_max int)
returns text language sql immutable set search_path to 'public' as $$
  select left(btrim(regexp_replace(coalesce(p_text, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), p_max);
$$;

create or replace function public.submit_ban_appeal(p_message text)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid := auth.uid();
  v_mod public.user_moderation%rowtype;
  v_dec record;
  v_reported_text text;
  v_prof record;
  v_appeal uuid;
  v_notices uuid[] := '{}';
  v_moderator uuid;
  v_case text;
  v_lang text;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  p_message := btrim(coalesce(p_message, ''));
  if char_length(p_message) < 1 or char_length(p_message) > 1000 then
    raise exception 'appeal_length' using hint = 'Write between 1 and 1000 characters.';
  end if;

  select * into v_mod from public.user_moderation where user_id = v_uid;
  if v_mod.banned_until is null or v_mod.banned_until <= now() then
    raise exception 'not_suspended';
  end if;
  if (select count(*) from public.ban_appeals where user_id = v_uid and created_at > now() - interval '7 days') >= 3 then
    raise exception 'too_many_appeals' using hint = 'You can send up to 3 requests a week.';
  end if;

  insert into public.ban_appeals (user_id, message) values (v_uid, p_message) returning id into v_appeal;

  select d.severity, d.action, d.rationale, d.report_id into v_dec
    from public.moderation_decisions d where d.reported_user_id = v_uid
   order by d.created_at desc limit 1;
  select public.decrypt_message_body(m.body) into v_reported_text
    from public.content_reports r join public.messages m on m.id = r.message_id
    join public.conversations c on c.id = m.conversation_id and not c.is_encrypted
   where r.id = v_dec.report_id;
  select display_name, username, language into v_prof from public.profiles where id = v_uid;

  v_case := 'Запрос на разблокировку' || E'\n\n'
    || 'Кто: ' || coalesce(public.one_line(v_prof.display_name, 60), '?') || coalesce(' (@' || v_prof.username || ')', '') || E'\n'
    || 'Televo ID: ' || v_uid || E'\n'
    || 'Блокировка до: ' || case when v_mod.banned_until = 'infinity' then 'навсегда'
                                 else to_char(v_mod.banned_until at time zone 'UTC', 'DD.MM.YYYY HH24:MI') || ' UTC' end
    || ', страйков: ' || v_mod.strikes || E'\n'
    || 'Решение ИИ: ' || public.one_line(coalesce(v_dec.severity || ' — ' || v_dec.rationale, coalesce(v_mod.banned_reason, 'нет данных')), 300) || E'\n'
    || 'Сообщение-нарушение: ' || coalesce('«' || public.one_line(v_reported_text, 500) || '»', 'недоступно (удалено или в Секретном чате)') || E'\n\n'
    || 'Объяснение пользователя: «' || public.one_line(p_message, 1000) || '»' || E'\n\n'
    || 'Ответьте на это сообщение «Да», чтобы разблокировать, или «Нет», чтобы оставить блокировку.';

  for v_moderator in select user_id from public.moderators loop
    v_notices := v_notices || public.moderation_say(v_moderator, v_case);
  end loop;
  update public.ban_appeals set notice_message_ids = v_notices where id = v_appeal;

  v_lang := coalesce(v_prof.language, 'en');
  perform public.moderation_say(v_uid, case when v_lang = 'ru'
    then 'Мы получили ваш запрос на разблокировку. Его рассмотрит человек, ответ придёт сюда.'
    else 'We received your unblock request. A person will review it and reply here.' end);
  return v_appeal;
end;
$$;
revoke all on function public.submit_ban_appeal(text) from public, anon;
grant execute on function public.submit_ban_appeal(text) to authenticated;
