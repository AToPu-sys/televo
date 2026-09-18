-- profiles' SELECT grant is an explicit column allowlist
-- (013_lock_down_phone_column.sql), not the default full-table grant — a
-- table-level GRANT SELECT would have covered e2e_kyber_public_key
-- automatically, but this project deliberately doesn't have one so `phone`
-- stays hidden. Any new public column has to be added here explicitly, or
-- selecting it 42501s for every non-owner. This is exactly the mistake this
-- migration exists to avoid: wrapSessionKey's Kyber lookup would fail
-- silently -- profile.e2e_kyber_public_key undefined -- for every profile
-- but the caller's own instead of erroring loudly.
grant select (e2e_kyber_public_key) on public.profiles to authenticated;
