// Verifies the in-app AI assistant end to end: a new user automatically gets
// a pinned conversation with the assistant, a welcome message, and sending a
// real message triggers a real Claude API reply via the webhook + Edge
// Function pipeline.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const ASSISTANT_ID = "00000000-0000-0000-0000-000000000001";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  console.error("Set SUPABASE_SERVICE_ROLE_KEY to run this verification.");
  process.exit(2);
}

const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, serviceKey, { auth: { persistSession: false } });

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let userId = null;

try {
  const email = `aitest.${Date.now()}@example.com`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
    user_metadata: { username: `ai${Date.now()}`.slice(0, 24), display_name: "AI Test User" },
  });
  if (createErr) throw createErr;
  userId = created.user.id;

  // Give the profiles-insert trigger a moment to run (it's AFTER INSERT on
  // profiles, synchronous within the same transaction as the admin API call,
  // but the admin API call itself needs to fully settle).
  await new Promise((r) => setTimeout(r, 1000));

  const { data: participantRows } = await admin
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", userId);

  const conversationIds = (participantRows ?? []).map((r) => r.conversation_id);
  let assistantConversationId = null;

  for (const id of conversationIds) {
    const { data: hasAssistant } = await admin
      .from("conversation_participants")
      .select("user_id")
      .eq("conversation_id", id)
      .eq("user_id", ASSISTANT_ID)
      .maybeSingle();
    if (hasAssistant) {
      assistantConversationId = id;
      break;
    }
  }

  record("new user automatically gets an assistant conversation", !!assistantConversationId);

  if (assistantConversationId) {
    const { data: welcomeMsgs } = await admin
      .from("messages")
      .select("sender_id, body")
      .eq("conversation_id", assistantConversationId)
      .eq("sender_id", ASSISTANT_ID);

    record(
      "assistant conversation has a welcome message",
      (welcomeMsgs ?? []).length >= 1,
      JSON.stringify(welcomeMsgs?.map((m) => m.body?.slice(0, 40)))
    );

    // Send a real user message and wait for a real Claude reply via the
    // webhook -> Edge Function -> Claude API -> insert pipeline.
    const userClient = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await userClient.auth.signInWithPassword({ email, password: "TestPassword123!" });

    const testQuestion = "In one short sentence, what is 2+2?";
    const { error: sendErr } = await userClient.from("messages").insert({
      conversation_id: assistantConversationId,
      sender_id: userId,
      kind: "text",
      body: testQuestion,
    });
    record("user can send a message to the assistant", !sendErr, sendErr?.message ?? "");

    console.log("waiting up to 20s for the assistant's reply...");
    let replyFound = false;
    let replyText = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data: latest } = await admin
        .from("messages")
        .select("sender_id, body, created_at")
        .eq("conversation_id", assistantConversationId)
        .order("created_at", { ascending: false })
        .limit(3);

      const reply = (latest ?? []).find(
        (m) => m.sender_id === ASSISTANT_ID && m.body && !m.body.includes("Ask me anything")
      );
      if (reply) {
        replyFound = true;
        replyText = reply.body;
        break;
      }
    }

    record("assistant replies with a real Claude-generated message", replyFound, replyText ?? "no reply arrived in 20s");
  }
} catch (error) {
  record("fatal", false, error.message);
  console.error(error);
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  console.log("\ncleaned up test user");
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
