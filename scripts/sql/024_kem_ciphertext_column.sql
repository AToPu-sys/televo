-- Carries the ML-KEM-768 encapsulation ciphertext alongside each wrapped
-- session key (see 023_post_quantum_keys.sql for why). Nullable: a row
-- wrapped X25519-only (recipient had no Kyber key yet at wrap time) simply
-- has no KEM ciphertext, and unwrapSessionKey falls back accordingly.
alter table public.encrypted_session_keys
  add column if not exists kem_ciphertext text;
