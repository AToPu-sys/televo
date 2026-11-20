-- 093: signing up with a phone number that another account already listed
-- failed the whole signup with "Database error saving new user" (unique
-- index on profiles.phone). Phone numbers are not verified, so this also
-- let anyone lock a real owner out of Televo by listing their number first.
-- A taken number is now simply not saved; the account is created without it.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  desired_username citext;
  final_username citext;
  suffix int := 0;
  requested_phone text;
begin
  desired_username := coalesce(new.raw_user_meta_data ->> 'username', 'athlete');
  final_username := desired_username;
  while exists (select 1 from public.profiles where username = final_username) loop
    suffix := suffix + 1;
    final_username := desired_username || suffix::text;
  end loop;

  requested_phone := nullif(new.raw_user_meta_data ->> 'phone', '');
  if requested_phone is not null and exists (select 1 from public.profiles where phone = requested_phone) then
    requested_phone := null;
  end if;

  insert into public.profiles (id, username, display_name, phone)
  values (new.id, final_username,
          coalesce(new.raw_user_meta_data ->> 'display_name', 'New Athlete'),
          requested_phone);
  return new;
end;
$$;
