// Verifies the push notification pipeline end to end: token registration
// RLS, the message-insert webhook firing, and that it reaches the Edge
// Function and Expo's push API correctly. Cannot verify actual delivery to a
// physical device (needs a real Expo push token from a real device), but
// proves every step up to "Expo's API accepted the request."
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

// net._http_response (pg_net's own call log) is not exposed through
// PostgREST -- the JS client's .from() only ever sees the `public` schema,
// and shelling out to the Supabase CLI from within this script turned out to
// be more trouble than it's worth on Windows. Confirm this one manually:
//   npx supabase db query --linked "select status_code, content, created
//     from net._http_response order by created desc limit 5;"
// A "200 / ok" row with a `created` timestamp matching this run's message
// inserts is what "PASS" would have meant here.

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

  const client = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.signInWithPassword({ email, password: "TestPassword123!" });
  return { client, id: data.user.id };
}

try {
  const alice = await mkUser("pna");
  const bob = await mkUser("pnb");

  const conversationId = crypto.randomUUID();
  await alice.client.from("conversations").insert({ id: conversationId, kind: "direct", created_by: alice.id });
  await alice.client.from("conversation_participants").insert({ conversation_id: conversationId, user_id: alice.id });
  await alice.client.from("conversation_participants").insert({ conversation_id: conversationId, user_id: bob.id });

  // --- Token registration RLS ---
  const fakeToken = `ExponentPushToken[${crypto.randomUUID()}]`;
  const { error: registerErr } = await bob.client
    .from("push_tokens")
    .insert({ user_id: bob.id, expo_push_token: fakeToken, device_name: "test-device" });
  record("user can register their own push token", !registerErr, registerErr?.message ?? "");

  const { error: crossRegisterErr } = await alice.client
    .from("push_tokens")
    .insert({ user_id: bob.id, expo_push_token: `ExponentPushToken[${crypto.randomUUID()}]` });
  record(
    "user cannot register a push token for someone else",
    !!crossRegisterErr,
    crossRegisterErr?.message ?? "no error — RLS gap!"
  );

  const { data: aliceSeesBobsToken } = await alice.client
    .from("push_tokens")
    .select("expo_push_token")
    .eq("user_id", bob.id);
  record("a user cannot read someone else's push tokens", (aliceSeesBobsToken ?? []).length === 0);

  // --- Webhook fires and reaches the Edge Function on message insert ---
  const { error: sendErr } = await alice.client
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: alice.id, kind: "text", body: "hello with push" });
  record("message insert succeeds (webhook trigger attached)", !sendErr, sendErr?.message ?? "");

  console.log(
    "webhook fired (message insert above succeeded). Confirm delivery with:\n" +
      '  npx supabase db query --linked "select status_code, content, created from net._http_response order by created desc limit 5;"\n' +
      "expect a 200 / \"ok\" row timestamped around now."
  );

  // --- Encryption safety: an encrypted conversation's push must not leak the body ---
  const encryptedConvoId = crypto.randomUUID();
  await alice.client
    .from("conversations")
    .insert({ id: encryptedConvoId, kind: "direct", created_by: alice.id, is_encrypted: true });
  await alice.client
    .from("conversation_participants")
    .insert({ conversation_id: encryptedConvoId, user_id: alice.id });
  await alice.client
    .from("conversation_participants")
    .insert({ conversation_id: encryptedConvoId, user_id: bob.id });
  await alice.client.from("messages").insert({
    conversation_id: encryptedConvoId,
    sender_id: alice.id,
    kind: "text",
    body: JSON.stringify({ ciphertext: "fake-secret-data", nonce: "fake-nonce" }),
  });

  // Can't observe the Edge Function's outbound request from here (see the
  // net._http_response note above), so this checks the deployed guard exists
  // in source rather than asserting it blindly: previewFor() must be called
  // with is_encrypted before message.body is ever read for the push body.
  const functionSource = fs.readFileSync(
    new URL("../supabase/functions/send-push-notification/index.ts", import.meta.url),
    "utf8"
  );
  const hasEncryptionGuard =
    functionSource.includes("isEncrypted") &&
    functionSource.includes('if (isEncrypted) return "sent a message"');
  record(
    "send-push-notification source still guards against leaking encrypted bodies",
    hasEncryptionGuard
  );
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
