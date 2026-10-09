-- Account deletion used to be a hard `delete from auth.users`, which
-- cascades (profiles_id_fkey, messages_sender_id_fkey, conversation_participants_user_id_fkey
-- are all ON DELETE CASCADE) and erases the deleted user's messages out of
-- every conversation they were ever in — including the OTHER participant's
-- side, on every device. That is not what "delete my account" is supposed
-- to do in a messenger: the other person's conversation history should
-- survive, the way it does in Telegram/WhatsApp ("Deleted Account" with the
-- old messages still there), not vanish retroactively out from under them.
--
-- This replaces it with a soft delete: the auth.users row and all of it
-- (profile, messages, calls) stay in place, but:
--   - auth.users.banned_until is set to 'infinity' — Supabase's own native
--     column, enforced by GoTrue itself, so sign-in and refresh-token use
--     both fail immediately on every device, with no app-level code needed
--     for that part.
--   - profiles' display_name/username/bio/avatar_url/phone/e2e keys are
--     overwritten, so every screen that already reads straight from
--     profiles (chat list, profile screen, message bubbles) shows "Deleted
--     Account" automatically — no client change needed there either.
--   - messages, conversation_participants and calls are left completely
--     alone. The conversation and its history survive.
--
-- A deleted account can never be un-deleted (no stored original data to
-- restore from — the point is irreversibility, same as the old hard
-- delete), which matches what the user asked for.

alter table public.profiles
  add column if not exists is_deleted boolean not null default false;

-- Enforcement for calls, mirroring enforce_ban_on_message's shape
-- (035_auto_moderation.sql) but keyed off auth.users.banned_until directly
-- rather than user_moderation, since a deleted account's ban is permanent
-- and lives on the native column, not the moderation-strikes table.
create or replace function public.enforce_ban_on_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until timestamptz;
begin
  select banned_until into v_until from auth.users where id = new.caller_id;
  if v_until is not null and v_until > now() then
    raise exception 'account suspended or deleted'
      using hint = 'This account can no longer place calls.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_ban_before_call on public.calls;
create trigger enforce_ban_before_call
  before insert on public.calls
  for each row execute function public.enforce_ban_on_call();

-- Same check, folded into the existing message trigger too — it previously
-- only consulted user_moderation.banned_until (moderation strikes), which a
-- soft-deleted account never accumulates. A deleted account must be unable
-- to send messages even though it was never "moderated."
create or replace function public.enforce_ban_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_moderation_until timestamptz;
  v_auth_until timestamptz;
begin
  select banned_until into v_moderation_until
    from public.user_moderation
   where user_id = new.sender_id;

  select banned_until into v_auth_until
    from auth.users
   where id = new.sender_id;

  if (v_moderation_until is not null and v_moderation_until > now())
     or (v_auth_until is not null and v_auth_until > now()) then
    raise exception 'account suspended or deleted'
      using hint = 'This account can no longer send messages.';
  end if;

  return new;
end;
$$;

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid;
  v_placeholder_username text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Deterministic per-account placeholder, not a fixed literal: username has
  -- a uniqueness constraint elsewhere in the schema, and "deleteduser" for
  -- every deleted account would collide on the second deletion.
  v_placeholder_username := 'deleted_' || replace(v_uid::text, '-', '');

  update public.profiles
     set is_deleted = true,
         display_name = 'Deleted Account',
         username = v_placeholder_username,
         bio = null,
         avatar_url = null,
         phone = null,
         e2e_public_key = null,
         e2e_kyber_public_key = null,
         updated_at = now()
   where id = v_uid;

  -- Permanent and irreversible on purpose — see this file's header comment.
  -- Blocks sign-in/refresh immediately via GoTrue's own enforcement, and
  -- (via the two triggers above) new messages and new calls from this
  -- account from this moment on.
  update auth.users
     set banned_until = 'infinity'::timestamptz
   where id = v_uid;
end;
$$;

revoke execute on function public.delete_own_account() from anon, public;
grant execute on function public.delete_own_account() to authenticated;
