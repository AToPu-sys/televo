-- The APNs VoIP certificate expires 2027-10-05. When it does, incoming calls
-- to a terminated app stop ringing — and they do so SILENTLY: send-voip-push
-- catches the TLS failure, notify_incoming_call_voip ignores the HTTP
-- response, and nothing surfaces anywhere. Until this migration, the expiry
-- date was not recorded in the codebase at all and nothing would have warned
-- about it.
--
-- Daily check that writes a row whenever the certificate is inside its last
-- 30 days, so the condition is visible in the database rather than depending
-- on someone remembering a date more than a year out.
create table if not exists public.ops_alerts (
  id bigint generated always as identity primary key,
  kind text not null,
  detail text not null,
  created_at timestamptz not null default now()
);

alter table public.ops_alerts enable row level security;
-- No policies: this is operator-facing only. RLS with zero policies denies
-- every client, which is the intent — the row is for whoever reads the
-- database directly, never for the app.

create or replace function public.check_apns_cert_expiry()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/apns-cert-check',
    headers := jsonb_build_object('x-webhook-secret', secret)
  );
end;
$$;

revoke all on function public.check_apns_cert_expiry() from public;
revoke all on function public.check_apns_cert_expiry() from authenticated;
revoke all on function public.check_apns_cert_expiry() from anon;

-- Records a warning row when the checker reports 503 (its "expiring soon"
-- status). Reads net._http_response, which is where pg_net parks results.
create or replace function public.record_apns_cert_alerts()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ops_alerts (kind, detail)
  select 'apns_cert_expiring', left(coalesce(r.content, ''), 500)
    from net._http_response r
   where r.status_code = 503
     and r.created > now() - interval '2 days'
     and coalesce(r.content, '') like '%APNs VoIP certificate expires soon%'
     and not exists (
       select 1 from public.ops_alerts a
        where a.kind = 'apns_cert_expiring'
          and a.created_at > now() - interval '1 day'
     );
end;
$$;

revoke all on function public.record_apns_cert_alerts() from public;
revoke all on function public.record_apns_cert_alerts() from authenticated;
revoke all on function public.record_apns_cert_alerts() from anon;

select cron.unschedule('check-apns-cert')
 where exists (select 1 from cron.job where jobname = 'check-apns-cert');

-- 09:00 UTC daily. A cert problem is not urgent to the minute — it needs to
-- be noticed weeks ahead, which a daily cadence covers with room to spare.
select cron.schedule(
  'check-apns-cert',
  '0 9 * * *',
  $$select public.check_apns_cert_expiry()$$
);

select cron.unschedule('record-apns-cert-alerts')
 where exists (select 1 from cron.job where jobname = 'record-apns-cert-alerts');

-- Runs a few minutes later so the HTTP response has landed in net._http_response.
select cron.schedule(
  'record-apns-cert-alerts',
  '5 9 * * *',
  $$select public.record_apns_cert_alerts()$$
);
