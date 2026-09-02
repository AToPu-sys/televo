-- The 2FA screen was decorative: NO policy checked the session's
-- Authenticator Assurance Level, so a stolen password gave full API access
-- straight past TOTP. Verified: an AAL1 session could read profiles.
--
-- Now, for users who have actually enrolled a TOTP factor, reading messages
-- requires AAL2. Users without 2FA are unaffected (aal1 is their ceiling),
-- so this can't lock anyone out.
create or replace function public.session_meets_mfa_requirement()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- No verified factor enrolled => nothing to step up to.
    not exists (
      select 1 from auth.mfa_factors
      where user_id = (select auth.uid()) and status = 'verified'
    )
    -- Otherwise the session must have completed the TOTP challenge.
    or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

revoke execute on function public.session_meets_mfa_requirement() from anon, public;
grant execute on function public.session_meets_mfa_requirement() to authenticated;

-- Message contents are the sensitive payload; gate reads on the step-up.
drop policy if exists "Participants can view messages" on public.messages;

create policy "Participants can view messages"
on public.messages for select
to authenticated
using (
  is_conversation_participant(conversation_id, (select auth.uid()))
  and public.session_meets_mfa_requirement()
);
