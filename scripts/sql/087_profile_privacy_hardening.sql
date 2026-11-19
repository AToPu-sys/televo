-- 087: closes four holes found by attacking the profile and avatar surface.
--
-- 1. Anyone, signed in or not, could list the public avatars bucket and get
--    the user id of everyone who had set a photo (the folder name is the id).
--    A public bucket serves files by URL without any SELECT policy, so read
--    access through the API is now limited to your own folder, which is all
--    an upsert of your own avatar needs.
-- 2. "Last seen" could be read by anyone, whatever the setting: the column was
--    selectable straight from profiles, and last_seen_for() never looked at
--    show_last_seen. The column is no longer readable by clients and the
--    function now applies the setting both ways (Telegram's reciprocal rule).
-- 3. avatar_url took any URL, so pointing it at your own server logged the IP
--    address of everyone who opened your profile or group. It must now be a
--    file in our avatars bucket.
-- 4. A user could set is_deleted themselves; enforce_username_rules skips
--    deleted accounts, so is_deleted=true in the same update unlocked reserved
--    usernames such as "support". Clients can no longer write is_deleted (only
--    delete_own_account(), which runs as the owner, does), and display names
--    that pose as Televo itself are refused.

-- 1 ---------------------------------------------------------------------------
drop policy if exists "Avatar images are publicly readable" on storage.objects;
drop policy if exists "Users can read their own avatar folder" on storage.objects;
create policy "Users can read their own avatar folder"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 2 ---------------------------------------------------------------------------
revoke select (last_seen_at) on public.profiles from anon, authenticated;

create or replace function public.last_seen_for(p_target_user_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when b.created_at is not null and p.last_seen_at is not null
      then least(p.last_seen_at, b.created_at)
    else p.last_seen_at
  end
  from public.profiles p
  join public.profiles viewer on viewer.id = (select auth.uid())
  left join public.blocked_users b
    on (b.blocker_id = (select auth.uid()) and b.blocked_id = p_target_user_id)
    or (b.blocker_id = p_target_user_id and b.blocked_id = (select auth.uid()))
  where p.id = p_target_user_id
    and (p.id = viewer.id or (p.show_last_seen and viewer.show_last_seen));
$$;
revoke all on function public.last_seen_for(uuid) from public, anon;
grant execute on function public.last_seen_for(uuid) to authenticated;

-- 3 ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists avatar_url_is_ours;
alter table public.profiles add constraint avatar_url_is_ours check (
  avatar_url is null
  or avatar_url like 'https://dzoemidyjeeqzifucvpt.supabase.co/storage/v1/object/public/avatars/' || id::text || '/%'
);
alter table public.conversations drop constraint if exists avatar_url_is_ours;
alter table public.conversations add constraint avatar_url_is_ours check (
  avatar_url is null
  or avatar_url like 'https://dzoemidyjeeqzifucvpt.supabase.co/storage/v1/object/public/avatars/%'
);

-- 4 ---------------------------------------------------------------------------
revoke update (is_deleted, created_at) on public.profiles from anon, authenticated;

create or replace function public.display_name_poses_as_televo(p_name text)
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  -- Lower-case, fold Cyrillic look-alikes to Latin, then keep letters only, so
  -- "Televo  Support", "TELEVO_official" and "Тelevо" all reduce the same way.
  select regexp_replace(
           translate(lower(coalesce(p_name, '')), 'аеорсухтвмк', 'aeopcyxtbmk'),
           '[^a-z]', '', 'g'
         ) ~ '^(the)?televo(team|support|official|security|help|admin|staff|bot|app|moderator|moderation|service)?$'
      or regexp_replace(lower(coalesce(p_name, '')), '[^а-яё]', '', 'g')
         ~ '^телево(поддержка|команда|официальный|официально|безопасность|помощь|админ|администрация|бот|модератор|модерация|сервис)?$';
$$;

create or replace function public.enforce_display_name_rules()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.is_deleted or new.username = 'televo_assistant' then
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

drop trigger if exists enforce_display_name_rules on public.profiles;
create trigger enforce_display_name_rules
  before insert or update of display_name on public.profiles
  for each row execute function public.enforce_display_name_rules();

-- The column revoke above is a no-op while a table-wide UPDATE grant exists,
-- so replace that grant with the columns the app actually writes.
revoke update on public.profiles from anon, authenticated;
grant update (avatar_url, bio, default_activity_visibility, display_name,
  e2e_kyber_public_key, e2e_public_key, language, last_seen_at, notify_calls,
  notify_messages, onboarding_completed_at, phone, show_last_seen,
  show_read_receipts, sports, units, username)
  on public.profiles to authenticated;
