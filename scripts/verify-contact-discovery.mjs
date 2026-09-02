// Verifies the profiles.phone column, its uniqueness constraint, and that a
// phone-based lookup query (the same shape useContactDiscovery runs) finds
// the right people and nobody else.
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
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

async function mkUser(tag, phone) {
  const email = `${tag}.${stamp}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
    user_metadata: { username: `${tag}${stamp}`.slice(0, 24), display_name: `${tag} user` },
  });
  if (error) throw error;
  createdUserIds.push(data.user.id);

  if (phone) {
    const { error: phoneErr } = await admin.from("profiles").update({ phone }).eq("id", data.user.id);
    if (phoneErr) throw phoneErr;
  }

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
  const alice = await mkUser("cda", "+15550001111");
  const bob = await mkUser("cdb", "+15550002222");
  const noPhone = await mkUser("cdc", null);

  // Duplicate phone must be rejected by the unique index.
  const { error: dupErr } = await admin.from("profiles").update({ phone: "+15550001111" }).eq("id", noPhone.id);
  record("duplicate phone number rejected", !!dupErr, dupErr?.message ?? "no error!");

  // SECURITY: the phone column must NOT be directly selectable — that was a
  // full reverse-lookup dump of every user's number to any client.
  const { error: directPhoneErr } = await alice.client
    .from("profiles")
    .select("id, phone")
    .not("phone", "is", null);
  record(
    "phone column is NOT directly selectable (no bulk enumeration)",
    !!directPhoneErr,
    directPhoneErr?.message ?? "LEAK: phone column still readable!"
  );

  // The supported path: hash the numbers already in your address book and
  // ask the server which of them are registered.
  const hashOf = (value) => createHash("sha256").update(value).digest("hex");

  const { data: matched, error: rpcErr } = await alice.client.rpc("match_contact_phones", {
    phone_hashes: [hashOf("+15550002222")],
  });
  if (rpcErr) throw rpcErr;

  record(
    "a contact you already have is discoverable via the hash RPC",
    matched?.some((row) => row.id === bob.id),
    JSON.stringify(matched?.map((r) => r.display_name))
  );
  record("caller's own profile excluded from results", !matched?.some((r) => r.id === alice.id));
  record("user with no phone set is excluded", !matched?.some((r) => r.id === noPhone.id));

  // A number you DON'T have in your contacts must return nothing — otherwise
  // the RPC would just be a slower way to enumerate the user base.
  const { data: unknownMatch } = await alice.client.rpc("match_contact_phones", {
    phone_hashes: [hashOf("+15559999999")],
  });
  record(
    "a number you don't already have returns no match",
    (unknownMatch ?? []).length === 0,
    JSON.stringify(unknownMatch)
  );
} catch (error) {
  record("fatal", false, error.message);
} finally {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log(`\ncleaned up ${createdUserIds.length} test users`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
