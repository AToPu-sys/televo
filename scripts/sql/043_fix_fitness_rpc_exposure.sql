-- These SECURITY DEFINER RPCs belong to a fitness-app schema that ships in
-- this same Supabase project but isn't used by Televo's own code (no call
-- site in src/ or app/) — still, they were live, granted to anon, and had NO
-- internal auth.uid()/ownership check at all. SECURITY DEFINER bypasses the
-- correctly-scoped RLS on activities/goals, so anyone holding only the
-- public anon key could pull any user's private activity streak or goal
-- progress with zero authentication. Fixing regardless of which app uses
-- this schema, since it's live on infrastructure this project's anon key
-- exposes.

create or replace function public.get_activity_streak(profile_id uuid)
returns integer
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare
  active_days date[];
  streak integer := 0;
  cursor_date date := current_date;
begin
  -- Same visibility rule as the app's own (already-correct) functions like
  -- get_profile_stats: your own data, or something the owner made public,
  -- or a friend's if they scoped it to friends.
  if not (
    profile_id = auth.uid()
    or exists (
      select 1 from public.activities a
      where a.user_id = profile_id
        and (a.visibility = 'public'
             or (a.visibility = 'friends' and public.are_friends(auth.uid(), profile_id)))
    )
  ) then
    return 0;
  end if;

  select array_agg(distinct started_at::date order by started_at::date desc)
  into active_days
  from public.activities
  where user_id = profile_id;

  if active_days is null then
    return 0;
  end if;

  if not (cursor_date = any(active_days)) then
    cursor_date := cursor_date - 1;
  end if;

  while cursor_date = any(active_days) loop
    streak := streak + 1;
    cursor_date := cursor_date - 1;
  end loop;

  return streak;
end;
$$;

create or replace function public.get_goal_progress(goal_id_input uuid)
returns table (progress numeric, period_start timestamptz, period_end timestamptz)
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare
  g public.goals;
  p_start timestamptz;
  p_end timestamptz;
begin
  select * into g from public.goals where id = goal_id_input;
  -- Goals are private to their owner in this schema (mirrors "Users can
  -- view their own goals"), so anyone else gets nothing rather than the
  -- owner's real numeric progress.
  if not found or g.user_id <> auth.uid() then
    return;
  end if;

  if g.period = 'weekly' then
    p_start := date_trunc('week', now());
    p_end := p_start + interval '7 days';
  else
    p_start := date_trunc('month', now());
    p_end := p_start + interval '1 month';
  end if;

  return query
  select
    case g.metric
      when 'distance' then coalesce(sum(a.distance_meters), 0)
      when 'duration' then coalesce(sum(a.duration_seconds), 0)
      else coalesce(count(a.id)::numeric, 0)
    end,
    p_start,
    p_end
  from public.activities a
  where a.user_id = g.user_id
    and a.started_at >= p_start
    and a.started_at < p_end;
end;
$$;

-- Challenges/challenge_participants are already visible to every
-- authenticated user by policy ("Challenges are visible to authenticated
-- users" using (true)), so a leaderboard/team-progress aggregate over that
-- same data isn't a NEW disclosure for a signed-in user — the gap was that
-- these were reachable with NO session at all (granted to anon). Adding an
-- authentication requirement closes that without changing the intended
-- public-within-the-app leaderboard behaviour.
create or replace function public.get_challenge_leaderboard(challenge_id_input uuid)
returns table (user_id uuid, score numeric, activity_count bigint)
language plpgsql
stable security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  return query
  select
    p.user_id,
    case c.metric
      when 'distance' then coalesce(sum(a.distance_meters) filter (
        where a.started_at >= c.starts_at and a.started_at < c.ends_at
          and (c.activity_type is null or a.type = c.activity_type)
      ), 0)
      when 'duration' then coalesce(sum(a.duration_seconds) filter (
        where a.started_at >= c.starts_at and a.started_at < c.ends_at
          and (c.activity_type is null or a.type = c.activity_type)
      ), 0)
      else coalesce(count(a.id) filter (
        where a.started_at >= c.starts_at and a.started_at < c.ends_at
          and (c.activity_type is null or a.type = c.activity_type)
      ), 0)
    end as score,
    coalesce(count(a.id) filter (
      where a.started_at >= c.starts_at and a.started_at < c.ends_at
        and (c.activity_type is null or a.type = c.activity_type)
    ), 0) as activity_count
  from public.challenge_participants p
  join public.challenges c on c.id = p.challenge_id
  left join public.activities a on a.user_id = p.user_id
  where p.challenge_id = challenge_id_input
  group by p.user_id, c.metric
  order by score desc;
end;
$$;

create or replace function public.get_team_goal_progress(challenge_id_input uuid)
returns table (total_progress numeric, participant_count bigint)
language plpgsql
stable security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  return query
  select
    coalesce(sum(
      case c.metric
        when 'distance' then a.distance_meters
        when 'duration' then a.duration_seconds
        else 1
      end
    ) filter (
      where a.started_at >= c.starts_at and a.started_at < c.ends_at
        and (c.activity_type is null or a.type = c.activity_type)
    ), 0) as total_progress,
    (select count(*) from public.challenge_participants where challenge_id = challenge_id_input) as participant_count
  from public.challenges c
  join public.challenge_participants p on p.challenge_id = c.id
  left join public.activities a on a.user_id = p.user_id
  where c.id = challenge_id_input
  group by c.id, c.metric;
end;
$$;

-- None of these four need to work for a logged-out client; the exposure was
-- via a grant to PUBLIC (which anon inherits through), not a direct anon
-- grant — `create or replace function` doesn't touch existing grants, so
-- revoking from PUBLIC and re-granting explicitly to authenticated is what
-- actually closes it (revoking from anon alone is a no-op here since anon
-- was never granted directly).
revoke execute on function public.get_activity_streak(uuid) from public;
revoke execute on function public.get_goal_progress(uuid) from public;
revoke execute on function public.get_challenge_leaderboard(uuid) from public;
revoke execute on function public.get_team_goal_progress(uuid) from public;
grant execute on function public.get_activity_streak(uuid) to authenticated;
grant execute on function public.get_goal_progress(uuid) to authenticated;
grant execute on function public.get_challenge_leaderboard(uuid) to authenticated;
grant execute on function public.get_team_goal_progress(uuid) to authenticated;

-- activity_comments / activity_likes / segment_efforts: SELECT/INSERT
-- checked only that the activity_id existed, not that it was VISIBLE to the
-- caller — so a private activity's comments/likes could be read, and new
-- comments/likes written, by anyone who had (or guessed) its uuid. Mirrors
-- the real visibility predicate activities' own SELECT policy already uses.
drop policy if exists "Comments are visible if the activity is visible" on public.activity_comments;
create policy "Comments are visible if the activity is visible"
  on public.activity_comments for select
  using (exists (
    select 1 from public.activities a
    where a.id = activity_comments.activity_id
      and (a.user_id = auth.uid()
           or a.visibility = 'public'
           or (a.visibility = 'friends' and public.are_friends(auth.uid(), a.user_id)))
  ));

drop policy if exists "Users can comment on an activity they can see" on public.activity_comments;
create policy "Users can comment on an activity they can see"
  on public.activity_comments for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.activities a
      where a.id = activity_comments.activity_id
        and (a.user_id = auth.uid()
             or a.visibility = 'public'
             or (a.visibility = 'friends' and public.are_friends(auth.uid(), a.user_id)))
    )
  );

