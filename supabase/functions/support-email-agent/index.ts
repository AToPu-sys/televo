// Reads an inbound support email (via Resend's Inbound webhook, pointed at
// support@gettelevo.space), decides what the sender is asking for using
// Claude, and — for ban/unban requests — writes a PROPOSED action to
// support_agent_queue instead of applying it. The operator gets an email
// with the draft reply and one-click approve/reject links; approving is
// what actually calls the ban/unban RPC (see approve-support-action).
//
// This function never has write access to user_moderation. That boundary is
// deliberate: an email inbox is reachable by anyone who can spoof or guess a
// From address, and a model's read of a support email is not a safe basis
// for an automatic account action on its own — see the moderate-report
// function's own reasoning for the same principle applied to abuse reports.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLAUDE_MODEL = "claude-haiku-4-5";
const OPERATOR_EMAIL = "ssirojov@gmail.com";
const SUPPORT_FROM = "Televo Support <support@gettelevo.space>";

// Resend's inbound webhook payload shape. Documented fields only; anything
// else in the payload is ignored.
type ResendInboundPayload = {
  type: string;
  data: {
    from: { email: string; name?: string };
    to: { email: string }[];
    subject?: string;
    text?: string;
    html?: string;
  };
};

type AgentDecision = {
  // What the sender is asking for, in the agent's own words — stored as-is,
  // never parsed back into an action. See support_agent_queue's own comment
  // for why the ACTUAL action is re-derived from structured fields instead.
  intent: string;
  // Structured action the agent is proposing, or null if this isn't a
  // ban/unban request at all (a general question, a bug report, etc.) — in
  // which case no queue row is created and the reply goes out immediately.
  action: null | {
    kind: "ban" | "unban";
    days: number | null; // null = permanent ban; ignored for unban
    targetEmail: string | null;
    targetUsername: string | null;
  };
  reply: string;
};

const SYSTEM_PROMPT = `You are the triage assistant for Televo's support inbox (support@gettelevo.space). Televo is an end-to-end encrypted messenger app.

You will be given the text of one inbound email. Your job is to:
1. Decide what the sender wants.
2. If — and only if — they are clearly asking to have a specific user banned, or to have a ban lifted (their own or someone else's), extract a structured action.
3. Draft a short, polite reply in Televo's support voice: plain, direct, no corporate filler, sentence case, active voice.

Rules:
- Never claim an action has been taken. Bans and unbans in your draft reply must be phrased as "we're reviewing this" or "we'll follow up" — a human always approves the actual change before it happens, and your reply is sent to the requester BEFORE that review completes.
- If the email does not name or otherwise clearly identify a specific person (an email address, a username, a full name you can point to), do not propose a ban/unban action — ask a clarifying question in the reply instead, and set action to null.
- If the email is not about banning/unbanning at all (a bug report, a general question, spam, abuse of the support address itself), set action to null and just draft a reasonable reply. If you cannot help at all, or the request needs human judgment beyond triage, say so honestly in the reply rather than guessing.
- Bans should default to temporary (7 days) unless the sender's own words clearly describe severe, repeated, or already-escalated abuse — only then propose permanent (days: null).
- Respond with a single JSON object matching this TypeScript type, and nothing else — no markdown fences, no commentary:

{
  "intent": string,
  "action": null | { "kind": "ban" | "unban", "days": number | null, "targetEmail": string | null, "targetUsername": string | null },
  "reply": string
}`;

async function sendEmail(resendApiKey: string, to: string, subject: string, html: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: SUPPORT_FROM, to, subject, html }),
  });
  if (!response.ok) {
    console.error("Resend send failed:", response.status, await response.text());
  }
}

