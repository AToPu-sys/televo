// Sends a VoIP push through Apple's APNs, authenticated with the VoIP
// Services Certificate (mTLS client certificate — APNs has no token-based
// auth path for VoIP pushes the way it does for regular ones). This is the
// ONLY way to wake Televo from a fully-terminated state to answer a call:
// a VoIP push is delivered to the app's PushKit delegate even when the app
// isn't running, which is what lets CallKit show the native incoming-call
// screen before the JS runtime has even started. The existing
// send-push-notification function (Expo push) cannot do this — Expo has no
// VoIP push concept, and a regular remote notification is not guaranteed
// delivery and cannot invoke CallKit.
//
// Deliberately a SEPARATE function/trigger (027_voip_push_tokens.sql) from
// the existing call notification rather than replacing it: a recipient with
// no VoIP token registered yet (pre-upgrade build) still gets the Expo
// push as a fallback, same as before this existed.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type WebhookPayload = {
  record: {
    id: string;
    conversation_id: string;
    caller_id: string;
    kind: "audio" | "video";
  };
};

function base64Decode(b64: string): string {
  return atob(b64);
}

let cachedHttpClient: Deno.HttpClient | null = null;

/** Builds (once per function instance — cold starts pay this, warm
 * invocations reuse it) the mTLS client APNs requires for VoIP pushes. */
function getApnsHttpClient(): Deno.HttpClient {
  if (cachedHttpClient) return cachedHttpClient;

  const certB64 = Deno.env.get("APNS_VOIP_CERT_B64");
  const keyB64 = Deno.env.get("APNS_VOIP_KEY_B64");
  if (!certB64 || !keyB64) {
    throw new Error("APNS_VOIP_CERT_B64 / APNS_VOIP_KEY_B64 are not configured");
  }

  cachedHttpClient = Deno.createHttpClient({
    cert: base64Decode(certB64),
    key: base64Decode(keyB64),
  });
  return cachedHttpClient;
}

async function sendVoipPush(deviceToken: string, payload: Record<string, unknown>) {
  const configuredTopic = Deno.env.get("APNS_TOPIC") ?? "com.televo.app";
  // The VoIP topic is always "<bundle id>.voip". Appended here rather than
  // required in the secret so a plain bundle id works, but NOT appended twice
  // if whoever set the secret already included the suffix — "com.televo.app
  // .voip.voip" is a topic no certificate covers, and APNs rejects it with
  // 400 BadTopic, which looks exactly like "no push was sent".
  const topic = configuredTopic.endsWith(".voip")
    ? configuredTopic
    : `${configuredTopic}.voip`;

  // BOTH environments, unconditionally and in parallel — not production with
  // a fallback to sandbox on BadDeviceToken.
  //
  // The fallback approach was the reason a terminated app never rang. A VoIP
  // Services Certificate is not scoped to an environment: the same cert
  // authenticates against both gateways. Given a syntactically valid device
  // token for its own team/bundle, the PRODUCTION gateway therefore returns
  // 200 OK for a token that was actually issued in the sandbox environment
  // (any development-signed build, i.e. aps-environment=development) and then
  // silently discards the push — no BadDeviceToken, no error of any kind. The
  // fallback branch was consequently never reached, and the push was
  // acknowledged as delivered while never reaching the device.
  //
  // A token is only ever live in ONE environment, so the send to the other one
  // is harmless: it is either accepted-and-dropped (the case above) or refused
  // with BadDeviceToken. Sending to both is the only way to be correct without
  // recording, per token, which environment the build that produced it was
  // signed for. They run concurrently so a development-signed device is not
  // made to wait for a production round trip first — a VoIP push that arrives
  // late is a missed call.
  const hosts = ["https://api.push.apple.com", "https://api.sandbox.push.apple.com"];

  const attempts = await Promise.all(
    hosts.map(async (host) => {
      try {
        const response = await fetch(`${host}/3/device/${deviceToken}`, {
          method: "POST",
          client: getApnsHttpClient(),
          headers: {
            "apns-topic": topic,
            "apns-push-type": "voip",
            // VoIP pushes must be delivered immediately — a call ringing 30
            // seconds late is a missed call, not a delayed notification.
            "apns-priority": "10",
            "apns-expiration": "0",
          },
          body: JSON.stringify(payload),
        });
        if (response.ok) return { host, ok: true as const };
        return {
          host,
          ok: false as const,
          error: `${host}: ${response.status} ${await response.text()}`,
        };
      } catch (error) {
        // A transport-level failure against one gateway (TLS, DNS, timeout)
        // must not abort the other: the device is reachable through exactly
        // one of them, and that one may well be the healthy one.
        return { host, ok: false as const, error: `${host}: ${String(error)}` };
      }
    })
  );

  // Success on EITHER gateway means the environment holding this token
  // accepted the push. Note a production 200 for a sandbox token also counts
  // as "ok" here — that is unavoidable, since APNs gives no way to tell the
  // two apart — but it no longer matters, because the sandbox gateway was
  // sent the same push in parallel and that is the one that rings.
  if (attempts.some((a) => a.ok)) return { ok: true as const };
  return {
    ok: false as const,
    error: attempts.map((a) => (a as { error: string }).error).join(" | "),
  };
}

