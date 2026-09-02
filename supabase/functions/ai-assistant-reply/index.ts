// Called by a Postgres webhook (see scripts/sql/010_ai_assistant_webhook.sql)
// whenever a new message lands in a conversation that includes the reserved
// assistant user (00000000-0000-0000-0000-000000000001) and was NOT sent by
// the assistant itself. Fetches recent history for context, calls the Claude
// API, and inserts the reply using the service-role key. The client never
// calls Claude directly and never holds an API key.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ASSISTANT_USER_ID = "00000000-0000-0000-0000-000000000001";
const CLAUDE_MODEL = "claude-haiku-4-5";
const HISTORY_LIMIT = 20;

type WebhookPayload = {
  type: "INSERT";
  table: string;
  record: {
    id: string;
    conversation_id: string;
    sender_id: string;
    kind: string;
    body: string | null;
  };
};

Deno.serve(async (req) => {
  // Deployed with --no-verify-jwt because the caller is a Postgres webhook,
  // not a client holding a Supabase auth session — so this endpoint is
  // reachable by anyone who knows the URL unless gated some other way.
  // FAIL CLOSED: a missing/misconfigured secret must reject, never wave the
  // request through. This function inserts with the service-role key and
  // spends Anthropic credit, so an unauthenticated caller is a real problem.
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
    return new Response("Bad Request", { status: 400 });
  }

  const message = payload.record;
  if (!message || message.kind !== "text" || !message.body) {
    return new Response("ignored", { status: 200 });
  }
  if (message.sender_id === ASSISTANT_USER_ID) {
    // Guards against the assistant's own reply re-triggering this function.
    return new Response("ignored (own message)", { status: 200 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (!anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY is not configured");
    return new Response("server not configured", { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Confirm the assistant is actually a participant in this conversation —
  // the webhook already filters by table/event, but this keeps the function
  // safe to call for any messages row without trusting the caller's filter.
  const { data: participant } = await admin
    .from("conversation_participants")
    .select("user_id")
    .eq("conversation_id", message.conversation_id)
    .eq("user_id", ASSISTANT_USER_ID)
    .maybeSingle();

  if (!participant) {
    return new Response("not an assistant conversation", { status: 200 });
  }

  const { data: history } = await admin
    .from("messages")
    .select("sender_id, body, kind, created_at")
    .eq("conversation_id", message.conversation_id)
    .eq("kind", "text")
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  const orderedHistory = (history ?? []).slice().reverse();
  const claudeMessages = orderedHistory
    .filter((row) => row.body)
    .map((row) => ({
      role: row.sender_id === ASSISTANT_USER_ID ? "assistant" : "user",
      content: row.body as string,
    }));

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system:
        "You are the Televo Assistant, a helpful AI chat contact inside the Televo messenger app. Keep replies conversational and reasonably concise, like a chat message rather than an essay.",
      messages: claudeMessages,
    }),
  });

  if (!claudeResponse.ok) {
    const errorText = await claudeResponse.text();
    console.error("Claude API error:", claudeResponse.status, errorText);
    return new Response("upstream error", { status: 502 });
  }

  const claudeData = await claudeResponse.json();
  const replyText = claudeData.content
    ?.filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("\n")
    .trim();

  if (!replyText) {
    console.error("Claude returned no text content:", JSON.stringify(claudeData));
    return new Response("empty reply", { status: 502 });
  }

  const { error: insertError } = await admin.from("messages").insert({
    conversation_id: message.conversation_id,
    sender_id: ASSISTANT_USER_ID,
    kind: "text",
    body: replyText,
  });

  if (insertError) {
    console.error("Failed to insert assistant reply:", insertError.message);
    return new Response("insert failed", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
