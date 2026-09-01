// End-to-end check of the messaging data layer against the live Supabase
// project, exercising the same RLS paths the app uses.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
);

const url = env.EXPO_PUBLIC_SUPABASE_URL;
const key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Admin key is passed in at run time (never stored in .env or committed). It is
// used ONLY to create pre-confirmed test users, because this project has email
// confirmation enabled with no SMTP configured, which blocks scripted sign-up.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  console.error("Set SUPABASE_SERVICE_ROLE_KEY in the environment to run this verification.");
  process.exit(2);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const alice = {
  email: `alice.${stamp}@example.com`,
  password: "TestPassword123!",
  username: `alice_${stamp}`.slice(0, 24),
  displayName: "Alice Tester",
};
const bob = {
  email: `bob.${stamp}@example.com`,
  password: "TestPassword123!",
  username: `bob_${stamp}`.slice(0, 24),
  displayName: "Bob Tester",
};

function client() {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const createdUserIds = [];

async function signUp(person) {
  // createUser with email_confirm goes through the same handle_new_user trigger
  // as a real sign-up, but skips the confirmation email this project can't send.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: person.email,
    password: person.password,
    email_confirm: true,
    user_metadata: { username: person.username, display_name: person.displayName },
  });
  if (createError) throw new Error(`createUser(${person.email}): ${createError.message}`);

  // From here on we use an ordinary anon-key client, so every query below is
  // subject to exactly the RLS the app runs under.
  const supabase = client();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: person.email,
    password: person.password,
  });
  if (signInError) throw new Error(`signIn(${person.email}): ${signInError.message}`);

  createdUserIds.push(created.user.id);
  return { supabase, userId: created.user.id };
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  // 1. Sign up two users; the handle_new_user trigger should create profiles.
  const a = await signUp(alice);
  const b = await signUp(bob);
  record("sign up two users", true, `${a.userId.slice(0, 8)} / ${b.userId.slice(0, 8)}`);

  const { data: aliceProfile } = await a.supabase
    .from("profiles")
    .select("username, display_name")
    .eq("id", a.userId)
    .single();
  record(
    "profile auto-created by trigger",
    aliceProfile?.display_name === alice.displayName,
    aliceProfile ? `${aliceProfile.display_name} @${aliceProfile.username}` : "no profile row"
  );

  // 2. Alice can see Bob in the contacts directory.
  const { data: visible } = await a.supabase.from("profiles").select("id").eq("id", b.userId);
  record("contacts directory shows other user", (visible ?? []).length === 1);

  // 3. Alice creates a direct conversation and adds both participants.
  // Client-generated id: .select() here would trigger INSERT ... RETURNING,
  // which the SELECT policy rejects until participant rows exist.
  const conversation = { id: crypto.randomUUID() };
  const { error: convError } = await a.supabase
    .from("conversations")
    .insert({ id: conversation.id, kind: "direct", created_by: a.userId });
  if (convError) throw new Error(`create conversation: ${convError.message}`);

  const { error: selfErr } = await a.supabase
    .from("conversation_participants")
    .insert({ conversation_id: conversation.id, user_id: a.userId });
  const { error: otherErr } = await a.supabase
    .from("conversation_participants")
    .insert({ conversation_id: conversation.id, user_id: b.userId });
  record(
    "create chat and add both participants (RLS order)",
    !selfErr && !otherErr,
    selfErr?.message || otherErr?.message || ""
  );

  // 4. Alice sends a message.
  const { error: sendError } = await a.supabase.from("messages").insert({
    conversation_id: conversation.id,
    sender_id: a.userId,
    kind: "text",
    body: "Hello from Alice",
  });
  record("alice sends a message", !sendError, sendError?.message ?? "");

  // 5. Bob can read it (RLS lets participants view).
  const { data: bobView, error: bobError } = await b.supabase
    .from("messages")
    .select("body")
    .eq("conversation_id", conversation.id);
  record(
    "bob reads alice's message",
    !bobError && bobView?.[0]?.body === "Hello from Alice",
    bobError?.message ?? `saw: ${JSON.stringify(bobView?.map((m) => m.body))}`
  );

  // 6. Bob replies; Alice sees both.
  await b.supabase.from("messages").insert({
    conversation_id: conversation.id,
    sender_id: b.userId,
    kind: "text",
    body: "Hi Alice!",
  });
  const { data: thread } = await a.supabase
    .from("messages")
    .select("body")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true });
  record("two-way thread", thread?.length === 2, JSON.stringify(thread?.map((m) => m.body)));

  // 7. A third party must NOT see this conversation.
  const outsider = await signUp({
    email: `eve.${stamp}@example.com`,
    password: "TestPassword123!",
    username: `eve_${stamp}`.slice(0, 24),
    displayName: "Eve Outsider",
  });
  const { data: leaked } = await outsider.supabase
    .from("messages")
    .select("body")
    .eq("conversation_id", conversation.id);
  record("RLS blocks non-participant", (leaked ?? []).length === 0, `leaked ${leaked?.length ?? 0}`);

  // 8. Realtime delivery. The socket needs its own auth — it does not inherit
  // the REST client's session, and RLS applies to realtime too.
  const bobSession = (await b.supabase.auth.getSession()).data.session;
  await b.supabase.realtime.setAuth(bobSession.access_token);

  const realtimeOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);

    b.supabase
      .channel(`verify:${conversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        () => {
          clearTimeout(timer);
          resolve(true);
        }
      )
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          // Give the server a moment to register the filter before writing.
          await new Promise((r) => setTimeout(r, 800));
          await a.supabase.from("messages").insert({
            conversation_id: conversation.id,
            sender_id: a.userId,
            kind: "text",
            body: "Realtime ping",
          });
        }
      });
  });
  record("realtime INSERT delivered to other user", realtimeOk);

  // 9. Unread tracking via last_read_at.
  const { error: readError } = await b.supabase
    .from("conversation_participants")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", conversation.id)
    .eq("user_id", b.userId);
  record("mark conversation read", !readError, readError?.message ?? "");
} catch (error) {
  record("fatal", false, error.message);
} finally {
  // Remove the test users (cascades to their profiles, participants, messages)
  // so this shared project isn't left with verification junk.
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  console.log(`\ncleaned up ${createdUserIds.length} test users`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
