-- Group events ("Bek added Ali", "Ali left the group") are stored as
-- messages of their own kind so they appear in the conversation timeline
-- and chat-list preview. Its own migration: Postgres won't let a new enum
-- value be used in the same transaction that adds it (069 uses it).
alter type public.message_kind add value if not exists 'system';
