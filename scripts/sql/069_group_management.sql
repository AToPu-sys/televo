-- Real group management: admins, adding/removing members, leaving, group
-- photo/description, and timeline events — plus closing permission holes
-- that made all of that unsafe to build on.
--
-- Holes closed (all confirmed against the live policies 2026-10-03):
--   1. conversation_participants UPDATE let a member update ANY column of
--      their own row — including is_admin, so anyone could make themselves
--      a group admin.
--   2. conversation_participants INSERT allowed `auth.uid() = user_id`
--      unconditionally: anyone could add themselves to any conversation
--      whose id they knew. It also let any member add anyone to a group.
--   3. conversations DELETE let any participant delete a whole group for
--      everyone.
--   4. conversations UPDATE let any participant rename a group, and nothing
--      stopped rewriting created_by (which the new rules below trust).
--   5. Nothing stopped a client inserting a kind='system' message, i.e.
--      forging "Bek removed you" events.

alter table public.conversations
  add column if not exists avatar_url text,
  add column if not exists description text;

alter table public.conversations
  drop constraint if exists conversations_description_len;
alter table public.conversations
  add constraint conversations_description_len
  check (description is null or char_length(description) <= 255);

alter table public.messages drop constraint if exists message_has_content;
alter table public.messages add constraint message_has_content check (
  (kind = 'text' and body is not null)
  or (kind in ('image', 'video', 'document', 'voice') and media_url is not null)
  or (kind = 'activity_share' and shared_activity_id is not null)
  or (kind = 'contact_share' and shared_profile_id is not null)
  or (kind = 'system' and body is not null)
);

-- Helpers -----------------------------------------------------------------

create or replace function public.is_group_admin(p_conversation uuid, p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from public.conversation_participants cp
      join public.conversations c on c.id = cp.conversation_id
     where cp.conversation_id = p_conversation
       and cp.user_id = p_user
       and cp.is_admin
       and c.kind = 'group'
  );
$$;

revoke execute on function public.is_group_admin(uuid, uuid) from public, anon;
grant execute on function public.is_group_admin(uuid, uuid) to authenticated;

-- Who may insert a participant row directly (only used by the two creation
-- flows in useContacts.ts; adding to an existing group goes through
-- add_group_members below):
--   - yourself: only as the conversation's creator, into an empty
--     conversation (i.e. while creating it)
--   - someone else into a DM: only the creator, as the second participant
--   - someone else into a group: only a group admin, never as an admin
create or replace function public.can_add_participant(
  p_conversation uuid, p_new_user uuid, p_new_is_admin boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
volatile
as $$
declare
  v_uid uuid := auth.uid();
  v_kind public.conversation_kind;
  v_creator uuid;
  v_count integer;
begin
  if v_uid is null then
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

  if v_kind = 'direct' then
    return v_creator = v_uid and v_count = 1 and not p_new_is_admin
       and public.is_conversation_participant(p_conversation, v_uid);
  end if;

  return public.is_group_admin(p_conversation, v_uid) and not p_new_is_admin;
end;
$$;

revoke execute on function public.can_add_participant(uuid, uuid, boolean) from public, anon;
grant execute on function public.can_add_participant(uuid, uuid, boolean) to authenticated;

create or replace function public.display_name_of(p_user uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select display_name from public.profiles where id = p_user), 'Someone');
$$;

revoke execute on function public.display_name_of(uuid) from public, anon, authenticated;

