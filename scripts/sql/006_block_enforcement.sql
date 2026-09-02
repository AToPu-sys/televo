-- Blocking must be enforced server-side (RLS), not just hidden client-side,
-- or a blocked user could still send messages via direct API calls.
--
-- Approach: a SECURITY DEFINER helper function that checks blocked_users in
-- both directions (either party blocked the other), used inside the existing
-- messages INSERT policy. SECURITY DEFINER is required here because a
-- regular (SECURITY INVOKER) function run as the blocked sender would need
-- read access to the blocker's blocked_users row to see the block -- which
-- the blocker's own RLS on that table (blocker_id = auth.uid()) correctly
-- prevents. The function is kept minimal, in a still-public but
-- non-data-returning shape, and does nothing but this boolean check.
create or replace function public.is_blocked_between(user_a uuid, user_b uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.blocked_users
    where (blocker_id = user_a and blocked_id = user_b)
       or (blocker_id = user_b and blocked_id = user_a)
  );
$$;

-- Postgres grants EXECUTE to PUBLIC by default on every new function, which
-- would make this callable directly as a public RPC endpoint
-- (/rest/v1/rpc/is_blocked_between) by anon and authenticated alike. It's
-- meant to be used only from inside the messages INSERT policy, so revoke
-- the default grants and only allow authenticated (the only role whose
-- inserts trigger the policy in the first place).
revoke execute on function public.is_blocked_between(uuid, uuid) from anon;
revoke execute on function public.is_blocked_between(uuid, uuid) from public;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated;

-- Replace the existing "Participants can send messages" policy with one that
-- additionally checks neither party has blocked the other, for direct chats.
-- (Group messages aren't blocked by a single relationship, matching
-- Telegram's own behavior -- blocking only affects direct interaction.)
drop policy if exists "Participants can send messages" on public.messages;

create policy "Participants can send messages"
on public.messages for insert
to authenticated
with check (
  is_conversation_participant(conversation_id, (select auth.uid()))
  and (select auth.uid()) = sender_id
  and not exists (
    select 1 from public.conversations c
    join public.conversation_participants other
      on other.conversation_id = c.id and other.user_id <> (select auth.uid())
    where c.id = messages.conversation_id
      and c.kind = 'direct'
      and public.is_blocked_between((select auth.uid()), other.user_id)
  )
);
