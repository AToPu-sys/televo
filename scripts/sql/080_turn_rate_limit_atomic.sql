-- 080: fixes to 079's limit.
--  - Atomic: count-then-insert ran unserialised, so 500 parallel requests all
--    saw "under 30" and all got credentials. A per-user advisory lock now
--    serialises the check for that user (other users don't wait).
--  - Each call deleted old rows across the WHOLE table (a scan per request);
--    now only the caller's own old rows, which the (user_id, requested_at)
--    index covers.
--  - refund_turn_credentials: a request that ended in 503 (every provider
--    failed) gives its slot back, so an outage doesn't leave real users
--    rate-limited for an hour after it.
create or replace function public.claim_turn_credentials(p_user_id uuid, p_limit integer default 30)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent integer;
begin
  perform pg_advisory_xact_lock(hashtext('turn:' || p_user_id::text));
  delete from public.turn_credential_requests
   where user_id = p_user_id and requested_at < now() - interval '1 hour';
  select count(*) into recent from public.turn_credential_requests where user_id = p_user_id;
  if recent >= p_limit then
    return false;
  end if;
  insert into public.turn_credential_requests (user_id) values (p_user_id);
  return true;
end;
$$;
revoke all on function public.claim_turn_credentials(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_turn_credentials(uuid, integer) to service_role;

create or replace function public.refund_turn_credentials(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.turn_credential_requests
   where ctid = (select ctid from public.turn_credential_requests
                  where user_id = p_user_id order by requested_at desc limit 1);
$$;
revoke all on function public.refund_turn_credentials(uuid) from public, anon, authenticated;
grant execute on function public.refund_turn_credentials(uuid) to service_role;

-- Rows of users who stopped calling: cleared once a day instead.
select cron.unschedule(jobid) from cron.job where jobname = 'prune-turn-credential-requests';
select cron.schedule('prune-turn-credential-requests', '41 3 * * *',
  $$delete from public.turn_credential_requests where requested_at < now() - interval '1 day'$$);
