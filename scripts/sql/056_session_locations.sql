-- IP-based city/country for each device session, shown in the Devices
-- screen (Telegram-style "Poland" / "Frankfurt am Main, Germany"). Not
-- stored on push_tokens/voip_push_tokens directly — one row per session_id
-- covers both token types without duplicating the same location twice, and
-- a device with no push token yet (registration can lag a session by a
-- moment) still gets a location row as soon as it resolves.
--
-- auth.sessions has no IP column in Supabase's schema (IP only appears
-- inside auth.audit_log_entries as opaque JSON, not meant for app queries),
-- so this is populated separately by the register-device-location Edge
-- Function, which reads the real client IP from the x-forwarded-for header
-- Supabase's edge network sets — something only reachable from a Deno
-- function, not from SQL or PostgREST.
create table public.session_locations (
  session_id uuid primary key,
  city text,
  country text,
  created_at timestamptz not null default now()
);

alter table public.session_locations enable row level security;

-- No direct client access at all: rows are written by the Edge Function
-- (service_role, bypasses RLS) and read only through list_my_devices()
-- below (SECURITY DEFINER, scoped to auth.uid()'s own sessions). A user
-- reading another user's approximate location via a bare table grant would
-- be a real privacy leak, so there is deliberately no policy granting
-- select/insert to `authenticated` here.

-- Re-created (not just altered) to add city/country to the existing
-- session_locations-less version from scripts/sql/055 — CREATE OR REPLACE
-- can't add output columns to a function whose signature changed, so this
-- must be dropped first.
drop function if exists public.list_my_devices();

create function public.list_my_devices()
returns table (
  session_id uuid,
  device_name text,
  device_model text,
  is_active boolean,
  last_active_at timestamptz,
  created_at timestamptz,
  city text,
  country text
)
language sql
security definer
set search_path = public
as $$
  select
    coalesce(p.session_id, v.session_id) as session_id,
    coalesce(p.device_name, v.device_name) as device_name,
    coalesce(p.device_model, v.device_model) as device_model,
    (s.id is not null) as is_active,
    coalesce(s.updated_at, p.updated_at, v.updated_at) as last_active_at,
    coalesce(p.created_at, v.created_at) as created_at,
    l.city,
    l.country
  from public.push_tokens p
  full outer join public.voip_push_tokens v
    on v.user_id = p.user_id and v.session_id = p.session_id
  left join auth.sessions s
    on s.id = coalesce(p.session_id, v.session_id)
  left join public.session_locations l
    on l.session_id = coalesce(p.session_id, v.session_id)
  where coalesce(p.user_id, v.user_id) = auth.uid()
    and coalesce(p.session_id, v.session_id) is not null
  order by last_active_at desc nulls last;
$$;

revoke all on function public.list_my_devices() from public;
grant execute on function public.list_my_devices() to authenticated;

-- Called by register-device-location (service_role) only — writes are never
-- client-reachable directly (see the RLS note above), but a SECURITY
-- DEFINER upsert function is still cleaner than the Edge Function needing
-- its own raw insert against a table with RLS enabled and no policies.
create or replace function public.set_session_location(
  p_session_id uuid,
  p_city text,
  p_country text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.session_locations (session_id, city, country)
  values (p_session_id, p_city, p_country)
  on conflict (session_id) do update set
    city = excluded.city,
    country = excluded.country;
$$;

revoke all on function public.set_session_location(uuid, text, text) from public;
-- Deliberately NOT granted to `authenticated` — only service_role (which
-- bypasses grants entirely) should be able to claim a location for an
-- arbitrary session_id. A client-callable version would let anyone spoof
-- another session's recorded location.

-- auth.sessions isn't exposed through PostgREST's default schema list, so
-- register-device-location (Edge Function) can't just .schema("auth")
-- .from("sessions") to verify the caller owns the session_id it was given
-- before recording a location for it. This is that check, callable instead.
create or replace function public.session_belongs_to_user(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.sessions where id = p_session_id and user_id = p_user_id
  );
$$;

revoke all on function public.session_belongs_to_user(uuid, uuid) from public;
-- service_role only — same posture as set_session_location above.
