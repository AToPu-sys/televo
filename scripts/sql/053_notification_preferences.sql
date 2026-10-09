-- Lets a user turn off message push notifications and/or call push
-- notifications independently, instead of the current all-or-nothing (the
-- OS-level permission toggle is the only control that exists today).
--
-- Both default true so nobody's notifications silently change on upgrade.
alter table public.profiles
  add column if not exists notify_messages boolean not null default true,
  add column if not exists notify_calls boolean not null default true;

comment on column public.profiles.notify_messages is
  'Whether this user wants a push notification for new messages. Checked by send-push-notification before sending.';
comment on column public.profiles.notify_calls is
  'Whether this user wants a push notification/VoIP push for incoming calls. Checked by send-voip-push before sending.';
