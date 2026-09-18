-- Removes the Expo push notification that fired on every incoming call
-- (020_call_push.sql). That trigger predates CallKit/PushKit: it was the
-- "notification-based approximation" of a real incoming-call screen, back
-- when Expo Go couldn't load native CallKit code at all. Now that CallKit is
-- fully wired up (VoIP push -> reportNewIncomingCall -> the system call
-- screen), this push is a pure duplicate — it showed a second banner/sound
-- alongside CallKit's own full-screen UI, and could arrive AFTER the call was
-- already answered through CallKit, leaving a stale "Incoming call"
-- notification sitting in the tray for a call that was already connected or
-- over.
drop trigger if exists on_call_notify_push on public.calls;
drop function if exists public.notify_incoming_call();
