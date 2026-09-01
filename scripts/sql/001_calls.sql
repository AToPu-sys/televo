-- Call history/state for voice & video calls. Additive to the existing
-- messaging schema; reuses is_conversation_participant() for RLS so calls
-- inherit the same membership rules as messages.
--
-- Live signaling (SDP offer/answer, ICE candidates, ringing) travels over a
-- Realtime broadcast channel per call id, NOT this table -- broadcast is
-- ephemeral and needs no RLS-checked writes for every ICE candidate. This
-- table exists so a call has a durable id, status, and history entry.

create type public.call_kind as enum ('audio', 'video');
create type public.call_status as enum ('ringing', 'active', 'ended', 'missed', 'declined');

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_id uuid not null references auth.users(id) on delete cascade,
  kind public.call_kind not null,
  status public.call_status not null default 'ringing',
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);

create index calls_conversation_id_idx on public.calls (conversation_id);
create index calls_caller_id_idx on public.calls (caller_id);

alter table public.calls enable row level security;

create policy "Participants can view calls in their conversations"
on public.calls for select
to authenticated
using (is_conversation_participant(conversation_id, (select auth.uid())));

create policy "Participants can start a call"
on public.calls for insert
to authenticated
with check (
  (select auth.uid()) = caller_id
  and is_conversation_participant(conversation_id, (select auth.uid()))
);

-- UPDATE needs both USING and WITH CHECK, and only participants may update
-- (e.g. answer/end/decline) a call in their own conversation.
create policy "Participants can update call state"
on public.calls for update
to authenticated
using (is_conversation_participant(conversation_id, (select auth.uid())))
with check (is_conversation_participant(conversation_id, (select auth.uid())));

alter publication supabase_realtime add table public.calls;
