-- Powers a real "Devices" screen: precise last-active time, device MODEL
-- (not just the user-assigned device_name), whether a session is still
-- live, and a genuine remote sign-out (not just muting push).
--
-- push_tokens/voip_push_tokens had no relationship to auth.sessions at all
-- before this — device rows were keyed by (user_id, token), sessions by
-- auth.sessions.id, with no column linking one to the other. session_id
-- closes that gap: the client decodes its own current access token's
-- `session_id` claim and passes it into claim_expo_push_token /
-- claim_voip_push_token, so each device row can be joined back to the
-- session that registered it.
alter table public.push_tokens
  add column if not exists session_id uuid,
  add column if not exists device_model text;

alter table public.voip_push_tokens
  add column if not exists session_id uuid,
  add column if not exists device_model text;

-- New overloads (session_id, device_model added) rather than editing the
-- existing (text, text) signature in place — a client build still in flight
-- on some device mid-rollout will keep calling the old 2-arg signature
-- successfully instead of erroring on an unexpected extra parameter.
create or replace function public.claim_expo_push_token(
  p_token text,
  p_device_name text,
  p_session_id uuid,
  p_device_model text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.push_tokens
   where expo_push_token = p_token and user_id <> auth.uid();

  if p_device_name is not null then
    delete from public.push_tokens
     where user_id = auth.uid()
       and device_name = p_device_name
       and expo_push_token <> p_token;
  end if;

  insert into public.push_tokens
    (user_id, expo_push_token, device_name, session_id, device_model, updated_at)
  values
    (auth.uid(), p_token, p_device_name, p_session_id, p_device_model, now())
  on conflict (user_id, expo_push_token)
  do update set
    device_name = excluded.device_name,
    session_id = excluded.session_id,
    device_model = excluded.device_model,
    updated_at = now();
end;
$$;

create or replace function public.claim_voip_push_token(
  p_token text,
  p_device_name text,
  p_session_id uuid,
  p_device_model text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.voip_push_tokens
   where apns_token = p_token and user_id <> auth.uid();

  insert into public.voip_push_tokens
    (user_id, apns_token, device_name, session_id, device_model, updated_at)
  values
    (auth.uid(), p_token, p_device_name, p_session_id, p_device_model, now())
  on conflict (user_id, apns_token)
  do update set
    device_name = excluded.device_name,
    session_id = excluded.session_id,
    device_model = excluded.device_model,
    updated_at = now();
end;
$$;

revoke all on function public.claim_expo_push_token(text, text, uuid, text) from public;
revoke all on function public.claim_voip_push_token(text, text, uuid, text) from public;
grant execute on function public.claim_expo_push_token(text, text, uuid, text) to authenticated;
grant execute on function public.claim_voip_push_token(text, text, uuid, text) to authenticated;

-- One row per distinct device the caller is signed in on, joined to
-- auth.sessions to report whether that session is still live and its real
-- last-activity timestamp (auth.sessions.updated_at moves on token refresh,
-- which is a far more accurate "last active" than push_tokens.updated_at —
-- that only moves when the token is RE-REGISTERED, e.g. app reinstall, not
-- on ordinary use). SECURITY DEFINER because auth.sessions isn't reachable
-- through PostgREST/RLS to a plain authenticated role at all; this function
-- only ever exposes the CALLER's own sessions (auth.uid() = s.user_id).
create or replace function public.list_my_devices()
returns table (
  session_id uuid,
  device_name text,
  device_model text,
  is_active boolean,
  last_active_at timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    coalesce(p.session_id, v.session_id) as session_id,
    coalesce(p.device_name, v.device_name) as device_name,
    coalesce(p.device_model, v.device_model) as device_model,
    (s.id is not null) as is_active,
    coalesce(s.updated_at, p.updated_at, v.updated_at) as last_active_at,
    coalesce(p.created_at, v.created_at) as created_at
  from public.push_tokens p
  full outer join public.voip_push_tokens v
    on v.user_id = p.user_id and v.session_id = p.session_id
  left join auth.sessions s
    on s.id = coalesce(p.session_id, v.session_id)
  where coalesce(p.user_id, v.user_id) = auth.uid()
    and coalesce(p.session_id, v.session_id) is not null
  order by last_active_at desc nulls last;
$$;

revoke all on function public.list_my_devices() from public;
grant execute on function public.list_my_devices() to authenticated;

-- Deletes the target session row (auth.sessions), which invalidates that
-- session's refresh token — the NEXT time the other device tries to refresh
-- its access token, GoTrue rejects it and the client's own onAuthStateChange
-- fires SIGNED_OUT there. This is a real remote sign-out, not just muting
-- push. SECURITY DEFINER + explicit ownership check: without the ownership
-- check, any authenticated user could pass an arbitrary session_id and end
-- a stranger's session. Also prunes the matching push_tokens/voip_push_tokens
-- rows so the device disappears from the list immediately rather than
-- lingering as "inactive" until its own cleanup runs.
create or replace function public.revoke_device_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1 from auth.sessions where id = p_session_id and user_id = auth.uid()
  ) then
    raise exception 'not your session';
  end if;

  delete from auth.sessions where id = p_session_id;
  delete from public.push_tokens where session_id = p_session_id and user_id = auth.uid();
  delete from public.voip_push_tokens where session_id = p_session_id and user_id = auth.uid();
end;
$$;

revoke all on function public.revoke_device_session(uuid) from public;
grant execute on function public.revoke_device_session(uuid) to authenticated;

-- For a device row whose session is ALREADY gone (list_my_devices'
-- is_active = false — token refresh already failed there, or it was
-- ended from elsewhere): nothing left in auth.sessions to delete, so
-- revoke_device_session's ownership check ("not your session") would just
-- error. This is the plain "remove it from my list" version — a normal
-- client-owned delete would already cover it under RLS, but a stale
-- session_id no longer belongs to any live auth.sessions row for anyone,
-- so there is nothing meaningful left to authorize beyond user_id, same as
-- the original Remove button before this migration.
create or replace function public.forget_device(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.push_tokens where session_id = p_session_id and user_id = auth.uid();
  delete from public.voip_push_tokens where session_id = p_session_id and user_id = auth.uid();
end;
$$;

revoke all on function public.forget_device(uuid) from public;
grant execute on function public.forget_device(uuid) to authenticated;
