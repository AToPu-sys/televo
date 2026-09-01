// Verifies the calls table RLS and the signaling broadcast channel against
// the live database. WebRTC media itself isn't exercised here (that needs a
// real device with a camera/mic) — this checks the parts that are shared
// infrastructure: call rows, permissions, and the signaling transport.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

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

const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, serviceKey, {
  auth: { persistSession: false },
});

const stamp = Date.now();
const createdUserIds = [];

async function mkUser(tag) {
  const email = `${tag}.${stamp}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
    user_metadata: { username: `${tag}${stamp}`.slice(0, 24), display_name: `${tag} user` },
  });
  if (error) throw error;
  createdUserIds.push(data.user.id);

  const client = createClient(
    env.EXPO_PUBLIC_SUPABASE_URL,
    env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data: signIn } = await client.auth.signInWithPassword({
    email,
    password: "TestPassword123!",
  });
  await client.realtime.setAuth(signIn.session.access_token);
  return { client, id: data.user.id };
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const a = await mkUser("ca");
  const b = await mkUser("cb");
  const outsider = await mkUser("co");

  const conversationId = crypto.randomUUID();
  await a.client
    .from("conversations")
    .insert({ id: conversationId, kind: "direct", created_by: a.id });
  await a.client
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: a.id });
  await a.client
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: b.id });

  // --- Call row creation ---
  const { data: call, error: callErr } = await a.client
    .from("calls")
    .insert({ conversation_id: conversationId, caller_id: a.id, kind: "video", status: "ringing" })
    .select("*")
    .single();
  record("caller creates call row", !callErr && !!call, callErr?.message ?? "");

  // Participant (callee) can see it.
  const { data: bSees } = await b.client.from("calls").select("id, status").eq("id", call.id);
  record("callee can see the ringing call", bSees?.[0]?.status === "ringing");

  // Outsider cannot.
  const { data: outsiderSees } = await outsider.client
    .from("calls")
    .select("id")
    .eq("id", call.id);
  record("non-participant cannot see the call", (outsiderSees ?? []).length === 0);

  // Callee answers: update status.
  const { error: answerErr } = await b.client
    .from("calls")
    .update({ status: "active", answered_at: new Date().toISOString() })
    .eq("id", call.id);
  record("callee can mark call active", !answerErr, answerErr?.message ?? "");

  // Outsider cannot update it.
  const { error: outsiderUpdateErr, data: outsiderUpdateData } = await outsider.client
    .from("calls")
    .update({ status: "ended" })
    .eq("id", call.id)
    .select();
  record(
    "non-participant cannot update the call",
    !outsiderUpdateErr && (outsiderUpdateData ?? []).length === 0
  );

  // Caller ends it.
  const { error: endErr } = await a.client
    .from("calls")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", call.id);
  record("caller can end the call", !endErr, endErr?.message ?? "");

  // --- Incoming-call realtime notification (postgres_changes on INSERT) ---
  const notifiedOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    b.client
      .channel("verify-incoming-calls")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "calls" }, (payload) => {
        if (payload.new.conversation_id === conversationId) {
          clearTimeout(timer);
          resolve(true);
        }
      })
      .subscribe(async (status, err) => {
        console.log("  [incoming-calls channel status]", status, err?.message ?? "");
        if (status === "SUBSCRIBED") {
          await new Promise((r) => setTimeout(r, 1000));
          const { error: insertErr } = await a.client.from("calls").insert({
            conversation_id: conversationId,
            caller_id: a.id,
            kind: "audio",
            status: "ringing",
          });
          if (insertErr) console.log("  [insert error]", insertErr.message);
        }
      });
  });
  record("callee is notified of a new incoming call via realtime", notifiedOk);

  // --- Signaling broadcast channel (offer/answer/ICE simulation) ---
  const signalId = crypto.randomUUID();
  const signalOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 12000);
    const received = [];
    b.client
      .channel(`call:${signalId}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "signal" }, ({ payload }) => {
        received.push(payload.type);
        if (received.includes("offer") && received.includes("ice-candidate")) {
          clearTimeout(timer);
          resolve(true);
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          const sender = a.client.channel(`call:${signalId}`, {
            config: { broadcast: { self: false } },
          });
          sender.subscribe(async (s) => {
            if (s === "SUBSCRIBED") {
              await new Promise((r) => setTimeout(r, 500));
              await sender.send({
                type: "broadcast",
                event: "signal",
                payload: { type: "offer", sdp: "v=0...", kind: "audio" },
              });
              await sender.send({
                type: "broadcast",
                event: "signal",
                payload: { type: "ice-candidate", candidate: { candidate: "fake" } },
              });
            }
          });
        }
      });
  });
  record("signaling broadcast delivers offer + ICE candidate", signalOk);
} catch (error) {
  record("fatal", false, error.message);
} finally {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log(`\ncleaned up ${createdUserIds.length} test users`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
