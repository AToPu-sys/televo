-- QR sign-in: request ids must not be listable. The waiting device receives
-- its session on the broadcast topic qr-login:<id>, so anyone able to list ids
-- could subscribe and take the session. Only the id shown in the QR code is
-- now known to the device; the edge function and the RPCs use definer rights
-- or the service role and do not need this policy.
drop policy if exists "Anyone can read a QR login request by id" on public.qr_login_requests;
