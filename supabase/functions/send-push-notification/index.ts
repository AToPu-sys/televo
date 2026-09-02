// Called by a Postgres webhook (scripts/sql/011_push_tokens.sql,
// notify_new_message_push trigger) whenever a new message is inserted.
// Looks up every OTHER participant in that conversation, their registered
// Expo push tokens, and sends a push via the Expo push service. Encrypted
// (Secret Chat) message bodies are never included in the notification text —
// only a generic "sent a message" is shown, so a push notification can't
// leak plaintext the server itself never had.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ASSISTANT_USER_ID = "00000000-0000-0000-0000-000000000001";
const EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send";

type WebhookPayload = {
  record: {
    id: string;
    conversation_id: string;
    sender_id: string;
    kind: string;
    body: string | null;
  };
};

function previewFor(kind: string, body: string | null, isEncrypted: boolean): string {
  // A call notification carries its own text and is never a Secret Chat
  // body, so it must not be replaced with "sent a message".
  if (kind === "call") return body ?? "Incoming call";
  if (isEncrypted) return "sent a message";
  switch (kind) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎬 Video";
    case "document":
      return "📄 Document";
    default:
      return body ?? "sent a message";
  }
}

Deno.serve(async (req) => {
  // FAIL CLOSED: a missing secret must reject, not skip the check. This
  // function can send arbitrary push notification text to any user's
  // devices, so an unauthenticated caller is a phishing primitive.
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

  const message = payload.record;
  if (!message || message.sender_id === ASSISTANT_USER_ID) {
    return new Response("ignored", { status: 200 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: conversation } = await admin
    .from("conversations")
    .select("kind, title, is_encrypted")
    .eq("id", message.conversation_id)
    .single();

  if (!conversation) {
    return new Response("conversation not found", { status: 200 });
  }

  const { data: sender } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", message.sender_id)
    .single();

  const { data: participants } = await admin
    .from("conversation_participants")
    .select("user_id")
    .eq("conversation_id", message.conversation_id)
    .neq("user_id", message.sender_id);

  const recipientIds = (participants ?? []).map((p) => p.user_id);
  if (recipientIds.length === 0) {
    return new Response("no recipients", { status: 200 });
  }

  const { data: tokenRows } = await admin
    .from("push_tokens")
    .select("expo_push_token")
    .in("user_id", recipientIds);

  const tokens = (tokenRows ?? []).map((row) => row.expo_push_token);
  if (tokens.length === 0) {
    return new Response("no push tokens registered", { status: 200 });
  }

  const senderName = sender?.display_name ?? "Someone";
  const title = conversation.kind === "group" ? conversation.title ?? "Group" : senderName;
  const body =
    conversation.kind === "group"
      ? `${senderName}: ${previewFor(message.kind, message.body, conversation.is_encrypted)}`
      : previewFor(message.kind, message.body, conversation.is_encrypted);

  const notifications = tokens.map((token) => ({
    to: token,
    title,
    body,
    sound: "default",
    data: { conversationId: message.conversation_id },
  }));

  const response = await fetch(EXPO_PUSH_API, {
    method: "POST",
    headers: {
      host: "exp.host",
      accept: "application/json",
      "content-type": "application/json",
    },
    // Expo caps a single request at 100 messages; this app's fan-out (one
    // conversation's participant count) is nowhere near that, so no
    // batching loop is needed.
    body: JSON.stringify(notifications),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Expo push API error:", response.status, errorText);
    return new Response("push send failed", { status: 502 });
  }

  return new Response("ok", { status: 200 });
});
