// Verifies the encryption hardening: group key wrapping, and that media
// bytes are genuinely stored as ciphertext the server cannot read.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const { decodeBase64, encodeBase64 } = naclUtil;

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
  console.error("Set SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}

const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, serviceKey, { auth: { persistSession: false } });
const results = [];
const created = [];

function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function mkUser(tag) {
  const email = `${tag}.${Date.now()}@example.com`;
  const { data } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
    user_metadata: { username: `${tag}${Date.now()}`.slice(0, 24), display_name: tag },
  });
  created.push(data.user.id);

  const pair = nacl.box.keyPair();
  const publicKey = encodeBase64(pair.publicKey);
  await admin.from("profiles").update({ e2e_public_key: publicKey }).eq("id", data.user.id);

  const client = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password: "TestPassword123!" });
  return { client, id: data.user.id, publicKey, secretKey: encodeBase64(pair.secretKey) };
}

try {
  const alice = await mkUser("ea");
  const bob = await mkUser("eb");
  const carol = await mkUser("ec");

  // --- Group encryption: one key wrapped to all three members ---
  const groupId = crypto.randomUUID();
  await alice.client.from("conversations").insert({ id: groupId, kind: "group", title: "Secret Group", created_by: alice.id });
  for (const member of [alice, bob, carol]) {
    await alice.client.from("conversation_participants").insert({ conversation_id: groupId, user_id: member.id });
  }

  const sessionKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const rows = [alice, bob, carol].map((member) => {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const boxed = nacl.box(sessionKey, nonce, decodeBase64(member.publicKey), decodeBase64(alice.secretKey));
    return {
      conversation_id: groupId,
      recipient_id: member.id,
      sender_public_key: alice.publicKey,
      encrypted_key: encodeBase64(boxed),
      nonce: encodeBase64(nonce),
    };
  });

  await alice.client.from("conversations").update({ is_encrypted: true }).eq("id", groupId);
  const { error: keysErr } = await alice.client.from("encrypted_session_keys").insert(rows);
  record("group: session key wrapped for every member", !keysErr, keysErr?.message ?? "3 members");

  // Carol unwraps HER copy and gets the same key.
  const { data: carolRow } = await carol.client
    .from("encrypted_session_keys")
    .select("encrypted_key, nonce, sender_public_key")
    .eq("conversation_id", groupId)
    .eq("recipient_id", carol.id)
    .single();

  const carolKey = carolRow
    ? nacl.box.open(
        decodeBase64(carolRow.encrypted_key),
        decodeBase64(carolRow.nonce),
        decodeBase64(carolRow.sender_public_key),
        decodeBase64(carol.secretKey)
      )
    : null;

  record(
    "group: a member unwraps the same session key",
    !!carolKey && Buffer.from(carolKey).equals(Buffer.from(sessionKey))
  );

  // A member cannot fetch someone else's wrapped copy.
  const { data: stolen } = await carol.client
    .from("encrypted_session_keys")
    .select("encrypted_key")
    .eq("conversation_id", groupId)
    .eq("recipient_id", bob.id);
  record("group: members can't read each other's wrapped keys", (stolen ?? []).length === 0);

  // --- Media encryption: what actually lands in storage ---
  const secretImage = new TextEncoder().encode("SECRET_IMAGE_PIXELS_1234567890");
  const mediaNonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encryptedMedia = nacl.secretbox(secretImage, mediaNonce, sessionKey);

  const path = `${groupId}/${crypto.randomUUID()}.jpg`;
  const { error: upErr } = await alice.client.storage
    .from("chat-media")
    .upload(path, encryptedMedia, { contentType: "application/octet-stream" });
  record("media: encrypted upload accepted", !upErr, upErr?.message ?? "");

  // Read it back with the SERVICE ROLE (bypasses all RLS — this is "the
  // server"). It must not contain the plaintext.
  const { data: blob } = await admin.storage.from("chat-media").download(path);
  const stored = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
  const storedText = new TextDecoder().decode(stored);

  record(
    "media: stored bytes do NOT contain the plaintext (server can't read it)",
    !storedText.includes("SECRET_IMAGE_PIXELS"),
    `first bytes: ${storedText.slice(0, 24).replace(/[^\x20-\x7e]/g, ".")}`
  );

  const roundTripped = nacl.secretbox.open(stored, mediaNonce, sessionKey);
  record(
    "media: a member with the key decrypts it back exactly",
    !!roundTripped && new TextDecoder().decode(roundTripped) === "SECRET_IMAGE_PIXELS_1234567890"
  );

  await admin.storage.from("chat-media").remove([path]);
} catch (error) {
  record("fatal", false, error.message);
  console.error(error);
} finally {
  for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
