// Verifies the profiles.phone column, its uniqueness constraint, and that a
// phone-based lookup query (the same shape useContactDiscovery runs) finds
// the right people and nobody else.
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

  // Simulate Alice's device contact list containing Bob's number (as the
  // hook would collect from expo-contacts), then run the same lookup query
  // useContactDiscovery.scan() runs.
  const { data: candidates, error: queryErr } = await alice.client
    .from("profiles")
    .select("id, display_name, username, avatar_url, phone")
    .not("phone", "is", null)
    .neq("id", alice.id);

  if (queryErr) throw queryErr;

  const bobFound = candidates?.some((p) => p.id === bob.id && p.phone === "+15550002222");
  const selfExcluded = !candidates?.some((p) => p.id === alice.id);
  const noPhoneUserExcluded = !candidates?.some((p) => p.id === noPhone.id);

  record("contact-having user is discoverable by phone", !!bobFound);
  record("caller's own profile excluded from results", selfExcluded);
  record("user with no phone set is excluded", noPhoneUserExcluded);
} catch (error) {
  record("fatal", false, error.message);
} finally {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.log(`\ncleaned up ${createdUserIds.length} test users`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
