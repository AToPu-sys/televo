-- "Blocked" and "deleted account" need to read differently in the UI, per
-- the user's own description (2026-10-03): a deleted account always shows
-- "Deleted Account" with the old history intact; a BLOCKED (not deleted)
-- account should instead show the other person's real name but a last-seen
-- that's frozen at whenever the block happened — "was here a while ago" —
-- rather than either side's live presence, same as Telegram.
--
-- profiles.last_seen_at was previously publicly readable and always live
-- (see useLastSeen.ts's own comment: "this profiles column is otherwise
-- publicly readable like the rest of the profile"), so a block did nothing
-- to it at all — the blocked person's live online/offline status kept
-- flowing to the blocker and vice versa. This gives the client a function
-- that returns the real last_seen_at normally, but caps it at the block's
-- own created_at when a block exists between the caller and the target, in
-- either direction — neither side needs to be ABLE to tell who blocked
-- whom from this value alone, it just freezes in place for both.
create or replace function public.last_seen_for(p_target_user_id uuid)
returns timestamptz
language sql
security definer
set search_path = public
stable
as $$
  select case
    when b.created_at is not null and p.last_seen_at is not null
      then least(p.last_seen_at, b.created_at)
    else p.last_seen_at
  end
  from public.profiles p
  left join public.blocked_users b
    on (b.blocker_id = (select auth.uid()) and b.blocked_id = p_target_user_id)
    or (b.blocker_id = p_target_user_id and b.blocked_id = (select auth.uid()))
  where p.id = p_target_user_id;
$$;

revoke execute on function public.last_seen_for(uuid) from anon, public;
grant execute on function public.last_seen_for(uuid) to authenticated;
