-- A push token identifies a DEVICE, not an account, but nothing enforced
-- that: signing in as a second user on the same phone left the first user's
-- row in place, so the server fanned every notification out to both. In
-- practice that meant VoIP pushes for account A waking a phone now signed in
-- as account B (and ringing for a call that isn't theirs), while the account
-- actually being called had no usable row at all.
--
-- Cleanup can't be done client-side alone: a client may only delete its OWN
-- rows under RLS, and the stale row belongs to a different user_id. These
-- SECURITY DEFINER functions claim a token for the calling user and drop
-- every other holder of it, atomically.

create or replace function public.claim_voip_push_token(
  p_token text,
  p_device_name text default null
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

  insert into public.voip_push_tokens (user_id, apns_token, device_name, updated_at)
  values (auth.uid(), p_token, p_device_name, now())
  on conflict (user_id, apns_token)
  do update set device_name = excluded.device_name, updated_at = now();
end;
$$;

create or replace function public.claim_expo_push_token(
  p_token text,
  p_device_name text default null
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

  -- Same token on another account: that account no longer has this device.
  delete from public.push_tokens
   where expo_push_token = p_token and user_id <> auth.uid();

  -- Older tokens this same device issued (e.g. an Expo Go install before the
  -- real build) — they still deliver, to the wrong app.
  if p_device_name is not null then
    delete from public.push_tokens
     where user_id = auth.uid()
       and device_name = p_device_name
       and expo_push_token <> p_token;
  end if;

  insert into public.push_tokens (user_id, expo_push_token, device_name, updated_at)
  values (auth.uid(), p_token, p_device_name, now())
  on conflict (user_id, expo_push_token)
  do update set device_name = excluded.device_name, updated_at = now();
end;
$$;

revoke all on function public.claim_voip_push_token(text, text) from public;
revoke all on function public.claim_expo_push_token(text, text) from public;
grant execute on function public.claim_voip_push_token(text, text) to authenticated;
grant execute on function public.claim_expo_push_token(text, text) to authenticated;