Deno.serve(async (req) => {
  // Deployed with --no-verify-jwt: the caller is Resend's webhook, not a
  // Supabase-authenticated client. FAIL CLOSED on a missing shared secret —
  // this function spends Anthropic credit and can queue account actions, so
  // an unauthenticated caller is a real problem, not just noise.
  const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!webhookSecret) {
    console.error("RESEND_WEBHOOK_SECRET is not configured — refusing to serve.");
    return new Response("server not configured", { status: 500 });
  }
  // Resend signs inbound webhooks with svix headers; the shared secret is
  // checked directly on a custom header here rather than doing full svix
  // signature verification, matching the shared-secret pattern already used
  // by ai-assistant-reply and moderate-report in this same project.
  if (req.headers.get("x-webhook-secret") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);

  if (!anthropicApiKey || !resendApiKey) {
    console.error("ANTHROPIC_API_KEY or RESEND_API_KEY is not configured");
    return new Response("server not configured", { status: 500 });
  }

  let payload: ResendInboundPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("invalid payload", { status: 400 });
  }

  const inbound = payload.data;
  if (!inbound?.from?.email || !inbound.text) {
    return new Response("ignored (no body)", { status: 200 });
  }

  const fromEmail = inbound.from.email;
  const subject = inbound.subject ?? "(no subject)";
  const bodyText = inbound.text.slice(0, 8000); // guard against a pathological payload

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `From: ${fromEmail}\nSubject: ${subject}\n\n${bodyText}`,
        },
      ],
    }),
  });

  if (!claudeResponse.ok) {
    console.error("Claude API error:", claudeResponse.status, await claudeResponse.text());
    // Fail toward "a human sees it" rather than silence: forward the raw
    // email to the operator so a triage failure doesn't just vanish.
    await sendEmail(
      resendApiKey,
      OPERATOR_EMAIL,
      `[Support agent error] ${subject}`,
      `<p>The triage agent failed to process this email. Raw message below.</p><p><b>From:</b> ${fromEmail}</p><pre>${bodyText}</pre>`
    );
    return new Response("upstream error", { status: 502 });
  }

  const claudeData = await claudeResponse.json();
  const rawText = claudeData.content
    ?.filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("\n")
    .trim();

  let decision: AgentDecision;
  try {
    decision = JSON.parse(rawText);
  } catch {
    console.error("Could not parse agent decision:", rawText);
    await sendEmail(
      resendApiKey,
      OPERATOR_EMAIL,
      `[Support agent error] ${subject}`,
      `<p>The triage agent returned an unparseable response. Raw message below.</p><p><b>From:</b> ${fromEmail}</p><pre>${bodyText}</pre>`
    );
    return new Response("bad agent output", { status: 502 });
  }

  // Always reply to the sender with the drafted, honest ("we'll review
  // this") text — this happens regardless of whether an action was
  // proposed, so someone asking a plain question still gets an answer.
  await sendEmail(resendApiKey, fromEmail, `Re: ${subject}`, `<p>${decision.reply.replace(/\n/g, "<br>")}</p>`);

  if (!decision.action) {
    return new Response("handled (no action)", { status: 200 });
  }

  // Resolve the target user, if named. Email match is authoritative; a
  // username/display-name match is best-effort and only used if the email
  // didn't resolve — profiles can share a display name, so this is
  // surfaced to the operator to confirm, never auto-applied on a fuzzy
  // match alone.
  let targetUserId: string | null = null;
  let targetDisplayName: string | null = null;

  if (decision.action.targetEmail) {
    const { data: userByEmail } = await admin.auth.admin.listUsers();
    const match = userByEmail?.users.find(
      (u) => u.email?.toLowerCase() === decision.action!.targetEmail!.toLowerCase()
    );
    if (match) {
      targetUserId = match.id;
      const { data: profile } = await admin
        .from("profiles")
        .select("display_name")
        .eq("id", match.id)
        .maybeSingle();
      targetDisplayName = profile?.display_name ?? null;
    }
  }
  if (!targetUserId && decision.action.targetUsername) {
    const needle = decision.action.targetUsername.replace(/^@/, "");
    const { data: profile } = await admin
      .from("profiles")
      .select("id, display_name")
      .or(`username.eq.${needle},display_name.eq.${needle}`)
      .maybeSingle();
    if (profile) {
      targetUserId = profile.id;
      targetDisplayName = profile.display_name;
    }
  }

  const actionLabel =
    decision.action.kind === "ban"
      ? decision.action.days
        ? `ban for ${decision.action.days} day(s)`
        : "ban permanently"
      : "lift the ban";

  const { data: queued, error: queueError } = await admin
    .from("support_agent_queue")
    .insert({
      from_email: fromEmail,
      subject,
      body: bodyText,
      intent: decision.intent,
      target_user_id: targetUserId,
      target_user_display_name: targetDisplayName,
      proposed_action: actionLabel,
      proposed_reply: decision.reply,
    })
    .select("id, approval_token")
    .single();

  if (queueError || !queued) {
    console.error("Failed to queue support action:", queueError?.message);
    return new Response("failed to queue", { status: 500 });
  }

  const approveUrl = `${supabaseUrl}/functions/v1/approve-support-action?token=${queued.approval_token}&decision=approve`;
  const rejectUrl = `${supabaseUrl}/functions/v1/approve-support-action?token=${queued.approval_token}&decision=reject`;

  const identityLine = targetUserId
    ? `${targetDisplayName ?? "(no display name)"} — user ${targetUserId}`
    : `Could not confidently identify the user (email: ${decision.action.targetEmail ?? "—"}, username: ${decision.action.targetUsername ?? "—"}). Approving will fail until this is resolved manually.`;

  await sendEmail(
    resendApiKey,
    OPERATOR_EMAIL,
    `[Action needed] ${actionLabel} — ${fromEmail}`,
    `
      <p><b>From:</b> ${fromEmail}</p>
      <p><b>Subject:</b> ${subject}</p>
      <p><b>Agent's read:</b> ${decision.intent}</p>
      <p><b>Proposed action:</b> ${actionLabel}</p>
      <p><b>Target:</b> ${identityLine}</p>
      <hr>
      <p><b>Original message:</b></p>
      <pre>${bodyText}</pre>
      <hr>
      <p><a href="${approveUrl}">Approve</a> &nbsp;|&nbsp; <a href="${rejectUrl}">Reject</a></p>
      <p style="color:#888;font-size:12px;">This link expires once used. Nothing has been applied yet.</p>
    `
  );

  return new Response("queued for approval", { status: 200 });
});
