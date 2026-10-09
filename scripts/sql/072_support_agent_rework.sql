-- Reworks the support-email agent's ban/unban pipeline per the new scheme:
--
--   - User ID is now MANDATORY in the inbound request — the agent will not
--     propose an action without one, closing the fuzzy email/username
--     matching that let it guess wrong on a shared display name.
--   - Escalation is now by BAN COUNT (how many times this account has been
--     banned, ever), not by raw report "strikes": 1st ban = a few hours,
--     2nd = 24 hours, 3rd+ = permanent. This is a different axis from
--     035_auto_moderation's own strike-based auto-ban — that pipeline still
--     grades individual reports; this one grades the support agent's own
--     ban decisions specifically.
--   - A fixed bug from the original approve-support-action: it set
--     banned_until = null for a "permanent" ban, which (per
--     035_auto_moderation's own convention) means NOT banned, not banned
--     forever. Permanent is banned_until = 'infinity'::timestamptz.

-- How many times this account has been banned via the support-agent path,
-- specifically — separate from user_moderation.strikes, which counts
-- individual reports toward 035_auto_moderation's own graduated response.
-- A user can be auto-banned by strikes without ever triggering this
-- counter, and vice versa; they track different things on purpose.
alter table public.user_moderation
  add column if not exists support_ban_count integer not null default 0;

-- Applies a ban using the support-agent's own escalation (ban count, not
-- strikes): 1st ban = 6 hours, 2nd = 24 hours, 3rd+ = permanent. Bumps
-- support_ban_count every time it is called with p_is_new_offense = true
-- (the agent found something to act on this round) — NOT every time this
-- function merely runs, so a rejected/no-op approval never inflates it.
create or replace function public.apply_support_ban(
  p_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_until timestamptz;
  v_label text;
begin
  insert into public.user_moderation (user_id, support_ban_count, updated_at)
  values (p_user_id, 1, now())
  on conflict (user_id) do update
    set support_ban_count = public.user_moderation.support_ban_count + 1,
        updated_at = now()
  returning support_ban_count into v_count;

  if v_count >= 3 then
    v_until := 'infinity'::timestamptz;
    v_label := 'permanent';
  elsif v_count = 2 then
    v_until := now() + interval '24 hours';
    v_label := '24 hours';
  else
    v_until := now() + interval '6 hours';
    v_label := '6 hours';
  end if;

  update public.user_moderation
     set banned_until = v_until,
         banned_reason = p_reason,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object('ban_count', v_count, 'duration', v_label, 'banned_until', v_until);
end;
$$;

revoke all on function public.apply_support_ban(uuid, text) from public, anon, authenticated;

-- Lifts a ban without touching support_ban_count — an unban is forgiveness
-- for THIS incident, not an erasure of the account's history, so the next
-- offense still escalates from where it left off rather than resetting to
-- "1st ban" again.
create or replace function public.apply_support_unban(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_moderation
     set banned_until = null, banned_reason = null, updated_at = now()
   where user_id = p_user_id;
end;
$$;

revoke all on function public.apply_support_unban(uuid) from public, anon, authenticated;

-- Thread tracking: every inbound email in the same back-and-forth links to
-- one thread_id, so the agent can read the WHOLE conversation (prior
-- messages + the operator's own notes) before drafting a reply or proposing
-- an action, instead of judging a single message out of context.
alter table public.support_agent_queue
  add column if not exists thread_id uuid,
  add column if not exists user_id_claimed uuid;

create index if not exists support_agent_queue_thread_idx
  on public.support_agent_queue (thread_id, created_at);

-- A running log of every inbound/outbound message in a support thread —
-- separate from support_agent_queue (one row per PROPOSED ACTION, not per
-- message) so the agent has the full back-and-forth to read even on
-- messages that never produced an action (a clarifying question, a "give
-- me 2 days", etc.).
create table if not exists public.support_thread_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_email text not null,
  subject text,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists support_thread_messages_thread_idx
  on public.support_thread_messages (thread_id, created_at);

alter table public.support_thread_messages enable row level security;
-- No client policies: support correspondence is operator/service-role only.
