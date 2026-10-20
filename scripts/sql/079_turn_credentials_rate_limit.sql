-- 079: turn-credentials handed out fresh Metered/Cloudflare credentials (and
-- the static ExpressTURN login) on every call, to any signed-in account, with
-- no limit: a script on a free account could drain the providers' quotas and
-- use the relays as a free proxy. The app caches credentials for 12 h and
-- asks a few times a day, so 30 per user per hour leaves real use untouched.
create table if not exists public.turn_credential_requests (
  user_id uuid not null references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now()
);
create index if not exists turn_credential_requests_user_time_idx
  on public.turn_credential_requests (user_id, requested_at desc);
alter table public.turn_credential_requests enable row level security;
revoke all on public.turn_credential_requests from anon, authenticated;

-- Records the request and says whether it is within the limit. Called by the
-- turn-credentials function with the service role only.
create or replace function public.claim_turn_credentials(p_user_id uuid, p_limit integer default 30)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent integer;
begin
  delete from public.turn_credential_requests where requested_at < now() - interval '1 day';
  select count(*) into recent
    from public.turn_credential_requests
   where user_id = p_user_id and requested_at > now() - interval '1 hour';
  if recent >= p_limit then
    return false;
  end if;
  insert into public.turn_credential_requests (user_id) values (p_user_id);
  return true;
end;
$$;
revoke all on function public.claim_turn_credentials(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_turn_credentials(uuid, integer) to service_role;
