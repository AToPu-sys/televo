-- Queue for the support-email agent (supabase/functions/support-email-agent).
--
-- Design: the agent NEVER applies a ban/unban itself. It reads the inbound
-- email (via a Resend inbound webhook), decides what the sender is asking
-- for, drafts a reply and a proposed action, and writes ONE ROW here. A
-- separate approve-support-action Edge Function applies the action only
-- when the operator clicks the approve link in their own inbox — the model
-- never gets write access to user_moderation, only read access to look up
-- who it's talking about.
--
-- Why a queue table rather than "just email the operator and wait for a
-- reply": an email reply has no reliable machine-readable signal Supabase
-- can act on. A one-click link with a signed token does.
create table public.support_agent_queue (
  id uuid primary key default gen_random_uuid(),

  -- The raw inbound message, kept for audit — this is the only place a
  -- support request's content is retained past the initial handling.
  from_email text not null,
  subject text,
  body text not null,
  received_at timestamptz not null default now(),

  -- What the agent decided the sender is asking for. Free text rather than
  -- an enum for the same reason call_diagnostics.outcome is free text: the
  -- vocabulary of "what people ask a messenger's support inbox" will keep
  -- changing, and a migration to add a value is a poor trade against that.
  intent text not null,

  -- The user the request is ABOUT, if the agent could identify one — by
  -- email match against auth.users, or by @username / display name
  -- mentioned in the body. Null when the agent could not confidently
  -- identify anyone (e.g. a general question, or an ambiguous name).
  target_user_id uuid references auth.users(id) on delete set null,
  target_user_display_name text,

  -- The agent's proposed action, in plain language for the approval email
  -- — e.g. "ban for 7 days", "lift the ban", "no action needed". NEVER
  -- executed by this table alone; approve-support-action reads this same
  -- row and re-derives the actual ban/unban call from `intent` +
  -- `target_user_id`, never from a free-text field, so the row itself
  -- cannot be tampered into an arbitrary action.
  proposed_action text not null,
  proposed_reply text not null,

  -- One-time token embedded in the approve/reject links sent to the
  -- operator's own inbox. Long and random rather than the row's own id, so
  -- the links in a forwarded or leaked email cannot be guessed from the
  -- (sequential-looking) queue.
  approval_token text not null default encode(gen_random_bytes(24), 'base64url'),

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,

  created_at timestamptz not null default now()
);

alter table public.support_agent_queue enable row level security;
-- No client policies at all — this table is operator/service-role only.
-- Nothing here is meant to be readable by the app's own users, including
-- the person the request is about.

create index support_agent_queue_status_idx
  on public.support_agent_queue (status, created_at desc);
create unique index support_agent_queue_token_idx
  on public.support_agent_queue (approval_token);