drop policy if exists "Likes are visible if the activity is visible" on public.activity_likes;
create policy "Likes are visible if the activity is visible"
  on public.activity_likes for select
  using (exists (
    select 1 from public.activities a
    where a.id = activity_likes.activity_id
      and (a.user_id = auth.uid()
           or a.visibility = 'public'
           or (a.visibility = 'friends' and public.are_friends(auth.uid(), a.user_id)))
  ));

drop policy if exists "Users can like an activity they can see" on public.activity_likes;
create policy "Users can like an activity they can see"
  on public.activity_likes for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.activities a
      where a.id = activity_likes.activity_id
        and (a.user_id = auth.uid()
             or a.visibility = 'public'
             or (a.visibility = 'friends' and public.are_friends(auth.uid(), a.user_id)))
    )
  );

drop policy if exists "Efforts are visible if the activity is visible" on public.segment_efforts;
create policy "Efforts are visible if the activity is visible"
  on public.segment_efforts for select
  using (exists (
    select 1 from public.activities a
    where a.id = segment_efforts.activity_id
      and (a.user_id = auth.uid()
           or a.visibility = 'public'
           or (a.visibility = 'friends' and public.are_friends(auth.uid(), a.user_id)))
  ));

-- moderators / moderation_decisions / ops_alerts / otp_codes: RLS is enabled
-- with zero policies (correctly default-deny today), but each table also
-- carried a full anon+authenticated table-level GRANT — dead weight that
-- becomes exploitable the instant anyone adds a single permissive policy in
-- the future. otp_codes in particular holds code_hash for the email OTP
-- sign-in flow. Tightening the grant is defense in depth with no behaviour
-- change today (nothing currently reads/writes these as anon/authenticated).
revoke all on public.moderators from anon, authenticated;
revoke all on public.moderation_decisions from anon, authenticated;
revoke all on public.ops_alerts from anon, authenticated;
revoke all on public.otp_codes from anon, authenticated;

-- delete_own_account: reachable by anon (auth.uid() is null for an
-- anonymous caller, so today's WHERE clause matches nothing — not currently
-- exploitable) but had no internal guard and an unnecessary anon grant on a
-- destructive, account-deleting function.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function public.delete_own_account() from anon, public;
grant execute on function public.delete_own_account() to authenticated;
