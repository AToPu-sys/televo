// Verifies the group-chat, media-upload and delete paths against the live
// database, including the storage bucket policies.
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
  return { client, id: data.user.id };
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const a = await mkUser("ga");
  const b = await mkUser("gb");
  const c = await mkUser("gc");

  // --- Group chat creation (creator first, then members in bulk) ---
  const groupId = crypto.randomUUID();
  const { error: groupErr } = await a.client
    .from("conversations")
    .insert({ id: groupId, kind: "group", title: "Test Group", created_by: a.id });
  const { error: adminErr } = await a.client
    .from("conversation_participants")
    .insert({ conversation_id: groupId, user_id: a.id, is_admin: true });
  const { error: membersErr } = await a.client.from("conversation_participants").insert([
    { conversation_id: groupId, user_id: b.id },
    { conversation_id: groupId, user_id: c.id },
  ]);
  record(
    "create group with multiple members",
    !groupErr && !adminErr && !membersErr,
    groupErr?.message || adminErr?.message || membersErr?.message || ""
  );

  // Every member should see the group.
  const { data: bSees } = await b.client.from("conversations").select("title").eq("id", groupId);
  record("group visible to member", bSees?.[0]?.title === "Test Group");

  // Group messaging across three participants.
  await a.client
    .from("messages")
    .insert({ conversation_id: groupId, sender_id: a.id, kind: "text", body: "hi group" });
  await b.client
    .from("messages")
    .insert({ conversation_id: groupId, sender_id: b.id, kind: "text", body: "hey" });
  const { data: cSees } = await c.client
    .from("messages")
    .select("body")
    .eq("conversation_id", groupId);
  record("third member reads group thread", cSees?.length === 2, JSON.stringify(cSees?.map((m) => m.body)));

  // --- Media upload to chat-media (path must be <conversation_id>/<file>) ---
  // 1x1 PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const goodPath = `${groupId}/${crypto.randomUUID()}.png`;
  const { error: upErr } = await a.client.storage
    .from("chat-media")
    .upload(goodPath, png, { contentType: "image/png" });
  record("upload media to conversation folder", !upErr, upErr?.message ?? "");

  // A non-participant must not be able to upload into that conversation.
  const outsider = await mkUser("go");
  const { error: badUpErr } = await outsider.client.storage
    .from("chat-media")
    .upload(`${groupId}/${crypto.randomUUID()}.png`, png, { contentType: "image/png" });
  record("storage blocks non-participant upload", !!badUpErr, badUpErr?.message ?? "no error!");

  // Participants can sign/read the object; outsiders cannot.
  const { data: signed, error: signErr } = await b.client.storage
    .from("chat-media")
    .createSignedUrl(goodPath, 60);
  record("member can sign media URL", !!signed?.signedUrl && !signErr, signErr?.message ?? "");

  const { error: outSignErr } = await outsider.client.storage
    .from("chat-media")
    .createSignedUrl(goodPath, 60);
  record("storage blocks non-participant read", !!outSignErr, outSignErr?.message ?? "no error!");

  // Image message referencing the stored path.
  const { error: imgMsgErr } = await a.client
    .from("messages")
    .insert({ conversation_id: groupId, sender_id: a.id, kind: "image", media_url: goodPath });
  record("send image message", !imgMsgErr, imgMsgErr?.message ?? "");

  // --- Delete own message, and only your own ---
  const { data: mine } = await a.client
    .from("messages")
    .select("id")
    .eq("conversation_id", groupId)
    .eq("sender_id", a.id)
    .limit(1);
  const { error: delErr } = await a.client.from("messages").delete().eq("id", mine[0].id);
  const { data: afterDelete } = await a.client
    .from("messages")
    .select("id")
    .eq("id", mine[0].id);
  record("delete own message", !delErr && afterDelete?.length === 0, delErr?.message ?? "");

  const { data: bMsg } = await b.client
    .from("messages")
    .select("id")
    .eq("sender_id", b.id)
    .limit(1);
  await a.client.from("messages").delete().eq("id", bMsg[0].id);
  const { data: stillThere } = await b.client.from("messages").select("id").eq("id", bMsg[0].id);
  record("cannot delete someone else's message", stillThere?.length === 1);

  // --- Typing indicator transport (broadcast) ---
  const typingOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000);
    b.client
      .channel(`typing:${groupId}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "typing" }, () => {
        clearTimeout(timer);
        resolve(true);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await new Promise((r) => setTimeout(r, 600));
          const sender = a.client.channel(`typing:${groupId}`, {
            config: { broadcast: { self: false } },
          });
          sender.subscribe(async (s) => {
            if (s === "SUBSCRIBED") {
              await sender.send({
                type: "broadcast",
                event: "typing",
                payload: { userId: a.id, displayName: "ga user" },
              });
            }
          });
        }
      });
  });
  record("typing broadcast delivered", typingOk);
} catch (error) {
  record("fatal", false, error.message);
} finally {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log(`\ncleaned up ${createdUserIds.length} test users`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
