// Deletes chat-media storage objects for messages the expiry cron
// (032_expire_messages_cron.sql) is about to remove or has just removed.
//
// The cron only ever did `delete from messages` — it never touched Storage,
// because SQL alone can't call the Storage API (that's HTTP, not a table).
// So every self-destructing photo/video/document left its object sitting in
// the bucket forever: the row (and the promise "this disappears") vanished,
// the actual file did not. This mirrors the client-side deleteMessage path
// in src/hooks/useMessages.ts, which already deletes-object-then-row for a
// user-initiated delete — this is the same thing for the timer-based path.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Payload = { paths: string[] };

Deno.serve(async (req) => {
  const webhookSecret = Deno.env.get("WEBHOOK_SHARED_SECRET");
  if (!webhookSecret) {
    console.error("WEBHOOK_SHARED_SECRET is not configured — refusing to serve.");
    return new Response("server not configured", { status: 500 });
  }
  if (req.headers.get("x-webhook-secret") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const paths = (payload.paths ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
  if (paths.length === 0) {
    return new Response("nothing to remove", { status: 200 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Storage's remove() takes up to 1000 paths per call; chunk defensively
  // even though a single cron batch (capped at 5000 message rows) could in
  // principle produce more paths than that in one run.
  const CHUNK = 1000;
  let removed = 0;
  const errors: string[] = [];

  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const { data, error } = await admin.storage.from("chat-media").remove(chunk);
    if (error) {
      errors.push(error.message);
      continue;
    }
    removed += data?.length ?? 0;
  }

  if (errors.length > 0) {
    console.error("cleanup-expired-media: some removals failed:", errors.join(" | "));
  }

  return new Response(`removed ${removed}/${paths.length}`, { status: errors.length > 0 ? 207 : 200 });
});
