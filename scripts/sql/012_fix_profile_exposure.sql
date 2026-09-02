-- CRITICAL FIX: "Profiles are viewable by everyone" (qual: true) meant any
-- unauthenticated client holding the app's publishable key -- which ships
-- inside the app binary and is trivially extractable -- could dump the
-- entire user table, including the `phone` column added for contact
-- discovery. Verified exploitable against the live project before this fix.
--
-- Two changes:
--   1. Require authentication to read profiles at all (TO authenticated).
--   2. Stop exposing `phone` through the profiles table entirely. Contact
--      discovery no longer pulls every registered phone number down to the
--      client -- see match_contact_phones() below.

drop policy if exists "Profiles are viewable by everyone" on public.profiles;

create policy "Profiles are viewable by signed-in users"
on public.profiles for select
to authenticated
using (true);

-- Revoke direct column access to `phone` so even an authenticated user
-- can't enumerate numbers by selecting the column. Contact matching goes
-- through the SECURITY DEFINER function below instead, which only ever
-- confirms numbers the caller already has in their own address book.
revoke select (phone) on public.profiles from authenticated, anon;

-- pgcrypto provides digest(), used by the matching function below.
create extension if not exists pgcrypto with schema extensions;

-- Contact discovery, done safely: the client sends hashes of the phone
-- numbers already in its address book, and gets back only the profiles that
-- match. It never receives a number it didn't already know, so this can't be
-- used to enumerate the user base (unlike downloading every phone number,
-- which is what the client used to do).
create or replace function public.match_contact_phones(phone_hashes text[])
returns table (id uuid, username text, display_name text, avatar_url text, matched_hash text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id,
         p.username::text,
         p.display_name,
         p.avatar_url,
         encode(extensions.digest(p.phone, 'sha256'), 'hex') as matched_hash
  from public.profiles p
  where p.phone is not null
    and p.id <> (select auth.uid())
    and encode(extensions.digest(p.phone, 'sha256'), 'hex') = any(phone_hashes);
$$;

revoke execute on function public.match_contact_phones(text[]) from anon, public;
grant execute on function public.match_contact_phones(text[]) to authenticated;
