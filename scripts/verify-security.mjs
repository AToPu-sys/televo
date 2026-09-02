// Security regression tests for issues found in the 2026-09-02 audit.
// Each of these was a REAL, verified-exploitable defect at some point —
// these exist so they can't silently come back.
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
const FUNCTIONS_BASE = `${env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1`;

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const createdUserIds = [];

try {
  // === 1. Anonymous clients must not be able to read the user directory ===
  // The app's publishable key ships inside the binary and is trivially
  // extractable, so "anyone with the key" == "anyone".
  const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: anonProfiles } = await anon.from("profiles").select("id, username").limit(50);
  record(
    "anonymous client cannot enumerate profiles",
    (anonProfiles ?? []).length === 0,
    `got ${anonProfiles?.length ?? 0} rows`
  );

  // === 2. Even signed in, the phone column must not be bulk-readable ===
  const email = `sec.${Date.now()}@example.com`;
  const { data: created } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
    user_metadata: { username: `sec${Date.now()}`.slice(0, 24), display_name: "Sec Test" },
  });
  createdUserIds.push(created.user.id);

  const user = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  await user.auth.signInWithPassword({ email, password: "TestPassword123!" });

  const { error: phoneErr } = await user.from("profiles").select("phone").limit(1);
  record("signed-in user cannot select the phone column", !!phoneErr, phoneErr?.message ?? "LEAK");

  const { data: normalRead, error: normalErr } = await user
    .from("profiles")
    .select("id, display_name, username")
    .limit(3);
  record(
    "signed-in user CAN still read normal profile columns (fix didn't over-block)",
    !normalErr && (normalRead ?? []).length > 0,
    normalErr?.message ?? `${normalRead?.length} rows`
  );

  // === 3. Edge Functions must fail CLOSED, not open ===
  // Both are deployed with --no-verify-jwt, so the shared-secret header is
  // the only gate. An unauthenticated call must be rejected.
  for (const fn of ["ai-assistant-reply", "send-push-notification"]) {
    const response = await fetch(`${FUNCTIONS_BASE}/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        record: {
          id: crypto.randomUUID(),
          conversation_id: crypto.randomUUID(),
          sender_id: created.user.id,
          kind: "text",
          body: "unauthorized probe",
        },
      }),
    });
    record(`${fn} rejects an unauthenticated call`, response.status === 401, `status ${response.status}`);
  }

  // === 4. The rotated webhook secret must no longer be accepted ===
  const oldSecret = "the-rotated-pre-015-secret"; // real value removed before publishing
  const oldSecretResponse = await fetch(`${FUNCTIONS_BASE}/send-push-notification`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": oldSecret },
    body: JSON.stringify({ record: { id: "x", conversation_id: "x", sender_id: "x", kind: "text", body: "x" } }),
  });
  record(
    "the leaked/rotated webhook secret is rejected",
    oldSecretResponse.status === 401,
    `status ${oldSecretResponse.status}`
  );

  // === 5. Private secrets table must be unreachable from the client ===
  const { error: secretsErr } = await user.from("app_secrets").select("*").limit(1);
  record("private.app_secrets is not reachable via the API", !!secretsErr, secretsErr?.message ?? "LEAK");
} catch (error) {
  record("fatal", false, error.message);
  console.error(error);
} finally {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}
