-- Security fix: content_reports' INSERT policy only checked reporter_id —
-- reported_user_id and reported_content were entirely attacker-supplied,
-- with nothing tying them to a real message. Combined with
-- apply_moderation_decision (035_auto_moderation.sql), a single forged
-- "high"-severity report (2 strikes) was enough to auto-suspend ANY
-- account for 24 hours, without the accuser ever sharing a conversation
-- with the accused or reporting a message that actually exists.
--
-- This closes the gap the same way the rest of the schema already
-- validates ownership: a BEFORE INSERT trigger, since `with check` can't
-- express a cross-table lookup as cleanly and the existing rate-limit
-- trigger (038_report_rate_limit.sql) already establishes that pattern
-- for this exact table.
create or replace function public.verify_report_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_real_sender uuid;
  v_is_participant boolean;
begin
  -- A report attached to a real message must name that message's actual
  -- sender — not an arbitrary reported_user_id the client made up.
  if new.message_id is not null then
    select sender_id into v_real_sender
      from public.messages
     where id = new.message_id;

    if v_real_sender is null then
      raise exception 'reported message not found';
    end if;

    if new.reported_user_id is not null and new.reported_user_id <> v_real_sender then
      raise exception 'reported_user_id does not match the message sender';
    end if;

    -- Backfill rather than trust a mismatched or omitted value.
    new.reported_user_id := v_real_sender;
  end if;

  -- A report naming a conversation requires the reporter to actually be a
  -- participant in it — otherwise there is nothing plausible connecting
  -- the accuser to the accused at all.
  if new.conversation_id is not null then
    select exists (
      select 1 from public.conversation_participants
       where conversation_id = new.conversation_id
         and user_id = new.reporter_id
    ) into v_is_participant;

    if not v_is_participant then
      raise exception 'reporter is not a participant in the reported conversation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists verify_report_target_trigger on public.content_reports;
create trigger verify_report_target_trigger
  before insert on public.content_reports
  for each row execute function public.verify_report_target();
