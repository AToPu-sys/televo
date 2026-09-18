-- Exact-match lookup of one person by @username or phone number.
--
-- The app had no way to find anyone it had not already messaged: the search
-- box on the contacts tab filtered the locally loaded list, so a new contact
-- was unreachable unless they happened to be in your phone's address book.
--
-- Deliberately EXACT match, not a LIKE/prefix search. A prefix search over
-- profiles is an enumeration primitive: type "a" and receive a slice of the
-- user base. Requiring the full username or full number means a caller must
-- already know who they are looking for, which is the same bar
-- match_contact_phones sets for contact discovery.
--
-- SECURITY DEFINER because phone is not readable by `authenticated` (the
-- column-level grant in 013 deliberately omits it) and because matching on it
-- must not require the caller to be able to read it. The function returns
-- only public profile fields — never the phone itself, so it cannot be used
-- to confirm which number belongs to a user it did not already match.
create or replace function public.find_user(term text)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  bio text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned text;
  digits text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  cleaned := lower(btrim(coalesce(term, '')));
  cleaned := ltrim(cleaned, '@');
  if length(cleaned) < 3 then
    return;
  end if;

  -- Same normalisation the client applies before storing a number
  -- (src/lib/phone.ts): digits only, one leading +. Without this a search
  -- for "+1 415 555 2671" never matches the stored "+14155552671".
  digits := regexp_replace(coalesce(term, ''), '[^0-9]', '', 'g');

  return query
  select p.id, p.username::text, p.display_name, p.avatar_url, p.bio
    from public.profiles p
   where p.id <> auth.uid()
     and (
       lower(p.username::text) = cleaned
       or (length(digits) >= 7 and p.phone = '+' || digits)
     )
   limit 5;
end;
$$;

revoke all on function public.find_user(text) from public;
grant execute on function public.find_user(text) to authenticated;
