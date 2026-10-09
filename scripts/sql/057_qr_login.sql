-- QR sign-in: a brand-new device shows a QR code, an ALREADY signed-in
-- device scans it (in-app camera — Televo has no web/desktop client, so
-- this is phone-to-phone, unlike Telegram Web's browser-facing version),
-- and the new device is signed in without typing email/password. Two-Step
-- Verification (TOTP) is NOT bypassed — useAuth.tsx's checkMfaLevel already
-- runs from onAuthStateChange on ANY new session regardless of how it
-- arrived, so a QR-issued session hits the same MFA gate a password sign-in
-- does, with no extra code needed for that part.
--
-- This table exists only to coordinate a short-lived handshake between two
-- devices — it never stores an access/refresh token. The actual session
-- credentials are handed to the new device over a Realtime BROADCAST
-- (ephemeral, never persisted to a table) from the qr-login-exchange Edge
-- Function, specifically so a stolen/queried copy of this row is
-- useless even mid-handshake — request_id alone (what the QR code encodes)
-- authorizes nothing by itself, it just names WHICH pending request a scan
-- is confirming.
create table public.qr_login_requests (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending', 'scanned', 'confirmed', 'expired', 'denied')),
  scanned_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Short TTL: this is a live "let me in" handshake meant to complete in
  -- seconds, not a durable record. 2 minutes matches Telegram's own QR
  -- login window.
  expires_at timestamptz not null default (now() + interval '2 minutes')
);

alter table public.qr_login_requests enable row level security;

-- Every WRITE goes through the SECURITY DEFINER functions below, never a
-- bare client update/insert — those enforce the actual state-machine rules
-- (pending → scanned → confirmed, who's allowed to move it). This IS a
-- permissive SELECT policy, though: Supabase Realtime's postgres_changes
-- still enforces RLS on the underlying row (it does NOT bypass RLS the way
-- an early draft of this comment assumed) — with no SELECT policy at all,
-- the unauthenticated new-device client would receive no change events
-- whatsoever, breaking the whole handshake. A permissive read is safe here
-- specifically because the row never carries anything sensitive (just a
-- status enum, an id, and scanned_by_user_id — no tokens, no email, no PII)
-- and reading it requires already knowing its uuid, same trust boundary as
-- reading the QR code itself.
create policy "Anyone can read a QR login request by id"
on public.qr_login_requests for select
to anon, authenticated
using (true);

-- Called by the NEW (unauthenticated) device to start a QR login. No auth
-- required by design — the device asking for a QR hasn't signed in yet —
-- but the row is otherwise inert: knowing its id lets you SCAN it (trigger
-- confirm_qr_login as some OTHER already-authenticated user), not read
-- anything or claim a session directly.
create or replace function public.create_qr_login_request()
returns uuid
language sql
security definer
set search_path = public
as $$
  insert into public.qr_login_requests default values
  returning id;
$$;

revoke all on function public.create_qr_login_request() from public;
grant execute on function public.create_qr_login_request() to anon, authenticated;

-- Called by the scanning (already signed-in) device right after the camera
-- reads the QR — before showing its own "Sign in on new device?" confirm
-- screen. Marks the request 'scanned' and records WHO scanned it, so the
-- later confirm step can verify the same user is confirming as the one who
-- scanned (a screen can't be trusted to hold that fact client-side across
-- a user tapping "Confirm" moments later).
create or replace function public.mark_qr_login_scanned(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.qr_login_requests
  set status = 'scanned', scanned_by_user_id = auth.uid()
  where id = p_request_id
    and status = 'pending'
    and expires_at > now();

  if not found then
    raise exception 'request not found, already used, or expired';
  end if;
end;
$$;

revoke all on function public.mark_qr_login_scanned(uuid) from public;
grant execute on function public.mark_qr_login_scanned(uuid) to authenticated;

-- Called by the scanning device when the user taps "Confirm" on the
-- in-app prompt. Only flips the row to 'confirmed' — issuing the actual
-- session happens in the qr-login-exchange Edge Function (needs
-- service_role to mint a session for a user other than "self"), which
-- checks this status before acting. Re-checks scanned_by_user_id = auth.uid()
-- so a request scanned by device A can't be confirmed by a different
-- signed-in session B that happens to know the request id.
create or replace function public.confirm_qr_login(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.qr_login_requests
  set status = 'confirmed'
  where id = p_request_id
    and status = 'scanned'
    and scanned_by_user_id = auth.uid()
    and expires_at > now();

  if not found then
    raise exception 'request not found, not scanned by you, or expired';
  end if;
end;
$$;

revoke all on function public.confirm_qr_login(uuid) from public;
grant execute on function public.confirm_qr_login(uuid) to authenticated;

-- Lets the scanning device explicitly reject a scan instead of just
-- ignoring it (e.g. "that's not me, someone else is trying to get in") —
-- flips straight to 'denied' so the waiting new device's Realtime listener
-- gets a definite negative instead of hanging until the 2-minute TTL.
create or replace function public.deny_qr_login(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.qr_login_requests
  set status = 'denied'
  where id = p_request_id
    and scanned_by_user_id = auth.uid()
    and status in ('scanned', 'pending');
end;
$$;

revoke all on function public.deny_qr_login(uuid) from public;
grant execute on function public.deny_qr_login(uuid) to authenticated;

-- The new (still unauthenticated) device subscribes to this row's changes
-- via Realtime to learn when it's been scanned/confirmed/denied. Requires
-- both replica identity FULL (so UPDATE events carry the row's new values,
-- not just its primary key) and adding the table to the supabase_realtime
-- publication (done separately — see the project's realtime publication
-- setup) for postgres_changes to fire on this table at all.
alter table public.qr_login_requests replica identity full;

-- Periodic cleanup of stale rows — mirrors the pattern used for
-- self-destructing messages (032_expire_messages_cron.sql). Keeps the
-- table from growing unbounded from abandoned QR screens.
create or replace function public.expire_old_qr_login_requests()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.qr_login_requests where expires_at < now() - interval '1 hour';
$$;

revoke all on function public.expire_old_qr_login_requests() from public;

select cron.schedule(
  'expire-qr-login-requests',
  '*/15 * * * *',
  $$select public.expire_old_qr_login_requests()$$
);
