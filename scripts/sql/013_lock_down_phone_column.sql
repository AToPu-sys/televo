-- 012 tried to protect profiles.phone with a column-level REVOKE, which
-- silently did nothing: `authenticated` holds a TABLE-level SELECT grant on
-- profiles, and a table-level grant covers every column regardless of any
-- column-level revoke. Verified still leaking after 012.
--
-- The only way to restrict a column in Postgres is to drop the table-level
-- grant and re-grant the specific columns that are safe to expose.
revoke select on public.profiles from authenticated, anon;

grant select (
  id,
  username,
  display_name,
  bio,
  avatar_url,
  units,
  onboarding_completed_at,
  created_at,
  updated_at,
  sports,
  default_activity_visibility,
  language,
  e2e_public_key,
  last_seen_at,
  show_last_seen,
  show_read_receipts
) on public.profiles to authenticated;

-- `phone` is deliberately absent above. It is reachable only through
-- match_contact_phones() (see 012), which returns a match for a number the
-- caller already had in their own address book and never reveals a number
-- the caller didn't already know.
