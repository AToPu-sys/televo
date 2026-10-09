// Manual one-shot broadcast: "Televo is live on the App Store" to everyone
// on the gettelevo.space waitlist (public.waitlist) who hasn't already
// received it. Not wired to any trigger — call it by hand (curl or
// `supabase functions invoke`) once the App Store listing is actually live,
// with the real App Store URL as `appStoreUrl` in the request body.
//
// Safe to re-run: launch_notified_at (058_waitlist_launch_notified.sql)
// marks each row as soon as its email send succeeds, so a second run (after
// a partial failure, or to catch late signups) only emails whoever is still
// unmarked. Sends are throttled with a short delay between each — Resend's
// free/low tiers rate-limit bursts, and a waitlist can run into the
// thousands by launch day.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { renderEmail } from "./emailTemplate.ts";

const FROM = "Televo <hello@gettelevo.space>";
const BATCH_SIZE = 50;
const DELAY_BETWEEN_SENDS_MS = 150;

type RequestBody = {
  appStoreUrl: string;
  // Defaults to false. true sends to everyone regardless of
  // launch_notified_at — for re-sending after a copy fix, not routine use.
  resendAll?: boolean;
};

async function sendOne(resendApiKey: string, email: string, appStoreUrl: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: email,
      subject: "Televo is live on the App Store",
      html: renderEmail({
        preheader: "The wait is over — Televo is available on the App Store now.",
        heading: "We're live.",
        bodyHtml: `<p style="margin:0 0 14px;">Thanks for waiting. Televo is now available on the App Store — the same private messenger you signed up for.</p>
<p style="margin:0;">Tap below to get it, free.</p>`,
        ctaLabel: "Get Televo on the App Store",
        ctaUrl: appStoreUrl,
        features: [
          {
            icon: "🔒",
            title: "Secret Chats only you can read",
            body: "Keys are generated on your phone and never touch our servers — not even we can read them.",
          },
          {
            icon: "📞",
            title: "Real calls, real WebRTC",
            body: "Native voice & video, encrypted in transit, with CallKit so calls ring even when the app is closed.",
          },
          {
            icon: "🚫",
            title: "No ads, ever",
            body: "Free for personal 1:1 communication, and we never sell a byte of your data. That's a promise, not a policy.",
          },
        ],
      }),
    }),
  });
  return response.ok;
}

Deno.serve(async (req) => {
  // FAIL CLOSED, same posture as send-waitlist-email: this sends email on
  // behalf of gettelevo.space to a potentially large list, so an
  // unauthenticated caller is a spam/phishing primitive, not just noise.
  const webhookSecret = Deno.env.get("WEBHOOK_SHARED_SECRET");
  if (!webhookSecret) {
    console.error("WEBHOOK_SHARED_SECRET is not configured — refusing to serve.");
    return new Response("server not configured", { status: 500 });
  }
  if (req.headers.get("x-webhook-secret") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request: expected JSON body with appStoreUrl", { status: 400 });
  }

  if (!body.appStoreUrl || !body.appStoreUrl.startsWith("https://")) {
    return new Response("bad request: appStoreUrl must be a real https:// URL", { status: 400 });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) {
    console.error("RESEND_API_KEY is not configured");
    return new Response("server not configured", { status: 500 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  let totalSent = 0;
  let totalFailed = 0;

  while (true) {
    let query = admin.from("waitlist").select("id, email").limit(BATCH_SIZE);
    if (!body.resendAll) {
      query = query.is("launch_notified_at", null);
    }
    const { data: rows, error } = await query;

    if (error) {
      console.error("waitlist query failed:", error.message);
      return new Response(`query failed after sending ${totalSent}`, { status: 500 });
    }
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const ok = await sendOne(resendApiKey, row.email, body.appStoreUrl);
      if (ok) {
        totalSent++;
        await admin
          .from("waitlist")
          .update({ launch_notified_at: new Date().toISOString() })
          .eq("id", row.id);
      } else {
        totalFailed++;
        console.error("send failed for waitlist row", row.id);
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_SENDS_MS));
    }

    // resendAll re-selects the SAME unmarked-by-this-flag rows forever
    // (it never filters on launch_notified_at), so without marking rows as
    // we go the loop would never converge. Regular runs naturally shrink
    // the unmarked set each pass since launch_notified_at gets set above.
    if (body.resendAll && rows.length < BATCH_SIZE) break;
  }

  return new Response(JSON.stringify({ sent: totalSent, failed: totalFailed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
