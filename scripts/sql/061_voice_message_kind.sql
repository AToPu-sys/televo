-- Voice messages, step 1 of 2. A new enum value must be committed before any
-- statement can use it (Postgres "unsafe use of new value"), so the constraint
-- and function changes that reference 'voice' live in 062, run separately.
alter type public.message_kind add value if not exists 'voice';
