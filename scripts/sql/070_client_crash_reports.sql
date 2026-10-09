-- Crash diagnostics for JavaScript errors.
--
-- 7 of the last 10 crash logs pulled off a test device (2026-09-22 ..
-- 2026-10-03) are the same signature: SIGABRT on
-- com.meta.react.turbomodulemanager.queue, rethrown from
-- ObjCTurboModule::performVoidMethodInvocation. That is
-- RCTExceptionsManager.reportFatalException deliberately aborting a release
-- build after an unhandled JavaScript error — and the .ips file never
-- contains the JS message or stack, so the actual bug was invisible.
--
-- The client now persists a fatal JS error to disk synchronously before the
-- app goes down (src/lib/crashReporter.ts) and uploads it here on the next
-- launch. Insert-only for clients; reading is operator-only (service role).
create table if not exists public.client_crash_reports (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null,
  reported_at timestamptz not null default now(),
  is_fatal boolean not null,
  platform text not null,
  app_version text,
  build_number text,
  message text not null check (char_length(message) <= 2000),
  stack text check (char_length(stack) <= 20000),
  screen text check (char_length(screen) <= 200)
);

create index if not exists client_crash_reports_reported_at_idx
  on public.client_crash_reports (reported_at desc);

alter table public.client_crash_reports enable row level security;

-- A crash can happen before sign-in, so anonymous reports are accepted, but
-- nobody can attribute a report to someone else.
create policy "Clients can file their own crash reports"
  on public.client_crash_reports for insert
  to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));

revoke all on public.client_crash_reports from anon, authenticated;
grant insert (user_id, occurred_at, is_fatal, platform, app_version, build_number, message, stack, screen)
  on public.client_crash_reports to anon, authenticated;