create or replace function public.post_group_event(
  p_conversation uuid, p_actor uuid, p_event jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.messages (conversation_id, sender_id, kind, body)
  values (
    p_conversation,
    p_actor,
    'system',
    (p_event || jsonb_build_object('actor_name', public.display_name_of(p_actor)))::text
  );
$$;

revoke execute on function public.post_group_event(uuid, uuid, jsonb) from public, anon, authenticated;

-- Policies ----------------------------------------------------------------

drop policy if exists "Participants can add members" on public.conversation_participants;
create policy "Creators and group admins can add members"
  on public.conversation_participants for insert
  to authenticated
  with check (public.can_add_participant(conversation_id, user_id, is_admin));

-- Members may still update their own read position and "deleted for me"
-- marker — and nothing else. Column-level, because a table-level UPDATE
-- grant covers every column regardless of any per-column revoke (the same
-- reason 013_lock_down_phone_column.sql had to do it this way).
revoke update on public.conversation_participants from authenticated, anon;
grant update (last_read_at, deleted_at) on public.conversation_participants to authenticated;

drop policy if exists "Participants can delete their conversation" on public.conversations;
create policy "Creator or DM participant can delete a conversation"
  on public.conversations for delete
  to authenticated
  using (
    created_by = (select auth.uid())
    or (kind = 'direct' and public.is_conversation_participant(id, (select auth.uid())))
  );

create or replace function public.guard_conversation_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.kind is distinct from old.kind
     or new.created_by is distinct from old.created_by then
    raise exception 'conversation_immutable_field' using errcode = 'insufficient_privilege';
  end if;

  if old.kind = 'group'
     and auth.uid() is not null
     and (new.title is distinct from old.title
          or new.avatar_url is distinct from old.avatar_url
          or new.description is distinct from old.description)
     and not public.is_group_admin(old.id, auth.uid()) then
    raise exception 'group_admin_required' using errcode = 'insufficient_privilege';
  end if;

  if old.kind = 'group' and (new.title is null or char_length(btrim(new.title)) = 0
                             or char_length(new.title) > 64) then
    raise exception 'group_title_invalid' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_conversation_update on public.conversations;
create trigger guard_conversation_update
  before update on public.conversations
  for each row execute function public.guard_conversation_update();

create or replace function public.announce_group_info_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.kind = 'group' and auth.uid() is not null then
    if new.title is distinct from old.title then
      perform public.post_group_event(new.id, auth.uid(),
        jsonb_build_object('event', 'title_changed', 'title', new.title));
    end if;
    if new.avatar_url is distinct from old.avatar_url then
      perform public.post_group_event(new.id, auth.uid(),
        jsonb_build_object('event', case when new.avatar_url is null
                                         then 'photo_removed' else 'photo_changed' end));
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists announce_group_info_change on public.conversations;
create trigger announce_group_info_change
  after update on public.conversations
  for each row execute function public.announce_group_info_change();

-- Only server-side code (the SECURITY DEFINER functions here, which run as
-- the table owner) may write system events.
create or replace function public.block_client_system_messages()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'system' and current_user in ('authenticated', 'anon') then
    raise exception 'system_messages_are_server_only' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists block_client_system_messages on public.messages;
create trigger block_client_system_messages
  before insert on public.messages
  for each row execute function public.block_client_system_messages();

-- Group actions -------------------------------------------------------------

create or replace function public.add_group_members(p_conversation uuid, p_user_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_added uuid[];
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_group_admin(p_conversation, v_uid) then
    raise exception 'group_admin_required' using errcode = 'insufficient_privilege';
  end if;

  with inserted as (
    insert into public.conversation_participants (conversation_id, user_id, is_admin)
    select p_conversation, candidate, false
      from unnest(p_user_ids) as candidate
     where candidate <> v_uid
       and exists (select 1 from public.profiles p where p.id = candidate and not p.is_deleted)
       and not public.is_blocked_between(v_uid, candidate)
    on conflict (conversation_id, user_id) do nothing
    returning user_id
  )
  select array_agg(user_id) into v_added from inserted;

  if v_added is null then
    return 0;
  end if;

  perform public.post_group_event(p_conversation, v_uid, jsonb_build_object(
    'event', 'members_added',
    'targets', to_jsonb(v_added),
    'target_names', (select jsonb_agg(public.display_name_of(t)) from unnest(v_added) as t)
  ));
  return array_length(v_added, 1);
end;
$$;

create or replace function public.remove_group_member(p_conversation uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_creator uuid;
  v_target_admin boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_user = v_uid then
    raise exception 'use_leave_group' using errcode = 'check_violation';
  end if;
  if not public.is_group_admin(p_conversation, v_uid) then
    raise exception 'group_admin_required' using errcode = 'insufficient_privilege';
  end if;

  select created_by into v_creator from public.conversations where id = p_conversation;
  select is_admin into v_target_admin
    from public.conversation_participants
   where conversation_id = p_conversation and user_id = p_user;
  if not found then
    raise exception 'not_a_member' using errcode = 'check_violation';
  end if;
  if p_user = v_creator then
    raise exception 'cannot_remove_owner' using errcode = 'insufficient_privilege';
  end if;
  if v_target_admin and v_uid <> v_creator then
    raise exception 'only_owner_can_remove_admins' using errcode = 'insufficient_privilege';
  end if;

  delete from public.conversation_participants
   where conversation_id = p_conversation and user_id = p_user;
  -- They keep whatever they already decrypted on their device, but are not
  -- handed the group key again by anyone's repairMissingSessionKeys.
  delete from public.encrypted_session_keys
   where conversation_id = p_conversation and recipient_id = p_user;

  perform public.post_group_event(p_conversation, v_uid, jsonb_build_object(
    'event', 'member_removed',
    'target', p_user,
    'target_name', public.display_name_of(p_user)
  ));
end;
$$;

create or replace function public.set_group_admin(p_conversation uuid, p_user uuid, p_make_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_creator uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_group_admin(p_conversation, v_uid) then
    raise exception 'group_admin_required' using errcode = 'insufficient_privilege';
  end if;
  select created_by into v_creator from public.conversations where id = p_conversation;
  if not p_make_admin and v_uid <> v_creator then
    raise exception 'only_owner_can_demote' using errcode = 'insufficient_privilege';
  end if;
  if not p_make_admin and p_user = v_creator then
    raise exception 'cannot_demote_owner' using errcode = 'insufficient_privilege';
  end if;

  update public.conversation_participants
     set is_admin = p_make_admin
   where conversation_id = p_conversation and user_id = p_user;
  if not found then
    raise exception 'not_a_member' using errcode = 'check_violation';
  end if;
end;
$$;

create or replace function public.leave_group(p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_kind public.conversation_kind;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  select kind into v_kind from public.conversations where id = p_conversation;
  if v_kind is distinct from 'group' then
    raise exception 'not_a_group' using errcode = 'check_violation';
  end if;

  delete from public.conversation_participants
   where conversation_id = p_conversation and user_id = v_uid;
  if not found then
    raise exception 'not_a_member' using errcode = 'check_violation';
  end if;
  delete from public.encrypted_session_keys
   where conversation_id = p_conversation and recipient_id = v_uid;

  if not exists (select 1 from public.conversation_participants where conversation_id = p_conversation) then
    delete from public.conversations where id = p_conversation;
    return;
  end if;

  perform public.post_group_event(p_conversation, v_uid, jsonb_build_object('event', 'member_left'));

  -- A group must never be left without an admin: hand it to whoever has
  -- been in it longest.
  if not exists (
    select 1 from public.conversation_participants
     where conversation_id = p_conversation and is_admin
  ) then
    update public.conversation_participants
       set is_admin = true
     where conversation_id = p_conversation
       and user_id = (
         select user_id from public.conversation_participants
          where conversation_id = p_conversation
          order by joined_at asc
          limit 1
       );
  end if;
end;
$$;

revoke execute on function public.add_group_members(uuid, uuid[]) from public, anon;
revoke execute on function public.remove_group_member(uuid, uuid) from public, anon;
revoke execute on function public.set_group_admin(uuid, uuid, boolean) from public, anon;
revoke execute on function public.leave_group(uuid) from public, anon;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.set_group_admin(uuid, uuid, boolean) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
