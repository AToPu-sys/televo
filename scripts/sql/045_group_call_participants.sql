-- Structural groundwork for group calls (mesh or SFU — this table doesn't
-- commit to either). 001_calls.sql models a call as exactly one caller plus
-- "whoever else is in the conversation", which works for a 1:1 call (there's
-- only one other participant, so it's unambiguous) but has no way to
-- represent "who has actually joined THIS group call" — a group chat can
-- have 8 members while only 3 are actually on the call. Nothing in the app
-- reads or writes this table yet; it exists so the signaling/UI work planned
-- next has a durable join/leave record to build on, instead of starting from
-- nothing.
create table public.call_participants (
  call_id uuid not null references public.calls(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  -- null while on the call; set once this participant leaves (hangs up,
  -- drops, or is disconnected) — kept as a row rather than deleted so a
  -- call's full join/leave history is reconstructable afterward, the same
  -- reason calls.ended_at is set rather than the row being removed.
  left_at timestamptz,
  primary key (call_id, user_id)
);

create index call_participants_call_id_idx on public.call_participants (call_id);
create index call_participants_user_id_idx on public.call_participants (user_id);

alter table public.call_participants enable row level security;

-- Same membership rule as 001_calls.sql's own policies: only participants of
-- the underlying conversation may see or touch a call's participant list.
create policy "Conversation participants can view call participants"
on public.call_participants for select
to authenticated
using (
  exists (
    select 1 from public.calls
    where calls.id = call_participants.call_id
      and is_conversation_participant(calls.conversation_id, (select auth.uid()))
  )
);

-- A user may only insert/update THEIR OWN join row — joining a call on
-- someone else's behalf is not a legitimate action, and the with check
-- clause on update makes leaving (setting left_at) the only permitted change.
create policy "Users can join a call they're a participant of"
on public.call_participants for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.calls
    where calls.id = call_participants.call_id
      and is_conversation_participant(calls.conversation_id, (select auth.uid()))
  )
);

create policy "Users can update their own join row"
on public.call_participants for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

alter publication supabase_realtime add table public.call_participants;
