// The ONLY place a support_agent_queue row can turn into a real ban/unban.
//
// The operator's email links point at https://gettelevo.space/admin/review
// (a static page), which calls this function:
//   GET  ?token=…            → JSON summary of the pending request (no effect)
//   POST {token, decision}   → applies approve/reject
//
// Why not act on the link click itself, like the first version did: mail
// providers and security scanners (Gmail, Outlook Safe Links, antivirus
// gateways) open every link in an email automatically to check it, so a
// state-changing GET could approve a ban with nobody ever clicking. And
// Supabase serves Edge Function HTML as text/plain + nosniff, so an HTML
// confirmation page can't live here — it renders as raw markup.
//
// The action KIND (ban vs unban) is re-derived from proposed_action's fixed
// vocabulary ("lift the ban" is the only unban phrasing the agent writes);
// ban duration comes from apply_support_ban itself (support_ban_count), so
// a malformed queue row can at most pick ban-vs-unban for the already
// resolved target — never a duration or a different user.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://gettelevo.space";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let token: string | null = null;
  let decision: string | null = null;
  if (req.method === "GET") {
    token = new URL(req.url).searchParams.get("token");
  } else if (req.method === "POST") {
    try {
      const body = await req.json();
      token = typeof body.token === "string" ? body.token : null;
      decision = typeof body.decision === "string" ? body.decision : null;
    } catch {
      return json({ error: "bad_request" }, 400);
    }
  } else {
    return json({ error: "method_not_allowed" }, 405);
  }

  if (!token) return json({ error: "missing_token" }, 400);

  const { data: row } = await admin
    .from("support_agent_queue")
    .select("id, status, decided_at, from_email, intent, proposed_action, target_user_id, target_user_display_name, created_at")
    .eq("approval_token", token)
    .maybeSingle();

  if (!row) return json({ error: "not_found" }, 404);

  const summary = {
    status: row.status,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    fromEmail: row.from_email,
    intent: row.intent,
    proposedAction: row.proposed_action,
    targetUserId: row.target_user_id,
    targetDisplayName: row.target_user_display_name,
  };

  if (req.method === "GET") return json(summary);

  if (decision !== "approve" && decision !== "reject") {
    return json({ error: "invalid_decision" }, 400);
  }
  if (decision === "approve" && !row.target_user_id) {
    return json({ error: "no_target_user" }, 409);
  }

  // Claim the row atomically: only one request can move it off "pending",
  // so a double-click (or two open tabs) can't apply the ban twice and
  // skip a step of the 6h → 24h → permanent escalation.
  const { data: claimed } = await admin
    .from("support_agent_queue")
    .update({
      status: decision === "approve" ? "approved" : "rejected",
      decided_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id");

  if (!claimed || claimed.length === 0) {
    return json({ error: "already_handled", ...summary }, 409);
  }

  if (decision === "reject") return json({ ok: true, applied: "rejected" });

  const isUnban = String(row.proposed_action).toLowerCase().includes("lift");
  const { data: result, error } = isUnban
    ? await admin.rpc("apply_support_unban", { p_user_id: row.target_user_id })
    : await admin.rpc("apply_support_ban", {
        p_user_id: row.target_user_id,
        // The banned user sees this reason (BanScreen, and the support agent
        // quotes it back on appeal), so it must never carry the reporter's
        // address or the model's free-text read of their email — that would
        // tell the banned person exactly who reported them. The full request
        // stays in support_agent_queue for the operator.
        p_reason: "Violation of the community rules, confirmed after a report.",
      });

  if (error) {
    console.error("apply failed:", error.message);
    // Put it back so the operator can retry instead of being stuck with a
    // row marked approved that never actually took effect.
    await admin.from("support_agent_queue").update({ status: "pending", decided_at: null }).eq("id", row.id);
    return json({ error: "apply_failed", detail: error.message }, 500);
  }

  return json({ ok: true, applied: isUnban ? "unban" : "ban", result });
});
