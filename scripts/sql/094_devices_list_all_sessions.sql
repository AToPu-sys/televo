-- 094: the device list was built from push-token rows, so any session with
-- no push token was invisible and could not be signed out remotely: every
-- web browser session, and phones that never allowed notifications. It now
-- lists every live auth session (plus ended ones remembered by a push token),
-- naming browsers from their user agent, e.g. "Chrome on macOS" / "Televo Web".

create or replace function public.device_label_from_ua(p_ua text)
returns table(device_name text, device_model text)
language sql immutable set search_path to 'public' as $$
  with u as (select coalesce(p_ua, '') ua),
  k as (
    select ua,
      ua ilike 'Mozilla/%' as is_browser,
      case
        when ua ~ 'Edg(e|A|iOS)?/' then 'Edge'
        when ua ~ 'OPR/|Opera' then 'Opera'
        when ua ~ 'YaBrowser/' then 'Yandex Browser'
        when ua ~ 'SamsungBrowser/' then 'Samsung Internet'
        when ua ~ 'Firefox/|FxiOS/' then 'Firefox'
        when ua ~ 'Chrome/|CriOS/' then 'Chrome'
        when ua ~ 'Safari/' then 'Safari'
        else 'Browser' end as browser,
      case
        when ua ~ 'iPhone' then 'iPhone'
        when ua ~ 'iPad' then 'iPad'
        when ua ~ 'Android' then 'Android'
        when ua ~ 'Windows' then 'Windows'
        when ua ~ 'CrOS' then 'ChromeOS'
        when ua ~ 'Mac OS X|Macintosh' then 'macOS'
        when ua ~ 'Linux' then 'Linux'
        else null end as os
    from u
  )
  select
    case when is_browser then 'Televo Web'
         when ua ~ 'CFNetwork|Darwin' or ua ~ '^Televo/' then 'Televo for iPhone'
         when ua ~ 'okhttp' then 'Televo for Android'
         else 'Televo' end,
    case when is_browser then browser || coalesce(' on ' || os, '')
         when ua ~ 'CFNetwork|Darwin' then 'iPhone'
         when ua ~ 'okhttp' then 'Android'
         else null end
  from k;
$$;

create or replace function public.list_my_devices()
returns table(session_id uuid, device_name text, device_model text, is_active boolean,
              last_active_at timestamptz, created_at timestamptz, city text, country text)
language sql stable security definer set search_path to 'public' as $$
  with tokens as (
    select coalesce(p.session_id, v.session_id) as session_id,
           coalesce(p.device_name, v.device_name) as device_name,
           coalesce(p.device_model, v.device_model) as device_model,
           coalesce(p.updated_at, v.updated_at) as updated_at,
           coalesce(p.created_at, v.created_at) as created_at
      from public.push_tokens p
      full outer join public.voip_push_tokens v
        on v.user_id = p.user_id and v.session_id = p.session_id
     where coalesce(p.user_id, v.user_id) = auth.uid()
       and coalesce(p.session_id, v.session_id) is not null
  ),
  live as (
    select s.id, s.user_agent, s.created_at, coalesce(s.refreshed_at, s.updated_at, s.created_at) as active_at
      from auth.sessions s
     where s.user_id = auth.uid()
  )
  select coalesce(l.id, t.session_id),
         coalesce(t.device_name, ua.device_name),
         coalesce(t.device_model, ua.device_model),
         l.id is not null,
         coalesce(l.active_at, t.updated_at),
         coalesce(t.created_at, l.created_at),
         loc.city, loc.country
    from live l
    full outer join tokens t on t.session_id = l.id
    left join lateral public.device_label_from_ua(l.user_agent) ua on true
    left join public.session_locations loc on loc.session_id = coalesce(l.id, t.session_id)
   order by 5 desc nulls last;
$$;
revoke all on function public.list_my_devices() from public, anon;
grant execute on function public.list_my_devices() to authenticated;
