-- delete_own_account() (063_soft_delete_account.sql) sets banned_until to
-- block future sign-in/refresh, but an already-issued access token stays
-- valid until it naturally expires (short-lived, but not instant) — the
-- same gap revoke_device_session (055_device_sessions.sql) exists to close
-- for an ordinary single-device sign-out, by deleting the auth.sessions row
-- outright rather than waiting on banned_until. Account deletion should be
-- at least as immediate as that, across every device signed in at once, not
-- slower.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid;
  v_placeholder_username text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_placeholder_username := 'deleted_' || replace(v_uid::text, '-', '');

  update public.profiles
     set is_deleted = true,
         display_name = 'Deleted Account',
         username = v_placeholder_username,
         bio = null,
         avatar_url = null,
         phone = null,
         e2e_public_key = null,
         e2e_kyber_public_key = null,
         updated_at = now()
   where id = v_uid;

  update auth.users
     set banned_until = 'infinity'::timestamptz
   where id = v_uid;

  -- Forces every device signed into this account off immediately, not just
  -- this one — matching revoke_device_session's own approach rather than
  -- relying on banned_until alone, which only stops the NEXT refresh.
  delete from public.push_tokens where user_id = v_uid;
  delete from public.voip_push_tokens where user_id = v_uid;
  delete from auth.sessions where user_id = v_uid;
end;
$$;

revoke execute on function public.delete_own_account() from anon, public;
grant execute on function public.delete_own_account() to authenticated;
