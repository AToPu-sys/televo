-- The assistant welcome message promised "powered by Claude. Ask me
-- anything." A reviewer creating an account sees that promise, sends a
-- message, and (while the upstream API is unavailable) gets a failure
-- notice instead -- which reads as a broken advertised feature.
--
-- Rewritten to a claim that holds regardless of upstream availability.
-- Only the trigger function changes; existing rows are left alone because
-- they are real messages in real conversations.
create or replace function public.create_assistant_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conversation_id uuid;
begin
  insert into public.conversations (id, kind, created_by)
  values (gen_random_uuid(), 'direct', new.id)
  returning id into conversation_id;

  insert into public.conversation_participants (conversation_id, user_id)
  values
    (conversation_id, new.id),
    (conversation_id, '00000000-0000-0000-0000-000000000001');

  insert into public.messages (conversation_id, sender_id, kind, body)
  values (
    conversation_id,
    '00000000-0000-0000-0000-000000000001',
    'text',
    'Hi! I''m the Televo Assistant. Ask me a question and I''ll reply here.'
  );

  return new;
end;
$$;

revoke execute on function public.create_assistant_conversation() from anon, public, authenticated;
