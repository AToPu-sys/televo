// Called by a Postgres webhook (see scripts/sql/010_ai_assistant_webhook.sql)
// whenever a new message lands in a conversation that includes the reserved
// assistant user (00000000-0000-0000-0000-000000000001) and was NOT sent by
// the assistant itself. Fetches recent history for context, calls the model
// (Groq, OpenAI-compatible API), and inserts the reply using the service-role
// key. The client never calls the model directly and never holds an API key.
//
// Groq rather than Anthropic since 2026-10-04: the Anthropic organization
// behind ANTHROPIC_API_KEY was disabled ("organization_on_hold"), so every
// reply here was silently the "assistant is unavailable" fallback.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ASSISTANT_USER_ID = "00000000-0000-0000-0000-000000000001";
const GROQ_MODEL = "openai/gpt-oss-120b";
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

/**
 * Posts a visible message into the assistant thread when a reply cannot be
 * generated. Without this the function just returned an error status and the
 * user was left staring at a chat that never answers — which reads as a
 * broken feature (and is an App Review failure under Guideline 2.1).
 */
async function postFallback(
  admin: ReturnType<typeof createClient>,
  conversationId: string,
  text: string
) {
  const { error } = await admin.from("messages").insert({
    conversation_id: conversationId,
    sender_id: ASSISTANT_USER_ID,
    kind: "text",
    body: text,
  });
  if (error) console.error("Failed to post assistant fallback:", error.message);
}

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
  const groqApiKey = Deno.env.get("GROQ_API_KEY");

  // The admin client is built BEFORE the key check so an unconfigured or
  // failing upstream can still post a visible reply rather than leaving the
  // user with a chat that silently never answers.
  const admin = createClient(supabaseUrl, serviceRoleKey);

  if (!groqApiKey) {
    console.error("GROQ_API_KEY is not configured");
    await postFallback(
      admin,
      message.conversation_id,
      "The assistant is unavailable right now. Everything else in Televo works normally — you can keep chatting and calling as usual."
    );
    return new Response("server not configured", { status: 500 });
  }

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
  const chatMessages = orderedHistory
    .filter((row) => row.body)
    .map((row) => ({
      role: row.sender_id === ASSISTANT_USER_ID ? "assistant" : "user",
      content: row.body as string,
    }));

  const modelResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      // Reasoning model: part of this budget goes to its hidden reasoning
      // before the visible reply, so it's higher than the reply itself needs.
      max_completion_tokens: 1536,
      messages: [
        {
          role: "system",
          content:
            "You are the Televo Assistant, a helpful AI chat contact inside the Televo messenger app. Reply in the language the user writes in. Keep replies conversational and reasonably concise, like a chat message rather than an essay.",
        },
        ...chatMessages,
      ],
    }),
  });

  if (!modelResponse.ok) {
    const errorText = await modelResponse.text();
    console.error("Groq API error:", modelResponse.status, errorText);
    await postFallback(
      admin,
      message.conversation_id,
      "The assistant is unavailable right now. Everything else in Televo works normally — you can keep chatting and calling as usual."
    );
    return new Response("upstream error", { status: 502 });
  }

  const modelData = await modelResponse.json();
  const replyText = (modelData.choices?.[0]?.message?.content ?? "").trim();

  if (!replyText) {
    console.error("Model returned no text content:", JSON.stringify(modelData));
    await postFallback(
      admin,
      message.conversation_id,
      "The assistant is unavailable right now. Everything else in Televo works normally — you can keep chatting and calling as usual."
    );
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
