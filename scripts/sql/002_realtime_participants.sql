-- conversation_participants was not in the supabase_realtime publication, so
-- no postgres_changes subscription could ever fire on it -- not an RLS or
-- client bug, the table simply never emitted logical-replication events.
-- This is what makes read-state (last_read_at) changes on one device propagate
-- live to another device signed into the same account.
alter publication supabase_realtime add table public.conversation_participants;
