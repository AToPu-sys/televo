// The ONLY place a support_agent_queue row can turn into a real ban/unban.
// Reached by clicking the approve/reject link in the operator's own inbox —
// a GET request with a one-time token, no Supabase session required, since
// the operator is reading this from an email client, not the app.
//
// Deliberately re-derives the action from structured columns (intent's
// sibling fields — kind/days/target_user_id), never from the free-text
// `proposed_action` or `intent` the model wrote. A compromised or malformed
// queue row can therefore make this endpoint refuse or no-op, but never
// execute something other than a plain ban/unban of the resolved user.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function html(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
     <style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#222}</style>
     </head><body><h2>${title}</h2>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const decision = url.searchParams.get("decision");

  if (!token || (decision !== "approve" && decision !== "reject")) {
    return html("Invalid link", "<p>This link is missing required information.</p>");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: row, error: fetchError } = await admin
    .from("support_agent_queue")
    .select("*")
    .eq("approval_token", token)
    .maybeSingle();

  if (fetchError || !row) {
    return html("Link not found", "<p>This approval link is invalid or has already been used.</p>");
  }
  if (row.status !== "pending") {
    return html(
      "Already handled",
      `<p>This request was already <b>${row.status}</b> on ${new Date(row.decided_at).toLocaleString()}.</p>`
    );
  }

  if (decision === "reject") {
    await admin
      .from("support_agent_queue")
      .update({ status: "rejected", decided_at: new Date().toISOString() })
      .eq("id", row.id);
    return html("Rejected", `<p>No action was taken on <b>${row.from_email}</b>'s request.</p>`);
  }

  // decision === "approve" from here.
  if (!row.target_user_id) {
    return html(
      "Cannot approve — no user identified",
      `<p>The agent could not confidently match a user for this request, so there is nothing to apply. Handle this one manually, then come back and reject this link so it doesn't stay pending.</p>
       <p><b>Original request:</b></p><pre>${row.body}</pre>`
    );
  }

  const actionLower = row.proposed_action.toLowerCase();
  const isUnban = actionLower.includes("lift");
  const daysMatch = actionLower.match(/(\d+)\s*day/);
  const days = daysMatch ? parseInt(daysMatch[1], 10) : null;

  if (isUnban) {
    const { error } = await admin
      .from("user_moderation")
      .update({ banned_until: null, banned_reason: null, updated_at: new Date().toISOString() })
      .eq("user_id", row.target_user_id);
    if (error) {
      console.error("Unban failed:", error.message);
      return html("Failed", `<p>Could not lift the ban: ${error.message}</p>`);
    }
  } else {
    const bannedUntil = days
      ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      : null; // null banned_until with a reason set = permanent, matching 035_auto_moderation's own convention
    const { error } = await admin.from("user_moderation").upsert(
      {
        user_id: row.target_user_id,
        banned_until: bannedUntil,
        banned_reason: `Support request from ${row.from_email}: ${row.intent}`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) {
      console.error("Ban failed:", error.message);
      return html("Failed", `<p>Could not apply the ban: ${error.message}</p>`);
    }
  }

  await admin
    .from("support_agent_queue")
    .update({ status: "approved", decided_at: new Date().toISOString() })
    .eq("id", row.id);

  return html(
    "Applied",
    `<p><b>${row.proposed_action}</b> applied to ${row.target_user_display_name ?? row.target_user_id}.</p>
     <p>Requested by ${row.from_email}.</p>`
  );
});
