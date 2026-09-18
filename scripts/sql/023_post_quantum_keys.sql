-- Adds ML-KEM-768 (FIPS 203, formerly "Kyber768") as a second, independent
-- key exchange layered on top of the existing X25519 one, the same hybrid
-- approach Apple's iMessage PQ3 and Signal's PQXDH use: a session key is now
-- wrapped with a secret derived from BOTH exchanges combined, so recovering
-- it requires breaking X25519 (today's best-understood hard problem) AND
-- ML-KEM (believed hard even for a large quantum computer, which is
-- specifically what breaks plain X25519 via Shor's algorithm). Neither
-- exchange being broken alone is enough.
--
-- Nullable and additive: a profile with no e2e_kyber_public_key yet (an
-- old client build, or before this device's next launch regenerates it)
-- falls back to X25519-only wrapping in application code, so this cannot by
-- itself break any existing conversation.
alter table public.profiles
  add column if not exists e2e_kyber_public_key text;
