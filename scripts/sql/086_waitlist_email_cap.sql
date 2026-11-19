-- The waitlist accepts any address without sign-in and mails each one, so a
-- script could send our welcome email to thousands of strangers and wreck the
-- sending domain's reputation (auth codes come from it too). Cap at 30/hour.

CREATE OR REPLACE FUNCTION public.notify_new_waitlist_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  secret text;
  recent integer;
begin
  -- Anyone can add any address here, so cap the welcome emails: past 30 an
  -- hour the address is still stored but nobody gets mail they didn't ask for.
  select count(*) into recent from public.waitlist where created_at > now() - interval '1 hour';
  if recent > 30 then
    return new;
  end if;

  select value into secret from private.app_secrets where key = 'webhook_shared_secret';

  perform net.http_post(
    url := 'https://dzoemidyjeeqzifucvpt.supabase.co/functions/v1/send-waitlist-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object('email', new.email)
    )
  );
  return new;
end;
$function$;
