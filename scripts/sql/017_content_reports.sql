-- App Store Guideline 1.2 (User-Generated Content) requires apps with UGC to
-- provide a mechanism for users to report offensive content and to block
-- abusive users. Blocking already exists (blocked_users); this adds the
-- reporting half, which is the piece Apple most commonly rejects messaging
-- apps for missing.
create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid references auth.users(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  reason text not null,
  -- A snapshot of what was reported. The message row itself may be deleted
  -- (by its sender, or a self-destruct sweep) before the report is reviewed,
  -- so the evidence has to be captured at report time.
  reported_content text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  check (reason in ('spam', 'harassment', 'inappropriate', 'violence', 'other')),
  check (status in ('pending', 'reviewed', 'actioned', 'dismissed'))
);

create index content_reports_status_idx on public.content_reports (status, created_at);

alter table public.content_reports enable row level security;

-- A user can file a report and see their own reports; nobody can read anyone
-- else's (reports must not become a way to discover who reported whom).
create policy "Users can file a report"
on public.content_reports for insert
to authenticated
with check ((select auth.uid()) = reporter_id);

create policy "Users can view their own reports"
on public.content_reports for select
to authenticated
using ((select auth.uid()) = reporter_id);
