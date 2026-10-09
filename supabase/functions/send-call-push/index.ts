// Sends the call-specific Expo push: Android's whole path to an incoming
// call (no CallKit equivalent exists there), and iOS's own fallback for a
// recipient with no VoIP token registered yet (pre-upgrade build).
//
// Deliberately a SEPARATE function from send-push-notification (messages),
// not a shared code path, for three reasons that all showed up as real
// bugs when calls and messages shared one function:
//   1. Filtering: a call must be gated on notify_calls, a message on
//      notify_messages — send-push-notification only ever checked the
//      latter, so turning off message notifications silently muted calls
//      too.
//   2. Payload: the client needs `data.kind === "call"` plus `callId` to
//      tell a call push apart from a message push and open the call screen
//      instead of the chat — send-push-notification's `data` carried only
//      `conversationId`, so there was no way to distinguish the two at all.
//   3. Delivery: a call is time-critical in a way a message push isn't —
//      `priority: "high"` plus Android's own `channelId: "calls"` (a
//      separate high-importance channel from the default one messages use,
//      registered client-side in usePushNotifications.ts) is what makes
//      Android show this over the lock screen with its own sound instead of
//      queuing silently like an ordinary notification.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send";

type WebhookPayload = {
  record: {
    id: string;
    conversation_id: string;
    caller_id: string;
    kind: "audio" | "video";
  };
};

Deno.serve(async (req) => {
  // FAIL CLOSED — same posture as every other webhook-triggered function
  // here: an unauthenticated caller could ring arbitrary users' phones.
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

  const allRecipientIds = (participants ?? []).map((p) => p.user_id);
  if (allRecipientIds.length === 0) {
    return new Response("no recipients", { status: 200 });
  }

  const { data: recipientProfiles } = await admin
    .from("profiles")
    .select("id, notify_calls")
    .in("id", allRecipientIds);
  const recipientIds = (recipientProfiles ?? [])
    .filter((p) => p.notify_calls)
    .map((p) => p.id);
  if (recipientIds.length === 0) {
    return new Response("all recipients muted calls", { status: 200 });
  }

  const { data: tokenRows } = await admin
    .from("push_tokens")
    .select("expo_push_token")
    .in("user_id", recipientIds);

  const tokens = (tokenRows ?? []).map((row) => row.expo_push_token);
  if (tokens.length === 0) {
    return new Response("no push tokens registered", { status: 200 });
  }

  const callerName = caller?.display_name ?? "Televo";
  const title = callerName;
  const body = call.kind === "video" ? "Incoming video call" : "Incoming call";

  const notifications = tokens.map((token) => ({
    to: token,
    title,
    body,
    sound: "default",
    // Android only — iOS ignores both and relies on the VoIP push's own
    // priority/CallKit path instead (see send-voip-push). "high" plus a
    // dedicated channel is what makes this show over the lock screen with
    // its own ringtone instead of queuing like a normal notification.
    priority: "high",
    channelId: "calls",
    // `kind: "call"` is the field usePushNotifications.ts switches on to
    // route a tap (or, on Android, a foreground/background delivery) to the
    // call screen instead of the chat. callId lets the client look up the
    // exact calls row rather than guessing which one in the conversation is
    // still ringing.
    data: { kind: "call", callId: call.id, conversationId: call.conversation_id },
  }));

  const response = await fetch(EXPO_PUSH_API, {
    method: "POST",
    headers: {
      host: "exp.host",
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(notifications),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Expo push API error:", response.status, errorText);
    return new Response("push send failed", { status: 502 });
  }

  const result = (await response.json().catch(() => null)) as
    | { data?: { status: string; message?: string; details?: { error?: string } }[] }
    | null;

  const tickets = result?.data ?? [];
  const failures = tickets.filter((ticket) => ticket.status === "error");

  if (failures.length > 0) {
    console.error(
      `Expo rejected ${failures.length}/${tickets.length} call pushes:`,
      failures.map((f) => `${f.details?.error ?? "unknown"}: ${f.message ?? ""}`).join(" | ")
    );

    const deadTokens = tickets
      .map((ticket, index) => ({ ticket, token: tokens[index] }))
      .filter(({ ticket }) => ticket.details?.error === "DeviceNotRegistered")
      .map(({ token }) => token);

    if (deadTokens.length > 0) {
      await admin.from("push_tokens").delete().in("expo_push_token", deadTokens);
    }

    if (failures.length === tickets.length) {
      return new Response(
        `all call pushes rejected: ${failures[0].details?.error ?? "unknown"}`,
        { status: 502 }
      );
    }
  }

  return new Response("ok", { status: 200 });
});
