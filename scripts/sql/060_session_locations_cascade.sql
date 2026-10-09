-- session_locations (056) was keyed by session_id with no foreign key, so a
-- row outlived its session — including after account deletion, which the
-- privacy policy says erases device records. Tie each row to its
-- auth.sessions row so signing a device out or deleting the account (which
-- cascades to auth.sessions) removes its city/country too.
delete from public.session_locations sl
 where not exists (select 1 from auth.sessions s where s.id = sl.session_id);

alter table public.session_locations
  add constraint session_locations_session_id_fkey
  foreign key (session_id) references auth.sessions(id) on delete cascade;
