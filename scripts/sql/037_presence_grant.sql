-- profiles.last_seen_at was never written for ANY real user: every heartbeat
-- silently failed. The cause is a missing table-level SELECT grant for
-- `authenticated` — privileges were issued per column, and `phone` was
-- deliberately left without SELECT to stop the user base being enumerated by
-- phone number. That is the right call, but it makes the table-level grant
-- incomplete, and PostgREST needs SELECT on the target row to complete an
-- UPDATE. The write returned no error to supabase-js (an .update() without
-- .select() does not surface one), so presence appeared to work while
-- last_seen_at stayed null for everyone and nobody ever showed as online.
--
-- Granting SELECT on every column EXCEPT phone keeps the enumeration
-- protection intact (phone stays readable only through the existing
-- find_user / match_contact_phones RPCs, which match rather than list) while
-- letting the heartbeat actually land.
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ')
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'profiles'
     and column_name <> 'phone';

  execute format('grant select (%s) on public.profiles to authenticated', cols);
end;
$$;

-- RLS still decides which ROWS are visible; this only says which COLUMNS the
-- role may read at all. The existing "Users can update their own profile"
-- policy continues to restrict writes to the owner.
