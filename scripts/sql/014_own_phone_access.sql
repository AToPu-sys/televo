-- 013 locked down profiles.phone by dropping the table-level SELECT grant,
-- which correctly stopped phone-number enumeration but also cut off the one
-- legitimate read: Settings showing you YOUR OWN number.
--
-- These two functions restore exactly that, and nothing more: they are
-- hard-scoped to auth.uid(), so they can never return or modify anyone
-- else's number.
create or replace function public.get_my_phone()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select phone from public.profiles where id = (select auth.uid());
$$;

create or replace function public.set_my_phone(new_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Mirrors the client-side format check so a bad value can't slip in via a
  -- direct RPC call, and keeps the unique-if-present index meaningful.
  if new_phone is not null and new_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Phone must be in international format, e.g. +14155552671';
  end if;

  update public.profiles
  set phone = new_phone
  where id = (select auth.uid());
end;
$$;

revoke execute on function public.get_my_phone() from anon, public;
grant execute on function public.get_my_phone() to authenticated;

revoke execute on function public.set_my_phone(text) from anon, public;
grant execute on function public.set_my_phone(text) to authenticated;
