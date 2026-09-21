-- Why a call failed is currently unknowable after the fact.
--
-- useCall keeps a 40-entry in-memory trace ring buffer, wiped at the start
-- of every call and readable only by long-pressing the call overlay while
-- the call is still on screen. The calls table records status/started_at/
-- answered_at/ended_at and nothing else — so a call that connected and
-- carried no audio is indistinguishable from a normal short call, which is
-- exactly the report that took a full day to diagnose by hand.
--
-- The specific question this is built to answer: are calls failing because
-- they are relayed through a saturated free public TURN server? That is the
-- leading hypothesis (see src/lib/webrtc.ts), and one day of real traffic
-- with selected_candidate_pair + using_public_turn recorded settles it
-- either way instead of guessing.
create table public.call_diagnostics (
  id bigint generated always as identity primary key,
  call_id uuid not null references public.calls(id) on delete cascade,
  -- Which side reported this. Both ends of a call write their own row: a
  -- relay can be broken in one direction only, and "the caller saw no media
  -- but the callee did" is itself the diagnosis in that case.
  user_id uuid not null references auth.users(id) on delete cascade,
  reported_at timestamptz not null default now(),

  -- connected | media_timeout | ice_restarted | ice_failed | declined |
  -- hangup. Free text rather than an enum: this is diagnostic data whose
  -- vocabulary will change as the call stack does, and a migration to add
  -- an enum value is a poor trade for that.
  outcome text not null,

  -- 'relay/relay', 'srflx/host', etc. — the local/remote candidate types of
  -- the pair ICE actually selected. This is the single most valuable field
  -- here: 'relay' on either end means the call went through TURN.
  selected_candidate_pair text,
  -- The relay's address when one was used, so a specific bad server can be
  -- identified rather than "TURN" in the abstract.
  turn_server text,
  -- Whether this call ran on the shared free relays (USING_PUBLIC_TURN).
  using_public_turn boolean,

  -- Milliseconds from peer connection to first inbound RTP growth. Null
  -- when media never arrived at all, which is itself the signal.
  ms_to_media integer,
  bytes_received bigint,
  packets_lost integer,
  jitter_ms real,

  -- The in-memory trace for this call, so the per-call narrative survives
  -- the process instead of dying with it.
  trace text
);

create index call_diagnostics_call_id_idx on public.call_diagnostics (call_id);
create index call_diagnostics_reported_at_idx on public.call_diagnostics (reported_at desc);

alter table public.call_diagnostics enable row level security;

-- Insert-only for the reporting user, mirroring the waitlist table's shape:
-- a client may record its own observation of a call it took part in, and
-- nothing else. No UPDATE or DELETE policy at all — a diagnostic record that
-- the client can rewrite afterwards is worth very little.
create policy "Users can report diagnostics for their own calls"
on public.call_diagnostics for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.calls
    where calls.id = call_diagnostics.call_id
      and is_conversation_participant(calls.conversation_id, (select auth.uid()))
  )
);

-- Readable only by the reporter. Deliberately NOT readable by the other
-- participant: these rows carry candidate types and relay addresses, which
-- expose something about the other person's network. Operator analysis runs
-- with the service role, which bypasses RLS.
create policy "Users can read their own call diagnostics"
on public.call_diagnostics for select
to authenticated
using ((select auth.uid()) = user_id);
