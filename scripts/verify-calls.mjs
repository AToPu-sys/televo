// Verifies the calls table + signaling transport end to end against the live
// database. This cannot exercise the WebView's actual getUserMedia/WebRTC
// media path (that needs two real devices with camera/mic), but it proves
// everything React Native controls: call rows, RLS, and the broadcast
// channel that carries offer/answer/ICE signals.
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
  await client.auth.signInWithPassword({ email, password: "TestPassword123!" });
  await client.realtime.setAuth((await client.auth.getSession()).data.session.access_token);
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

  // 1. Caller creates the call row.
  const { data: call, error: callErr } = await a.client
    .from("calls")
    .insert({ conversation_id: conversationId, caller_id: a.id, kind: "video", status: "ringing" })
    .select("*")
    .single();
  record("caller creates call row", !callErr && !!call, callErr?.message ?? "");

  // 2. Callee (a real participant) can see it via RLS.
  const { data: bSees } = await b.client.from("calls").select("id").eq("id", call.id);
  record("participant sees the call via RLS", bSees?.length === 1);

  // 3. A non-participant must NOT see it.
  const { data: outsiderSees } = await outsider.client.from("calls").select("id").eq("id", call.id);
  record("non-participant blocked from call row", (outsiderSees ?? []).length === 0);

  // 4. Outsider cannot forge a call in this conversation (not a participant).
  const { error: forgeErr } = await outsider.client
    .from("calls")
    .insert({ conversation_id: conversationId, caller_id: outsider.id, kind: "audio" });
  record("outsider cannot start a call in the conversation", !!forgeErr, forgeErr?.message ?? "no error!");

  // 5. Full signal exchange over the per-call broadcast channel: offer -> answer -> ICE both ways.
  const exchangeOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    let calleeGotOffer = false;
    let callerGotAnswer = false;
    let calleeGotIce = false;

    const calleeChannel = b.client
      .channel(`call:${call.id}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "signal" }, ({ payload }) => {
        if (payload.type === "offer") {
          calleeGotOffer = true;
          void calleeChannel.send({
            type: "broadcast",
            event: "signal",
            payload: { type: "answer", sdp: "v=0 fake-answer-sdp" },
          });
        }
        if (payload.type === "ice-candidate") {
          calleeGotIce = true;
        }
        if (calleeGotOffer && callerGotAnswer && calleeGotIce) {
          clearTimeout(timer);
          resolve(true);
        }
      })
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;

        const callerChannel = a.client
          .channel(`call:${call.id}`, { config: { broadcast: { self: false } } })
          .on("broadcast", { event: "signal" }, ({ payload }) => {
            if (payload.type === "answer") {
              callerGotAnswer = true;
              void callerChannel.send({
                type: "broadcast",
                event: "signal",
                payload: { type: "ice-candidate", candidate: { candidate: "fake", sdpMid: "0" } },
              });
            }
            if (calleeGotOffer && callerGotAnswer && calleeGotIce) {
              clearTimeout(timer);
              resolve(true);
            }
          })
          .subscribe(async (callerStatus) => {
            if (callerStatus === "SUBSCRIBED") {
              await new Promise((r) => setTimeout(r, 500));
              await callerChannel.send({
                type: "broadcast",
                event: "signal",
                payload: { type: "offer", sdp: "v=0 fake-offer-sdp", kind: "video" },
              });
            }
          });
      });
  });
  record("offer/answer/ICE signal round trip over per-call channel", exchangeOk);

  // 6. Callee answers -> status flips to active, answered_at set.
  const { error: answerErr } = await b.client
    .from("calls")
    .update({ status: "active", answered_at: new Date().toISOString() })
    .eq("id", call.id);
  const { data: afterAnswer } = await a.client
    .from("calls")
    .select("status, answered_at")
    .eq("id", call.id)
    .single();
  record(
    "callee can mark call active",
    !answerErr && afterAnswer?.status === "active" && !!afterAnswer.answered_at
  );

  // 7. Either side can end it.
  const { error: endErr } = await a.client
    .from("calls")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", call.id);
  record("caller can end the call", !endErr);

  // 8. Ringing broadcast to the callee's personal calls:<userId> channel is
  // NOT how this implementation signals — verify instead that a fresh INSERT
  // on `calls` reaches the callee via postgres_changes (what useIncomingCalls
  // actually subscribes to).
  const ringOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 12000);
    const channel = b.client
      .channel("verify-incoming")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "calls" }, (payload) => {
        if (payload.new.conversation_id === conversationId && payload.new.caller_id === a.id) {
          clearTimeout(timer);
          resolve(true);
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          // postgres_changes takes longer to fully register server-side than
          // a broadcast subscription's SUBSCRIBED callback suggests.
          await new Promise((r) => setTimeout(r, 1500));
          await a.client
            .from("calls")
            .insert({ conversation_id: conversationId, caller_id: a.id, kind: "audio" });
        }
      });
  });
  record("callee is notified of a new call via realtime INSERT", ringOk);
} catch (error) {
  record("fatal", false, error.message);
  console.error(error);
} finally {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log(`\ncleaned up ${createdUserIds.length} test users`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
