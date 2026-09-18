-- 027 created SELECT/INSERT/DELETE policies but no UPDATE one, so the
-- client's upsert failed with "new row violates row-level security policy
-- (USING expression)" on every launch AFTER the first: the token row already
-- exists, ON CONFLICT turns the insert into an UPDATE, and an UPDATE with no
-- policy is rejected outright.
--
-- Practically this meant re-registration could never refresh an existing
-- row — and a device whose APNs token rotated would keep a stale row, so
-- its calls would silently stop ringing.
create policy "Users can refresh their own VoIP push token"
on public.voip_push_tokens for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
