-- Tracks whether each waitlist signup has already received the "we're live
-- on the App Store" announcement, so the launch broadcast (send-launch-email)
-- can run more than once safely — once over the App Review wait, again if a
-- send batch fails partway, etc. — without re-emailing anyone it already
-- reached. NULL means never sent.
alter table public.waitlist
  add column launch_notified_at timestamptz;
