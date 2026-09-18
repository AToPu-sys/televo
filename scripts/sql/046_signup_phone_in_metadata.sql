-- Fixes a signup bug where the phone number typed on the sign-up form was
-- silently discarded for essentially every account.
--
-- signUpWithEmail (src/hooks/useAuth.tsx) used to save the phone with a
-- follow-up `profiles.update(...).eq('id', data.user.id)` AFTER supabase.auth
-- .signUp() returned — but that update only ran `if (profile.phone &&
-- data.session && data.user)`. With email confirmation on (auth.email
-- .enable_confirmations = true in supabase/config.toml, which is how this
-- project is actually configured), signUp() returns a user but NO session —
-- the session doesn't exist until the confirmation link is opened, by which
-- time signUpWithEmail has already returned and nothing ever revisits the
-- phone. `data.session` was false for every real signup, so the condition
-- never ran, and the RLS-gated update would have failed anyway even if it
-- had (no session ⇒ auth.uid() is null ⇒ "Users can update their own
-- profile" policy's `auth.uid() = id` check can't pass). A query against the
-- live profiles table during this audit showed exactly that: every recent
-- signup has phone = null except one account created before this bug was
-- introduced. Since phone is required at signup for contact discovery
-- (useContactDiscovery hashes profiles.phone to match a friend's address
-- book), this silently broke "friends find you by phone" for the entire
-- userbase going forward.
--
-- The fix moves phone-saving into handle_new_user() itself, the same way
-- username/display_name already work: the client puts it in
-- raw_user_meta_data at signUp() time (see the paired useAuth.tsx change),
-- and the trigger — which runs server-side in the SAME transaction as the
-- auth.users insert, as SECURITY DEFINER, before any session or RLS check
-- is even relevant — sets it directly. This can never race a missing
-- session because it never depends on one.
--
-- A duplicate phone (unique index profiles_phone_unique_idx) would previously
-- have surfaced as a raw constraint violation on the client's follow-up
-- update, AFTER auth.users and profiles rows already existed — a half-created
-- account stuck with no phone and a confusing error. Now a duplicate phone
-- fails INSIDE the same transaction as the auth.users row, so Postgres rolls
-- the whole signup back and supabase.auth.signUp() itself returns the error —
-- sign-in.tsx's existing "that phone number is already used by another
-- account" translation (it matches on lowered.includes("phone") &&
-- lowered.includes("duplicate")) already handles that error shape, so no
-- client-side error-handling change is needed for that case.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired_username citext;
  final_username citext;
  suffix int := 0;
  requested_phone text;
begin
  desired_username := coalesce(new.raw_user_meta_data ->> 'username', 'athlete');
  final_username := desired_username;

  -- Guard against a race on username uniqueness (e.g. two signups with the
  -- same requested username landing at nearly the same time); the client
  -- already checks availability, this is the DB-level backstop.
  while exists (select 1 from public.profiles where username = final_username) loop
    suffix := suffix + 1;
    final_username := desired_username || suffix::text;
  end loop;

  -- Empty string ⇒ null, same as normalizePhone's own "no digits" case —
  -- an empty phone column should read as "not set", not as a value that
  -- could collide with some other empty string under the unique index.
  requested_phone := nullif(new.raw_user_meta_data ->> 'phone', '');

  insert into public.profiles (id, username, display_name, phone)
  values (
    new.id,
    final_username,
    coalesce(new.raw_user_meta_data ->> 'display_name', 'New Athlete'),
    requested_phone
  );

  return new;
end;
$$;
