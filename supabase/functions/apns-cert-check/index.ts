// Reports how long the APNs VoIP certificate has left.
//
// The cert is the single point of failure for incoming calls on a terminated
// app, and its failure mode is silent: send-voip-push's catch swallows the
// TLS error, the Postgres trigger ignores the response, and calls simply
// stop ringing with nothing surfaced anywhere. Nothing in the system knew
// the expiry date, so this exposes it for a scheduled check to alarm on.
import "@supabase/functions-js/edge-runtime.d.ts";

function pemNotAfter(pem: string): Date | null {
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) return null;
  const der = Uint8Array.from(atob(match[1].replace(/\s+/g, "")), (c) => c.charCodeAt(0));

  // Minimal ASN.1 walk to the Validity notAfter. Deliberately not a full
  // X.509 parser: pulling one in for a single date would be far more code to
  // audit than scanning for the two time tags, which appear in Validity and
  // are the only UTCTime/GeneralizedTime values before the subject.
  const times: Date[] = [];
  for (let i = 0; i < der.length - 2; i++) {
    const tag = der[i];
    if (tag !== 0x17 && tag !== 0x18) continue;
    const len = der[i + 1];
    if (len > 0x7f || i + 2 + len > der.length) continue;
    const raw = new TextDecoder().decode(der.subarray(i + 2, i + 2 + len));
    const m = tag === 0x17
      ? raw.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
      : raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) continue;
    const year = tag === 0x17 ? 2000 + Number(m[1]) : Number(m[1]);
    times.push(new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))));
    if (times.length === 2) break;
  }
  // Validity is [notBefore, notAfter] in that order.
  return times[1] ?? null;
}

Deno.serve(async (req) => {
  // FAIL CLOSED, explicitly: matches the pattern in send-push-notification,
  // send-voip-push, and ai-assistant-reply. The inline comparison this
  // replaced happened to reject a missing secret too (undefined !== the
  // header's null), but only by coincidence of how Deno.env.get and header
  // lookup each represent "absent" — a fragile accident to depend on, not a
  // deliberate fail-closed check.
  const webhookSecret = Deno.env.get("WEBHOOK_SHARED_SECRET");
  if (!webhookSecret) {
    console.error("WEBHOOK_SHARED_SECRET is not configured — refusing to serve.");
    return new Response("server not configured", { status: 500 });
  }
  if (req.headers.get("x-webhook-secret") !== webhookSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  const certB64 = Deno.env.get("APNS_VOIP_CERT_B64");
  if (!certB64) {
    return new Response(JSON.stringify({ ok: false, error: "APNS_VOIP_CERT_B64 not set" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const notAfter = pemNotAfter(atob(certB64));
  if (!notAfter) {
    return new Response(JSON.stringify({ ok: false, error: "could not parse certificate" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const daysLeft = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);
  const body = {
    ok: daysLeft > 30,
    expiresAt: notAfter.toISOString(),
    daysLeft,
    // 30 days is the point at which renewal has to start: a new VoIP cert
    // has to be issued in the Apple portal, exported, and stored as a secret,
    // and every one of those steps needs a human.
    warning: daysLeft <= 30 ? "APNs VoIP certificate expires soon — incoming calls will stop working" : null,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: daysLeft > 30 ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
});
