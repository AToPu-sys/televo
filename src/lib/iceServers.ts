import { supabase } from "./supabase";
import { ICE_SERVERS as FALLBACK_ICE_SERVERS } from "./webrtc";

/**
 * ICE servers for a call: short-lived Cloudflare TURN credentials minted by
 * the turn-credentials Edge Function, with the bundled list as a fallback.
 *
 * Cloudflare's relay is anycast — a phone reaches the closest edge — where
 * the bundled relay is a free shared server in one region, which is what made
 * relayed calls slow to connect and laggy. Credentials are fetched ahead of
 * time (warmIceServers on sign-in and when a call starts ringing) and cached
 * until shortly before they expire, so placing or answering a call never waits
 * on this request; if it is slow or fails, the call goes ahead on the fallback.
 */

type IceServer = { urls: string | string[]; username?: string; credential?: string };

const FETCH_TIMEOUT_MS = 2500;
/** Refresh this long before Cloudflare's expiry so a call never starts on a
 * credential that runs out mid-call. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

let cached: { servers: IceServer[]; expiresAt: number } | null = null;
let inFlight: Promise<IceServer[] | null> | null = null;

/** Extra public STUN alongside Cloudflare's own — cheap, and a second
 * reflexive address source if one STUN host is unreachable. */
const EXTRA_STUN: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function fresh(): IceServer[] | null {
  if (!cached || cached.expiresAt - Date.now() < REFRESH_MARGIN_MS) return null;
  return cached.servers;
}

function fetchCloudflare(): Promise<IceServer[] | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke("turn-credentials", { method: "POST" });
      const servers = (data as { iceServers?: IceServer[] } | null)?.iceServers;
      const expiresAt = (data as { expiresAt?: number } | null)?.expiresAt;
      if (error || !servers?.length || !expiresAt) return null;
      cached = { servers: [...servers, ...EXTRA_STUN], expiresAt };
      return cached.servers;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Start fetching credentials in the background if the cache is cold. */
export function warmIceServers(): void {
  if (!fresh()) void fetchCloudflare();
}

/** "server": credentials from the turn-credentials function (Cloudflare
 * when configured there, otherwise the free relay's credentials it holds).
 * "fallback": the list bundled in the app. */
export type IceServerSet = { servers: IceServer[]; source: "server" | "fallback" };

/** The servers to build this call's peer connection with. Never waits longer
 * than FETCH_TIMEOUT_MS; on a miss the call uses the bundled list. */
export async function getIceServers(): Promise<IceServerSet> {
  const ready = fresh();
  if (ready) return { servers: ready, source: "server" };
  const servers = await Promise.race([
    fetchCloudflare(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
  ]);
  return servers ? { servers, source: "server" } : { servers: FALLBACK_ICE_SERVERS, source: "fallback" };
}

/** True when the last fetched set includes a TURN relay. */
export function hasServerRelay(): boolean {
  return !!fresh()?.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => url.startsWith("turn")));
}
