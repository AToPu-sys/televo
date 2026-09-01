// Verifies that marking a chat read on "device A" is visible via realtime on
// "device B" signed into the same account -- the multi-device sync path.
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
  return { email, id: data.user.id };
}

// Two independent clients signed into the SAME account -- simulating two
// devices, exactly the scenario the app needs to handle.
async function signInAsDevice(email) {
  const client = createClient(
    env.EXPO_PUBLIC_SUPABASE_URL,
    env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data } = await client.auth.signInWithPassword({ email, password: "TestPassword123!" });
  await client.realtime.setAuth(data.session.access_token);
  return client;
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const alice = await mkUser("sa");
  const bob = await mkUser("sb");

  const deviceA = await signInAsDevice(alice.email);
  const deviceB = await signInAsDevice(alice.email); // same account, second client
  const bobClient = await signInAsDevice(bob.email);

  const conversationId = crypto.randomUUID();
  await deviceA
    .from("conversations")
    .insert({ id: conversationId, kind: "direct", created_by: alice.id });
  await deviceA
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: alice.id });
  await deviceA
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: bob.id });

  await bobClient
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: bob.id, kind: "text", body: "hi" });

  // Device B subscribes to its own participant-row updates, exactly like
  // useChats does, scoped with user_id=eq.<alice.id>.
  const syncedOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    deviceB
      .channel("verify-sync")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversation_participants",
          filter: `user_id=eq.${alice.id}`,
        },
        (payload) => {
          if (payload.new.conversation_id === conversationId && payload.new.last_read_at) {
            clearTimeout(timer);
            resolve(true);
          }
        }
      )
      .subscribe(async (status, err) => {
        console.log("  [device B channel]", status, err?.message ?? "");
        if (status === "SUBSCRIBED") {
          await new Promise((r) => setTimeout(r, 1000));
          // Sanity check right before the update: is the row even there from
          // device A's point of view at this moment?
          const { data: check } = await deviceA
            .from("conversation_participants")
            .select("*")
            .eq("conversation_id", conversationId)
            .eq("user_id", alice.id);
          console.log("  [device A pre-update check]", JSON.stringify(check));

          // Device A marks the chat read.
          const { error: updErr, data: updData, status } = await deviceA
            .from("conversation_participants")
            .update({ last_read_at: new Date().toISOString() })
            .eq("conversation_id", conversationId)
            .eq("user_id", alice.id)
            .select();
          console.log("  [device A update]", status, updErr?.message ?? "ok", JSON.stringify(updData));
        }
      });
  });
  record("read-state marked on device A is pushed live to device B", syncedOk);

  // Sanity: Bob's own read-state channel must NOT fire from Alice's update
  // (the filter should isolate it to the row's own owner).
  const bobLeak = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    bobClient
      .channel("verify-sync-bob")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversation_participants",
          filter: `user_id=eq.${bob.id}`,
        },
        () => {
          clearTimeout(timer);
          resolve(true);
        }
      )
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await new Promise((r) => setTimeout(r, 1000));
          await deviceA
            .from("conversation_participants")
            .update({ last_read_at: new Date().toISOString() })
            .eq("conversation_id", conversationId)
            .eq("user_id", alice.id);
        }
      });
  });
  record("bob's channel is not notified by alice's read-state update", !bobLeak);
} catch (error) {
  record("fatal", false, error.message);
} finally {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log(`\ncleaned up ${createdUserIds.length} test users`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
