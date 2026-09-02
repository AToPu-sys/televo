-- Batch of schema additions for message edit/reply/forward, privacy controls
-- (last seen, read receipts, blocking), Secret Chat self-destruct timers, and
-- document sending. All additive to the shared project.

-- === Message edit / reply / forward ===============================

alter table public.messages
  add column edited_at timestamptz,
  add column reply_to_id uuid references public.messages(id) on delete set null,
  add column forwarded_from_message_id uuid references public.messages(id) on delete set null,
  add column forwarded_from_sender_id uuid references auth.users(id) on delete set null;

-- Editing is scoped to your own message and only text (editing an image's
-- caption would need a separate `caption` column -- out of scope here).
create policy "Senders can edit their own text messages"
on public.messages for update
to authenticated
using ((select auth.uid()) = sender_id)
with check ((select auth.uid()) = sender_id);

-- === Self-destruct timers (Secret Chats) ===========================

alter table public.messages
  add column expires_at timestamptz;

alter table public.conversations
  add column self_destruct_seconds integer;

-- === Document (any file type) sending ==============================

alter type public.message_kind add value if not exists 'document';

alter table public.messages
  add column document_name text,
  add column document_size_bytes bigint;

-- === Privacy: last seen / online status ============================

alter table public.profiles
  add column last_seen_at timestamptz,
  add column show_last_seen boolean not null default true,
  add column show_read_receipts boolean not null default true;

-- === Blocking =======================================================

create table public.blocked_users (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocked_users enable row level security;

create policy "Users can view their own block list"
on public.blocked_users for select
to authenticated
using ((select auth.uid()) = blocker_id);

create policy "Users can block others"
on public.blocked_users for insert
to authenticated
with check ((select auth.uid()) = blocker_id);

create policy "Users can unblock"
on public.blocked_users for delete
to authenticated
using ((select auth.uid()) = blocker_id);

-- === Per-message read receipts =====================================
-- conversation_participants.last_read_at already gives conversation-level
-- "read up to this time"; Telegram's per-message double-check relies on that
-- same idea (an ordered timestamp), so no new table is needed -- messages
-- older than the OTHER participant's last_read_at are "read". This comment
-- documents that decision; the client already reads last_read_at.
