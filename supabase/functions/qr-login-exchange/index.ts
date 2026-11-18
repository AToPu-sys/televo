// Issues a real Supabase Auth session for a NEW device, on behalf of the
// user who confirmed a QR login scan on their ALREADY signed-in device —
// without the new device ever typing an email or password.
//
// GoTrue (Supabase Auth) has no client-reachable "create a session for this
// user_id, no credentials" endpoint. The only service_role-level primitive
// that gets there is admin.generateLink({type: "magiclink"}), whose
// response carries a hashed_token that verifyOtp({token_hash, type:
// "magiclink"}) accepts to mint a REAL session — this is the same
// mechanism Supabase's own email templates use via {{ .TokenHash }}
// (see auth-email-templates docs), just consumed here server-side instead
// of via a clicked email link. No email is actually sent: generateLink
// only ever returns the link/token, sending it is a separate step this
// function never takes. Verified working 2026-09-29 against a real account
// (generateLink → verifyOtp produced a valid session with the correct
// user_id).
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Payload = { request_id: string };

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  // The caller here is the SCANNING device (already signed in) confirming
  // it wants to authorize a new device — not the new device itself, which
  // has no session yet to authenticate this request with.
  const {
    data: { user: scanningUser },
  } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
  if (!scanningUser) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!payload.request_id) {
    return new Response("missing request_id", { status: 400 });
  }

  // Re-checks the full state machine server-side rather than trusting the
  // client to have called confirm_qr_login first — this function is the
  // one place that actually hands out a session, so it re-verifies
  // everything confirm_qr_login already enforced: status is exactly
  // 'confirmed', scanned_by_user_id matches THIS caller, and the request
  // hasn't expired. A stale/replayed request_id must fail here even if the
  // client-side call sequence was somehow skipped or reordered.
  const { data: request, error: fetchError } = await admin
    .from("qr_login_requests")
    .select("status, scanned_by_user_id, expires_at")
    .eq("id", payload.request_id)
    .single();

  if (fetchError || !request) {
    return new Response("request not found", { status: 404 });
  }
  if (request.status !== "confirmed") {
    return new Response("request not confirmed", { status: 409 });
  }
  if (request.scanned_by_user_id !== scanningUser.id) {
    return new Response("not your request", { status: 403 });
  }
  if (new Date(request.expires_at) < new Date()) {
    return new Response("request expired", { status: 410 });
  }

  const { data: userRecord } = await admin.auth.admin.getUserById(scanningUser.id);
  const email = userRecord.user?.email;
  if (!email) {
    return new Response("account has no email on file", { status: 500 });
  }

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !linkData.properties?.hashed_token) {
    console.error("[qr-login-exchange] generateLink failed:", linkError?.message);
    return new Response("could not issue session", { status: 500 });
  }

  // Exchanges the token for a real session using a THROWAWAY client — not
  // the shared `admin` client — so this session is created independently
  // and its tokens are returned directly to the caller rather than
  // silently becoming the ACTIVE session on this Edge Function's own
  // (stateless per-invocation, but still worth being explicit about)
  // client instance.
  const exchangeClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: sessionData, error: verifyError } = await exchangeClient.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (verifyError || !sessionData.session) {
    console.error("[qr-login-exchange] verifyOtp failed:", verifyError?.message);
    return new Response("could not issue session", { status: 500 });
  }

  // Broadcasting rather than writing tokens to any table — see
  // scripts/sql/057_qr_login.sql's header comment. This is the one moment
  // the new device's access/refresh token exist outside a device's own
  // Keychain; a Realtime broadcast is never persisted server-side, and the
  // channel name is scoped to this specific request_id, which only the two
  // devices in this handshake know.
  const channel = admin.channel(`qr-login:${payload.request_id}`);
  await new Promise<void>((resolve) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
    });
  });
  await channel.send({
    type: "broadcast",
    event: "session",
    payload: {
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
    },
  });
  await admin.removeChannel(channel);

  return new Response("ok", { status: 200 });
});
