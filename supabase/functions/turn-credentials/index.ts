import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Short-lived TURN credentials from Cloudflare Realtime TURN, for one
 * signed-in user. The app used to ship a single static TURN username and
 * password inside its bundle (EXPO_PUBLIC_TURN_*) — anyone could pull them
 * out of the IPA and relay their own traffic on our account — and the relay
 * behind it was a free shared server in one region, which is what made calls
 * slow to connect and laggy whenever they went through it.
 *
 * Cloudflare's TURN runs on its anycast network, so a phone reaches the
 * nearest edge wherever it is. The long-lived key stays in this function's
 * secrets (CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN); clients only
 * ever see credentials that expire on their own.
 *
 * https://developers.cloudflare.com/realtime/turn/generate-credentials/
 */

// Long enough to outlast any realistic call, short enough that a leaked
// credential stops working within the day.
const TTL_SECONDS = 12 * 60 * 60;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response("unauthorized", { status: 401 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const {
    data: { user },
  } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
  if (!user) return new Response("unauthorized", { status: 401 });

  const keyId = Deno.env.get("CLOUDFLARE_TURN_KEY_ID");
  const apiToken = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN");
  if (!keyId || !apiToken) {
    // No Cloudflare account: hand out the free relay's static credentials
    // from this function's secrets instead of the app bundle, so they stop
    // shipping inside every IPA. Adding the two Cloudflare secrets later
    // switches every client over with no app update.
    const urls = (Deno.env.get("STATIC_TURN_URLS") ?? "").split(",").map((url) => url.trim()).filter(Boolean);
    const username = Deno.env.get("STATIC_TURN_USERNAME");
    const credential = Deno.env.get("STATIC_TURN_CREDENTIAL");
    if (!urls.length || !username || !credential) {
      return Response.json({ error: "turn_not_configured" }, { status: 503 });
    }
    return Response.json(
      {
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
          { urls, username, credential },
        ],
        expiresAt: Date.now() + TTL_SECONDS * 1000,
        provider: "static",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    }
  );
  if (!response.ok) {
    console.error(`Cloudflare TURN credential request failed: ${response.status}`);
    return Response.json({ error: "turn_unavailable" }, { status: 502 });
  }

  const body = (await response.json()) as { iceServers?: { urls: string | string[]; username?: string; credential?: string }[] };
  // Port 53 is blocked by some networks and only costs a gathering timeout
  // there; every other port Cloudflare offers (3478, 443, 80, TLS 5349/443)
  // is kept, so restrictive networks still have a way out over TCP/TLS 443.
  const iceServers = (body.iceServers ?? [])
    .map((server) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !/:53(\?|$)/.test(url)),
    }))
    .filter((server) => server.urls.length > 0);

  return Response.json(
    { iceServers, expiresAt: Date.now() + TTL_SECONDS * 1000, provider: "cloudflare" },
    { headers: { "Cache-Control": "no-store" } }
  );
});
