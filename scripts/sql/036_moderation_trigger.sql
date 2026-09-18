-- Fires the classifier the moment a report is filed. Without this the
-- moderate-report function exists but nothing ever calls it, and the queue
-- goes back to filling up unread.
create or replace function public.notify_content_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/moderate-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', new.id,
        'reporter_id', new.reporter_id,
        'reported_user_id', new.reported_user_id,
        'reason', new.reason,
        'reported_content', new.reported_content
      )
    )
  );
  return new;
end;
$$;

drop trigger if exists on_content_report_moderate on public.content_reports;
create trigger on_content_report_moderate
  after insert on public.content_reports
  for each row execute function public.notify_content_report();
