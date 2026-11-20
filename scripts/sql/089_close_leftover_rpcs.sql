-- 089: functions left over from the fitness app this project grew out of
-- (stats, leaderboards, friends) were executable by anyone, signed in or not,
-- through the default PUBLIC grant, and run as the database owner. The app
-- never calls them. is_moderator(uuid) answered "is this user a moderator?"
-- for any id, to anyone. Only the moderation functions use it, and they run
-- as the owner, so outside callers lose nothing.
revoke execute on function public.get_personal_records(uuid, activity_type) from public, anon, authenticated;
revoke execute on function public.get_profile_stats(uuid) from public, anon, authenticated;
revoke execute on function public.get_segment_leaderboard(uuid) from public, anon, authenticated;
revoke execute on function public.get_training_profile(uuid) from public, anon, authenticated;
revoke execute on function public.match_segment_efforts(uuid) from public, anon, authenticated;
revoke execute on function public.get_friend_count(uuid) from public, anon, authenticated;
revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.is_moderator(uuid) from public, anon, authenticated;
