-- Optional phone number on profiles, purely for contact discovery (matching
-- the device's contact list against registered users) -- NOT used for auth.
-- Nullable and unique-if-present so two users can't collide on the same
-- number, but most users can simply leave it blank.
alter table public.profiles
  add column phone text;

create unique index profiles_phone_unique_idx
  on public.profiles (phone)
  where phone is not null;

-- Contact discovery needs to look up profiles by phone number for people NOT
-- already a contact/participant, so the existing "viewable by everyone" SELECT
-- policy on profiles already covers this -- no new policy needed.
