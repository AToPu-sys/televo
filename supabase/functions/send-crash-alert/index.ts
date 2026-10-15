// Called by a Postgres webhook (scripts/sql/071_crash_alert_notify.sql,
// notify_new_crash_report trigger) whenever a FATAL client crash report
// lands in public.client_crash_reports (src/lib/crashReporter.ts). Sends the
// operator a short email so a crash is seen the day it happens instead of
// sitting unread in a table nobody queries — mirrors send-waitlist-email's
// own webhook-secret auth and Resend send.
import "@supabase/functions-js/edge-runtime.d.ts";
import { renderEmail } from "./emailTemplate.ts";

const FROM = "Televo <hello@gettelevo.space>";
// Set with `supabase secrets set OPERATOR_EMAIL=...`; kept out of the public repo.
const OPERATOR_EMAIL = Deno.env.get("OPERATOR_EMAIL") ?? "";

type WebhookPayload = {
  record: {
    id: number;
    user_id: string | null;
    occurred_at: string;
    platform: string;
    app_version: string | null;
    build_number: string | null;
    message: string;
    stack: string | null;
    screen: string | null;
  };
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

Deno.serve(async (req) => {
  // FAIL CLOSED — same posture as send-waitlist-email: an unauthenticated
  // caller must not be able to make this function send mail on our behalf.
  const webhookSecret = Deno.env.get("WEBHOOK_SHARED_SECRET");
  if (!webhookSecret) {
    console.error("WEBHOOK_SHARED_SECRET is not configured — refusing to serve.");
    return new Response("server not configured", { status: 500 });
  }
  if (req.headers.get("x-webhook-secret") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const report = payload.record;
  if (!report) {
    return new Response("ignored", { status: 200 });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) {
    console.error("RESEND_API_KEY is not configured");
    return new Response("server not configured", { status: 500 });
  }

  const build = [report.platform, report.app_version, report.build_number]
    .filter(Boolean)
    .join(" · ");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: OPERATOR_EMAIL,
      subject: `Crash: ${report.message.slice(0, 80)}`,
      html: renderEmail({
        preheader: `Fatal crash on ${build || "unknown build"}`,
        heading: "A fatal crash just landed",
        bodyHtml: `
<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 16px; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#1A1414;">
  <tr><td style="padding:4px 0; color:#6B6460; width:120px;">Occurred</td><td style="padding:4px 0;">${escapeHtml(report.occurred_at)}</td></tr>
  <tr><td style="padding:4px 0; color:#6B6460;">Build</td><td style="padding:4px 0;">${escapeHtml(build || "unknown")}</td></tr>
  <tr><td style="padding:4px 0; color:#6B6460;">Screen</td><td style="padding:4px 0;">${escapeHtml(report.screen ?? "unknown")}</td></tr>
  <tr><td style="padding:4px 0; color:#6B6460;">User</td><td style="padding:4px 0;">${escapeHtml(report.user_id ?? "not signed in")}</td></tr>
  <tr><td style="padding:4px 0; color:#6B6460;">Report id</td><td style="padding:4px 0;">${report.id}</td></tr>
</table>
<p style="margin:0 0 8px; font-weight:700;">${escapeHtml(report.message)}</p>
${report.stack ? `<pre style="margin:0; padding:12px; background:#F4F1EA; border-radius:8px; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word; color:#1A1414;">${escapeHtml(report.stack.slice(0, 4000))}</pre>` : ""}`,
      }),
    }),
  });

  if (!response.ok) {
    console.error("Resend send failed:", response.status, await response.text());
    return new Response("email send failed", { status: 502 });
  }

  return new Response("ok", { status: 200 });
});
