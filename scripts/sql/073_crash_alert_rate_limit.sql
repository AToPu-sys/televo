-- client_crash_reports accepts inserts from anon (a crash can happen before
-- sign-in), and the anon key ships inside the app — so anyone can insert
-- fatal reports in a loop, and 071's trigger turned each one into an email.
-- That's a free way to flood the operator inbox until real alerts get
-- ignored. Rows are still stored (nothing is lost for later review); only
-- the EMAIL is capped, at 10 per rolling hour.
create or replace function public.notify_new_crash_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
  recent_fatal integer;
begin
  if not new.is_fatal then
    return new;
  end if;

  select count(*) into recent_fatal
    from public.client_crash_reports
   where is_fatal
     and reported_at > now() - interval '1 hour';
  -- recent_fatal includes this row (AFTER INSERT trigger).
  if recent_fatal > 10 then
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

revoke execute on function public.notify_new_crash_report() from anon, public, authenticated;
