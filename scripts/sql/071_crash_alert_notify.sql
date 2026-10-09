-- client_crash_reports (070_client_crash_reports.sql) is insert-only for
-- clients and operator-only to read — which meant nothing would actually
-- surface a crash until someone remembered to go query the table. This
-- sends an email the moment a FATAL report lands, mirroring the existing
-- notify_new_waitlist_signup webhook pattern (058_waitlist_email_notify.sql).
--
-- Non-fatal reports do not alert — ErrorBoundary catches those as recovered
-- render errors (app/_layout.tsx), and a flood of them would make the
-- operator start ignoring crash alerts entirely, which defeats the point.
create or replace function public.notify_new_crash_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  if not new.is_fatal then
    return new;
  end if;

  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-crash-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', new.id,
        'user_id', new.user_id,
        'occurred_at', new.occurred_at,
        'platform', new.platform,
        'app_version', new.app_version,
        'build_number', new.build_number,
        'message', new.message,
        'stack', new.stack,
        'screen', new.screen
      )
    )
  );
  return new;
end;
$$;

create trigger on_crash_report_notify
  after insert on public.client_crash_reports
  for each row execute function public.notify_new_crash_report();

revoke execute on function public.notify_new_crash_report() from anon, public, authenticated;
