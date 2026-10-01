// Called by a Postgres webhook (scripts/sql/058_waitlist_email_notify.sql,
// notify_new_waitlist_signup trigger) whenever a new row lands in the
// public.waitlist table (the gettelevo.space landing page's beta signup
// form). Sends the signer a short confirmation email via Resend, from the
// same @gettelevo.space sender already verified there for auth email
// (src/lib/supabase.ts's magic-link setup) and support-email-agent.
import "@supabase/functions-js/edge-runtime.d.ts";

const FROM = "Televo <hello@gettelevo.space>";

type WebhookPayload = {
  record: {
    email: string;
  };
};

Deno.serve(async (req) => {
  // FAIL CLOSED: a missing secret must reject, not skip the check. This
  // function sends email on behalf of gettelevo.space, so an unauthenticated
  // caller is a phishing/spam primitive — same posture as send-push-notification.
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

  const email = payload.record?.email;
  if (!email) {
    return new Response("ignored", { status: 200 });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) {
    console.error("RESEND_API_KEY is not configured");
    return new Response("server not configured", { status: 500 });
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: email,
      subject: "You're on the Televo beta list",
      html: `<p>Hi,</p>
<p>You're on the list for the Televo beta. We'll email this address the moment it's live on the App Store — no spam before then.</p>
<p>— Televo</p>`,
    }),
  });

  if (!response.ok) {
    console.error("Resend send failed:", response.status, await response.text());
    return new Response("email send failed", { status: 502 });
  }

  return new Response("ok", { status: 200 });
});
