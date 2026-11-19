-- QR sign-in: the waiting device sends a one-time X25519 public key with its
-- request, and qr-login-exchange seals the session to it, so whatever is read
-- off the broadcast topic is useless to anyone else. Requests without a key
-- (builds up to 101) keep working as before.

alter table public.qr_login_requests add column if not exists device_public_key text;

drop function if exists public.create_qr_login_request();
create or replace function public.create_qr_login_request(p_device_public_key text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
begin
  if p_device_public_key is not null and p_device_public_key !~ '^[A-Za-z0-9+/]{43}=$' then
    raise exception 'invalid device key';
  end if;
  insert into public.qr_login_requests (device_public_key) values (p_device_public_key) returning id into v_id;
  return v_id;
end;
$function$;
grant execute on function public.create_qr_login_request(text) to anon, authenticated;
