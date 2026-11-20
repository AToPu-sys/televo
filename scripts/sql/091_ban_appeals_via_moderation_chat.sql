-- 091: unblock requests go to a person, and that person answers in a chat.
--
-- A suspended user taps "Request unblock" and explains why
-- (submit_ban_appeal). Every moderator gets a message from the system
-- account "Televo Moderation" with the case: who, why the AI suspended them,
-- the reported message, strikes, and the user's explanation. The usual push
-- notification fires because it is an ordinary message.
-- The moderator replies "Да"/"Yes" or "Нет"/"No" (as a reply to that message,
-- or plainly when only one request is open). handle_moderation_reply then
-- lifts or keeps the suspension, confirms to the moderator, and tells the
-- user in their own chat with Televo Moderation.

-- System account --------------------------------------------------------------
do $$
begin
  if not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-000000000002') then
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data, aud, role)
    values ('00000000-0000-0000-0000-000000000002', 'moderation@televo.internal',
            crypt(gen_random_uuid()::text, gen_salt('bf')), now(), now(), now(),
            '{"provider":"system","providers":["system"]}', '{}', 'authenticated', 'authenticated');
  end if;
end $$;

-- System accounts (fixed ids ...0001 assistant, ...0002 moderation) may carry
-- reserved names; nobody else can.
create or replace function public.is_system_account(p_id uuid)
returns boolean language sql immutable set search_path to 'public' as $$
  select p_id in ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid);
$$;

create or replace function public.enforce_username_rules()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_problem text;
begin
  if new.is_deleted or public.is_system_account(new.id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.username is not distinct from old.username then
    return new;
  end if;
  v_problem := public.username_problem(new.username);
  if v_problem is not null then
    raise exception 'username_%', v_problem
      using errcode = 'check_violation', hint = 'Choose a different username.';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_display_name_rules()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.is_deleted or public.is_system_account(new.id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.display_name is not distinct from old.display_name then
    return new;
  end if;
  if public.display_name_poses_as_televo(new.display_name) then
    raise exception 'display_name_reserved'
      using errcode = 'check_violation', hint = 'Choose a name that is not Televo''s own.';
  end if;
  return new;
end;
$$;

update public.profiles
   set username = 'televo_moderation', display_name = 'Televo Moderation',
       bio = 'Official Televo moderation. Unblock requests and decisions arrive here.'
 where id = '00000000-0000-0000-0000-000000000002';

-- The profile trigger also gave the system account an assistant chat; drop it.
delete from public.conversations c
 where exists (select 1 from public.conversation_participants p where p.conversation_id = c.id and p.user_id = '00000000-0000-0000-0000-000000000002')
   and exists (select 1 from public.conversation_participants p where p.conversation_id = c.id and p.user_id = '00000000-0000-0000-0000-000000000001');

-- Appeals ----------------------------------------------------------------------
create table if not exists public.ban_appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  notice_message_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null
);
create unique index if not exists ban_appeals_one_pending on public.ban_appeals (user_id) where status = 'pending';
alter table public.ban_appeals enable row level security;
drop policy if exists "Users see their own appeals" on public.ban_appeals;
create policy "Users see their own appeals" on public.ban_appeals
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.ban_appeals from anon, authenticated;
grant select on public.ban_appeals to authenticated;

-- A direct, never-encrypted chat between the moderation account and a user.
create or replace function public.moderation_chat_with(p_user uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_id uuid;
begin
  select c.id into v_id
    from public.conversations c
   where c.kind = 'direct' and not c.is_encrypted
     and exists (select 1 from public.conversation_participants p where p.conversation_id = c.id and p.user_id = '00000000-0000-0000-0000-000000000002')
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

create or replace function public.moderation_say(p_user uuid, p_text text, p_reply_to uuid default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_msg uuid := gen_random_uuid();
begin
  insert into public.messages (id, conversation_id, sender_id, kind, body, reply_to_id)
  values (v_msg, public.moderation_chat_with(p_user), '00000000-0000-0000-0000-000000000002', 'text', p_text, p_reply_to);
  return v_msg;
end;
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
    || 'Кто: ' || coalesce(v_prof.display_name, '?') || coalesce(' (@' || v_prof.username || ')', '') || E'\n'
    || 'Televo ID: ' || v_uid || E'\n'
    || 'Блокировка до: ' || case when v_mod.banned_until = 'infinity' then 'навсегда'
                                 else to_char(v_mod.banned_until at time zone 'UTC', 'DD.MM.YYYY HH24:MI') || ' UTC' end
    || ', страйков: ' || v_mod.strikes || E'\n'
    || 'Решение ИИ: ' || coalesce(v_dec.severity || ' — ' || v_dec.rationale, coalesce(v_mod.banned_reason, 'нет данных')) || E'\n'
    || 'Сообщение-нарушение: ' || coalesce('«' || left(v_reported_text, 500) || '»', 'недоступно (удалено или в Секретном чате)') || E'\n\n'
    || 'Объяснение пользователя: «' || p_message || '»' || E'\n\n'
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
revoke all on function public.moderation_chat_with(uuid) from public, anon, authenticated;
revoke all on function public.moderation_say(uuid, text, uuid) from public, anon, authenticated;

-- Moderator answers ------------------------------------------------------------
create or replace function public.handle_moderation_reply()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_text text;
  v_word text;
  v_approve boolean;
  v_appeal public.ban_appeals%rowtype;
  v_open int;
  v_name text;
  v_lang text;
  v_until timestamptz;
begin
  if new.kind <> 'text' or new.sender_id = '00000000-0000-0000-0000-000000000002'
     or not exists (select 1 from public.moderators where user_id = new.sender_id)
     or not exists (select 1 from public.conversation_participants
                     where conversation_id = new.conversation_id and user_id = '00000000-0000-0000-0000-000000000002')
     or exists (select 1 from public.conversations where id = new.conversation_id and is_encrypted) then
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

  select * into v_appeal from public.ban_appeals
   where status = 'pending' and new.reply_to_id is not null and new.reply_to_id = any(notice_message_ids)
   limit 1;
  if v_appeal.id is null then
    select count(*) into v_open from public.ban_appeals where status = 'pending';
    if v_open = 0 then
      perform public.moderation_say(new.sender_id, 'Открытых запросов нет.', new.id);
      return new;
    elsif v_open > 1 then
      perform public.moderation_say(new.sender_id, 'Открыто несколько запросов. Ответьте прямо на нужное сообщение (свайп влево), чтобы было понятно, о ком речь.', new.id);
      return new;
    end if;
    select * into v_appeal from public.ban_appeals where status = 'pending' limit 1;
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

drop trigger if exists on_message_moderation_reply on public.messages;
create trigger on_message_moderation_reply
  after insert on public.messages
  for each row execute function public.handle_moderation_reply();
