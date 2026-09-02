// Verifies the Telegram-2016 feature batch against the live database:
// message edit/reply, block enforcement (the real point -- server-side, not
// just UI), and self-destruct cleanup permissions.
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

const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, serviceKey, { auth: { persistSession: false } });

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

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const alice = await mkUser("tfa");
  const bob = await mkUser("tfb");

  const conversationId = crypto.randomUUID();
  await alice.client.from("conversations").insert({ id: conversationId, kind: "direct", created_by: alice.id });
  await alice.client.from("conversation_participants").insert({ conversation_id: conversationId, user_id: alice.id });
  await alice.client.from("conversation_participants").insert({ conversation_id: conversationId, user_id: bob.id });

  // --- Reply ---
  const { data: original } = await alice.client
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: alice.id, kind: "text", body: "original message" })
    .select("id")
    .single();

  const { error: replyErr } = await bob.client
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: bob.id, kind: "text", body: "a reply", reply_to_id: original.id });
  record("reply references another message", !replyErr, replyErr?.message ?? "");

  // --- Edit: own message succeeds, someone else's is rejected ---
  const { error: ownEditErr } = await alice.client
    .from("messages")
    .update({ body: "edited by alice", edited_at: new Date().toISOString() })
    .eq("id", original.id);
  record("sender can edit their own message", !ownEditErr, ownEditErr?.message ?? "");

  const { data: afterEdit } = await bob.client.from("messages").select("body, edited_at").eq("id", original.id).single();
  record("edit is visible to the other participant", afterEdit?.body === "edited by alice" && !!afterEdit?.edited_at);

  const { error: crossEditErr } = await bob.client
    .from("messages")
    .update({ body: "bob trying to edit alice's message" })
    .eq("id", original.id);
  const { data: stillAlicesBody } = await alice.client.from("messages").select("body").eq("id", original.id).single();
  record(
    "non-sender cannot edit someone else's message",
    stillAlicesBody?.body === "edited by alice",
    `error: ${crossEditErr?.message ?? "none (silently no-opped, which is also correct)"}`
  );

  // --- Forward attribution ---
  const { error: forwardErr } = await bob.client.from("messages").insert({
    conversation_id: conversationId,
    sender_id: bob.id,
    kind: "text",
    body: "edited by alice",
    forwarded_from_message_id: original.id,
    forwarded_from_sender_id: alice.id,
  });
  record("forward with attribution succeeds", !forwardErr, forwardErr?.message ?? "");

  // --- Document kind + fields ---
  const { error: docErr } = await alice.client.from("messages").insert({
    conversation_id: conversationId,
    sender_id: alice.id,
    kind: "document",
    media_url: `${conversationId}/documents/fake-report.pdf`,
    document_name: "report.pdf",
    document_size_bytes: 123456,
  });
  record("document message with metadata succeeds", !docErr, docErr?.message ?? "");

  // --- Blocking: real enforcement, not just a UI hide ---
  const { error: blockErr } = await bob.client.from("blocked_users").insert({ blocker_id: bob.id, blocked_id: alice.id });
  record("bob blocks alice", !blockErr, blockErr?.message ?? "");

  const { error: blockedSendErr } = await alice.client
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: alice.id, kind: "text", body: "can you see this?" });
  record(
    "alice CANNOT send a message after being blocked (server-enforced)",
    !!blockedSendErr,
    blockedSendErr?.message ?? "no error — block was NOT enforced!"
  );

  // Blocking is bidirectional (matches real Telegram): the blocker is also
  // stopped from messaging the person they blocked, until they unblock.
  const { error: blockerSendErr } = await bob.client
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: bob.id, kind: "text", body: "bob trying to send" });
  record(
    "blocking is bidirectional — blocker is also stopped",
    !!blockerSendErr,
    blockerSendErr?.message ?? "no error — blocker could still send!"
  );

  // Unblock restores the ability to send.
  await bob.client.from("blocked_users").delete().eq("blocker_id", bob.id).eq("blocked_id", alice.id);
  const { error: afterUnblockErr } = await alice.client
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: alice.id, kind: "text", body: "unblocked now" });
  record("unblocking restores the ability to send", !afterUnblockErr, afterUnblockErr?.message ?? "");

  // A stranger can't probe is_blocked_between as a public RPC.
  const stranger = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { error: rpcErr } = await stranger.rpc("is_blocked_between", { user_a: alice.id, user_b: bob.id });
  record("is_blocked_between is not callable by anon", !!rpcErr, rpcErr?.message ?? "no error — RPC exposed to anon!");

  // --- Self-destruct: expired message deletable by any participant ---
  const { data: expiring } = await alice.client
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: alice.id,
      kind: "text",
      body: "self destructs",
      expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
    })
    .select("id")
    .single();

  const { error: cleanupErr } = await bob.client.from("messages").delete().eq("id", expiring.id);
  record("participant (not sender) can delete an EXPIRED message", !cleanupErr, cleanupErr?.message ?? "");

  const { data: notExpiring } = await alice.client
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: alice.id,
      kind: "text",
      body: "not expired yet",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    .select("id")
    .single();

  const { error: prematureDeleteErr } = await bob.client.from("messages").delete().eq("id", notExpiring.id);
  const { data: stillThere } = await alice.client.from("messages").select("id").eq("id", notExpiring.id);
  record(
    "participant CANNOT delete a not-yet-expired message that isn't theirs",
    (stillThere ?? []).length === 1,
    (stillThere ?? []).length === 1
      ? `blocked as expected: ${prematureDeleteErr?.message}`
      : "BUG: row was deleted early!"
  );

  // --- Privacy columns exist and are writable by the owner ---
  const { error: privacyErr } = await alice.client
    .from("profiles")
    .update({ show_last_seen: false, show_read_receipts: false })
    .eq("id", alice.id);
  record("privacy toggles are writable", !privacyErr, privacyErr?.message ?? "");
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