Deno.serve(async (req) => {
  // FAIL CLOSED — same posture as send-push-notification: an unauthenticated
  // caller could trigger arbitrary VoIP pushes, which wake the app and show
  // a fake incoming-call screen. Never skip this check.
  const webhookSecret = Deno.env.get("WEBHOOK_SHARED_SECRET");
  if (!webhookSecret) {
    console.error("WEBHOOK_SHARED_SECRET is not configured — refusing to serve.");
    return new Response("server not configured", { status: 500 });
  }
  if (req.headers.get("x-webhook-secret") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const call = payload.record;
  if (!call) return new Response("ignored", { status: 200 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const [{ data: caller }, { data: participants }] = await Promise.all([
    admin.from("profiles").select("display_name").eq("id", call.caller_id).single(),
    admin
      .from("conversation_participants")
      .select("user_id")
      .eq("conversation_id", call.conversation_id)
      .neq("user_id", call.caller_id),
  ]);

  const recipientIds = (participants ?? []).map((p) => p.user_id);
  if (recipientIds.length === 0) {
    return new Response("no recipients", { status: 200 });
  }

  const { data: tokenRows } = await admin
    .from("voip_push_tokens")
    .select("apns_token")
    .in("user_id", recipientIds);

  const tokens = (tokenRows ?? []).map((row) => row.apns_token);
  if (tokens.length === 0) {
    // Not an error: this recipient just has no VoIP token registered yet
    // (pre-upgrade build), and notify_incoming_call's Expo push already
    // covers them.
    return new Response("no voip tokens registered", { status: 200 });
  }

  // The VoIP push payload itself carries only what's needed to show the
  // system call screen and later join the existing Supabase Realtime
  // signaling channel — never any call content. reportIncomingCall on the
  // client reads these exact keys.
  const apnsPayload = {
    aps: { alert: "" }, // required key by APNs schema; PushKit ignores it
    callId: call.id,
    conversationId: call.conversation_id,
    callerName: caller?.display_name ?? "Televo",
    kind: call.kind,
  };

  const results = await Promise.all(
    tokens.map((token) => sendVoipPush(token, apnsPayload))
  );

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.error("VoIP push failures:", failures.map((f) => (f as { error: string }).error));
  }

  // A token is only ever live in ONE environment (see sendVoipPush's own
  // comment), so a genuine BadDeviceToken/410 on ONE gateway is completely
  // normal and doesn't mean the token is dead — it means the OTHER gateway
  // is the right one, which is exactly why both are always tried. Only prune
  // a token when it failed on BOTH gateways AND at least one of those
  // failures was APNs actually saying the token is invalid/gone (not a
  // transport error, rate limit, or payload problem, which say nothing about
  // whether the token itself still works). Mirrors send-push-notification's
  // DeviceNotRegistered pruning for Expo tokens — this table had no
  // equivalent, so every uninstall/reinstall or token rotation left a dead
  // row that ate a wasted, logged-as-failure push attempt on every future
  // call, forever.
  // Mapped over `results`, NOT `failures`: `failures` is a compacted array,
  // so its indices no longer line up with `tokens`. Indexing tokens[] by a
  // filtered array's index deleted the WRONG rows — with [A,B,C] where only
  // C failed, it pruned healthy token A and left the dead one, silently
  // unregistering a working device from VoIP pushes entirely.
  const deadTokens = results
    .map((result, index) => ({ result, token: tokens[index] }))
    .filter(({ result }) => {
      if (result.ok) return false;
      const error = (result as { error: string }).error;
      // ":\s*410" rather than "status 410": the error string is built as
      // `${host}: ${response.status} ${body}`, so the literal "status 410"
      // never appears and a 410 with an empty body matched nothing.
      return /BadDeviceToken|Unregistered|:\s*410\s/i.test(error);
    })
    .map(({ token }) => token);

  if (deadTokens.length > 0) {
    await admin.from("voip_push_tokens").delete().in("apns_token", deadTokens);
  }

  if (failures.length === results.length) {
    return new Response("all voip pushes failed", { status: 502 });
  }

  return new Response("ok", { status: 200 });
});
