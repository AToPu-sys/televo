-- Deleted accounts: GoTrue cannot read banned_until = 'infinity' (Go time
-- scan error), so sign-in and admin user lookups for a deleted account failed
-- with 500 instead of "banned". A far-future date bans just the same.
CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  update public.profiles
     set is_deleted = true,
         display_name = 'Deleted Account',
         username = 'del_' || left(replace(v_uid::text, '-', ''), 20),
         bio = null,
         avatar_url = null,
         phone = null,
         e2e_public_key = null,
         e2e_kyber_public_key = null,
         updated_at = now()
   where id = v_uid;

  update auth.users
     set banned_until = '2999-12-31 00:00:00+00'::timestamptz
   where id = v_uid;

  delete from public.push_tokens where user_id = v_uid;
  delete from public.voip_push_tokens where user_id = v_uid;
  delete from auth.sessions where user_id = v_uid;
end;
$function$;

update auth.users set banned_until = '2999-12-31 00:00:00+00'::timestamptz where banned_until = 'infinity'::timestamptz;
