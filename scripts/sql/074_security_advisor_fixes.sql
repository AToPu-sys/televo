-- Fixes from Supabase's security advisor (2026-10-04 pre-release audit).

-- set_session_location was SECURITY DEFINER with no ownership check and
-- executable by anon: anyone could overwrite the city/country shown for any
-- session on someone's Devices screen. Its only legitimate caller is the
-- register-device-location Edge Function, which uses the service role and
-- verifies ownership itself (via session_belongs_to_user) first.
revoke execute on function public.set_session_location(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.session_belongs_to_user(uuid, uuid) from public, anon, authenticated;

-- Pin search_path so a role that can create objects in another schema on the
-- path can't shadow a table/function these reference and hijack them.
alter function public.set_updated_at() set search_path = public;
alter function public.haversine_meters(double precision, double precision, double precision, double precision) set search_path = public;
alter function public.prevent_encryption_downgrade() set search_path = public;
alter function public.enforce_message_edit_scope() set search_path = public;
alter function public.block_client_system_messages() set search_path = public;
