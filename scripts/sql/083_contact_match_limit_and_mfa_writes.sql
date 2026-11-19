-- 1. Contact discovery: SHA-256 of a phone number is cheap to brute-force, so
--    an unlimited match_contact_phones let one account check whole number
--    ranges and map them to usernames. Cap each call and each day per user.
-- 2. Two-step verification guarded only reading messages: a session that
--    passed password + email code but not TOTP could still send messages,
--    place calls and change conversations as the user. Writes now need the
--    same step-up (session_meets_mfa_requirement is true for accounts
--    without TOTP, so nobody else is affected).

create table if not exists public.contact_match_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  hash_count integer not null
);
create index if not exists contact_match_requests_user_time on public.contact_match_requests (user_id, requested_at);
alter table public.contact_match_requests enable row level security;

create or replace function public.match_contact_phones(phone_hashes text[])
returns table(id uuid, username text, display_name text, avatar_url text, matched_hash text)
language plpgsql
volatile
security definer
set search_path = public
as $function$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_count integer := coalesce(cardinality(phone_hashes), 0);
  v_calls integer;
  v_hashes integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if v_count = 0 then
    return;
  end if;
  if v_count > 10000 then
    raise exception 'too many contacts in one request';
  end if;
  perform pg_advisory_xact_lock(hashtext('contact-match:' || v_uid::text));
  delete from public.contact_match_requests r
   where r.user_id = v_uid and r.requested_at < now() - interval '1 day';
  select count(*), coalesce(sum(r.hash_count), 0) into v_calls, v_hashes
    from public.contact_match_requests r
   where r.user_id = v_uid;
  if v_calls >= 5 or v_hashes + v_count > 10000 then
    raise exception 'contact matching limit reached, try again tomorrow';
  end if;
  insert into public.contact_match_requests (user_id, hash_count) values (v_uid, v_count);
  return query
    select p.id, p.username::text, p.display_name, p.avatar_url,
           encode(extensions.digest(p.phone, 'sha256'), 'hex')
      from public.profiles p
     where p.phone is not null
       and p.id <> v_uid
       and encode(extensions.digest(p.phone, 'sha256'), 'hex') = any(phone_hashes);
end;
$function$;
revoke execute on function public.match_contact_phones(text[]) from public, anon;
grant execute on function public.match_contact_phones(text[]) to authenticated;

do $$
declare
  t text;
  op text;
  spec record;
begin
  for spec in
    select * from (values
      ('messages', 'insert'), ('messages', 'update'), ('messages', 'delete'),
      ('calls', 'insert'), ('calls', 'update'),
      ('call_participants', 'insert'),
      ('conversations', 'insert'), ('conversations', 'update'),
      ('conversation_participants', 'insert'),
      ('encrypted_session_keys', 'insert'), ('encrypted_session_keys', 'update')
    ) as v(tbl, cmd)
  loop
    t := spec.tbl; op := spec.cmd;
    execute format('drop policy if exists %I on public.%I', 'mfa_step_up_' || op, t);
    if op = 'insert' then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.session_meets_mfa_requirement())', 'mfa_step_up_' || op, t);
    elsif op = 'update' then
      execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.session_meets_mfa_requirement()) with check (public.session_meets_mfa_requirement())', 'mfa_step_up_' || op, t);
    else
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.session_meets_mfa_requirement())', 'mfa_step_up_' || op, t);
    end if;
  end loop;
end $$;

drop policy if exists mfa_step_up_chat_media_upload on storage.objects;
create policy mfa_step_up_chat_media_upload on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'chat-media' or public.session_meets_mfa_requirement());
