import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * TURN relays for one signed-in user, from every source that is configured,
 * each listed separately so the app can rank them by how fast they answer
 * from where the phone is right now (src/lib/iceServers.ts) and switch to
 * another mid-call when the one in use goes bad.
 *
 * Sources, all optional, all from this function's secrets:
 *
 *  - Televo's own coturn servers (COTURN_HOSTS, comma-separated host names,
 *    and COTURN_SECRET). Credentials are coturn's "TURN REST" kind: the
 *    username carries an expiry, the password is an HMAC of it under the
 *    shared secret, so nothing long-lived ever reaches a phone.
 *  - Static relays (STATIC_TURN_URLS / STATIC_TURN_USERNAME /
 *    STATIC_TURN_CREDENTIAL) — the free ExpressTURN account.
 *  - Metered (METERED_DOMAIN, e.g. "televo.metered.live", and
 *    METERED_API_KEY): returns relays near the phone, on ports 80/443 too.
 *  - Cloudflare Realtime TURN (CLOUDFLARE_TURN_KEY_ID /
 *    CLOUDFLARE_TURN_API_TOKEN): anycast, nearest edge.
 *
 * `iceServers` is everything flattened, for builds up to 92, which only
 * read that field. Newer builds read `relays`.
 */

// Long enough to outlast any realistic call, short enough that a leaked
// credential stops working within the day.
const TTL_SECONDS = 12 * 60 * 60;
const PROVIDER_TIMEOUT_MS = 2500;

type IceServer = { urls: string[]; username?: string; credential?: string };
type Relay = { id: string; provider: string; server: IceServer };

// Same measured set as the app's PUBLIC_STUN (src/lib/webrtc.ts), for builds
// that take STUN from here (≤ 92).
const STUN: IceServer = {
  urls: [
    "stun:stun.cloudflare.com:3478",
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun.linphone.org:3478",
    "stun:stun.sipgate.net:3478",
    "stun:stun.zadarma.com:3478",
    "stun:stun.sipnet.ru:3478",
  ],
};

function hostOf(url: string): string {
  return url.replace(/^(turns?|stuns?):/, "").split(/[:?]/)[0];
}

/** One relay per host, so two servers of one provider are ranked apart. */
function relaysByHost(provider: string, servers: IceServer[]): Relay[] {
  const byHost = new Map<string, Relay>();
  for (const server of servers) {
    for (const url of server.urls) {
      if (!url.startsWith("turn")) continue;
      // Port 53 is blocked by some networks and only costs a gathering
      // timeout there.
      if (/:53(\?|$)/.test(url)) continue;
      const host = hostOf(url);
      const key = `${host}|${server.username ?? ""}`;
      const existing = byHost.get(key);
      if (existing) {
        existing.server.urls.push(url);
      } else {
        byHost.set(key, {
          id: `${provider}:${host}`,
          provider,
          server: { urls: [url], username: server.username, credential: server.credential },
        });
      }
    }
  }
  return [...byHost.values()];
}

function asServers(list: unknown): IceServer[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const server = item as { urls?: string | string[]; username?: string; credential?: string };
      const urls = Array.isArray(server.urls) ? server.urls : server.urls ? [server.urls] : [];
      return { urls, username: server.username, credential: server.credential };
    })
    .filter((server) => server.urls.length > 0);
}

async function withTimeout(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

async function ownRelays(userId: string): Promise<Relay[]> {
  const hosts = (Deno.env.get("COTURN_HOSTS") ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  const secret = Deno.env.get("COTURN_SECRET");
  if (!hosts.length || !secret) return [];
  const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${userId}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return hosts.map((host) => ({
    id: `televo:${host}`,
    provider: "televo",
    server: {
      urls: [`turn:${host}:3478`, `turn:${host}:3478?transport=tcp`, `turns:${host}:443?transport=tcp`],
      username,
      credential,
    },
  }));
}

function staticRelays(): Relay[] {
  const urls = (Deno.env.get("STATIC_TURN_URLS") ?? "").split(",").map((url) => url.trim()).filter(Boolean);
  const username = Deno.env.get("STATIC_TURN_USERNAME");
  const credential = Deno.env.get("STATIC_TURN_CREDENTIAL");
  if (!urls.length || !username || !credential) return [];
  const provider = urls.every((url) => hostOf(url).endsWith("expressturn.com")) ? "expressturn" : "static";
  return relaysByHost(provider, [{ urls, username, credential }]);
}

async function meteredRelays(): Promise<Relay[]> {
  const domain = Deno.env.get("METERED_DOMAIN");
  const apiKey = Deno.env.get("METERED_API_KEY");
  if (!domain || !apiKey) return [];
  const response = await withTimeout(
    `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
    { method: "GET" }
  );
  if (!response?.ok) {
    console.error(`Metered TURN request failed: ${response?.status ?? "timeout"}`);
    return [];
  }
  return relaysByHost("metered", asServers(await response.json().catch(() => null)));
}

async function cloudflareRelays(): Promise<Relay[]> {
  const keyId = Deno.env.get("CLOUDFLARE_TURN_KEY_ID");
  const apiToken = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN");
  if (!keyId || !apiToken) return [];
  const response = await withTimeout(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    }
  );
  if (!response?.ok) {
    console.error(`Cloudflare TURN request failed: ${response?.status ?? "timeout"}`);
    return [];
  }
  const body = (await response.json().catch(() => null)) as { iceServers?: unknown } | null;
  return relaysByHost("cloudflare", asServers(body?.iceServers));
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response("unauthorized", { status: 401 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const {
    data: { user },
  } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
  if (!user) return new Response("unauthorized", { status: 401 });

  // Own servers first: they're the ones meant to carry the traffic. The
  // order only matters to builds that don't rank (≤ 92).
  const groups = await Promise.all([ownRelays(user.id), staticRelays(), meteredRelays(), cloudflareRelays()]);
  const relays = groups.flat();
  if (relays.length === 0) {
    return Response.json({ error: "turn_not_configured" }, { status: 503 });
  }

  return Response.json(
    {
      iceServers: [STUN, ...relays.map((relay) => relay.server)],
      stun: STUN,
      relays,
      expiresAt: Date.now() + TTL_SECONDS * 1000,
      provider: [...new Set(relays.map((relay) => relay.provider))].join(","),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
});
