import { addNetworkChangeListener, currentNetwork } from "expo-televo-audio";

import { supabase } from "./supabase";
import { probeRelay } from "./turnProbe";
import { ICE_SERVERS as FALLBACK_ICE_SERVERS, PUBLIC_STUN } from "./webrtc";

/**
 * ICE servers for a call: TURN relays from the turn-credentials Edge
 * Function — Televo's own servers, the free ExpressTURN pair, and Metered or
 * Cloudflare when those are configured — ranked for the network the phone
 * is on right now.
 *
 * Ranking: every relay is probed in the background (src/lib/turnProbe.ts —
 * time to a real TURN allocation) when the list arrives and whenever the
 * network changes, never during a call. A call gets the fastest
 * MAX_RELAYS, fastest first (libwebrtc prefers relays listed earlier);
 * relays that failed from this network go last. When a relayed call turns
 * bad, useCall penalises the relay it is on (penalizeRelayForUrl) and
 * restarts ICE with the next best — so a congested or dying relay is left
 * mid-call instead of being suffered.
 *
 * Credentials are fetched ahead of time (sign-in, an incoming ring) and
 * cached until shortly before they expire, so placing or answering a call
 * never waits on the network for them; if the function is slow or
 * unreachable, the call goes ahead on the list bundled in the app.
 */

type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type Relay = { id: string; provider: string; server: IceServer };

const FETCH_TIMEOUT_MS = 2500;
/** Refresh this long before expiry so a call never starts on a credential
 * that runs out mid-call. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;
/** Relays handed to one call. Each costs an allocation and candidates to
 * check, so not all of them — the fastest few. */
const MAX_RELAYS = 3;
/** A measurement is trusted this long, on the same network. */
const PROBE_TTL_MS = 10 * 60 * 1000;
/** How long a relay that failed a call stays at the back of the line. */
const PENALTY_MS = 10 * 60 * 1000;

let cached: { relays: Relay[]; expiresAt: number } | null = null;
let inFlight: Promise<boolean> | null = null;
let measurement: { network: string; at: number; ms: Map<string, number | null> } | null = null;
let probing: Promise<void> | null = null;
let probingAllowed = true;
let networkListening = false;
const penalties = new Map<string, number>();

function urlsOf(server: IceServer): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

function hostOf(url: string): string {
  return url.replace(/^(turns?|stuns?):/, "").split(/[:?]/)[0];
}

function networkKey(): string {
  const path = currentNetwork();
  return path ? `${path.interface}|${path.gateway}` : "unknown";
}

/** Builds that predate `relays` in the response still get one relay per
 * host out of the flat list. */
function relaysFromFlatList(servers: IceServer[]): Relay[] {
  const relays: Relay[] = [];
  for (const server of servers) {
    const turnUrls = urlsOf(server).filter((url) => url.startsWith("turn"));
    if (turnUrls.length === 0) continue;
    relays.push({ id: `server:${hostOf(turnUrls[0])}`, provider: "server", server: { ...server, urls: turnUrls } });
  }
  return relays;
}

function fresh() {
  if (!cached || cached.expiresAt - Date.now() < REFRESH_MARGIN_MS) return null;
  return cached;
}

// Bumped on sign-out so a fetch that started for the previous account can't
// repopulate the cache after it was cleared.
let generation = 0;

/** Forget credentials and measurements: the TURN username is bound to the
 * signed-in user, so the next account must not reuse it. */
export function resetIceServers(): void {
  generation += 1;
  cached = null;
  inFlight = null;
  measurement = null;
  penalties.clear();
}

function fetchFromServer(): Promise<boolean> {
  if (inFlight) return inFlight;
  const gen = generation;
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke("turn-credentials", { method: "POST" });
      const body = data as { iceServers?: IceServer[]; relays?: Relay[]; expiresAt?: number } | null;
      if (error || !body?.expiresAt) return false;
      const relays = body.relays?.length ? body.relays : relaysFromFlatList(body.iceServers ?? []);
      if (relays.length === 0 || gen !== generation) return false;
      cached = { relays, expiresAt: body.expiresAt };
      void probeRelays();
      return true;
    } catch {
      return false;
    } finally {
      if (gen === generation) inFlight = null;
    }
  })();
  return inFlight;
}

/** Relays in the order a call should try them. */
export function rankedRelays(): Relay[] {
  const relays = cached?.relays ?? [];
  const now = Date.now();
  const measured = measurement && measurement.network === networkKey() ? measurement.ms : null;
  return relays
    .map((relay, index) => {
      const ms = measured?.get(relay.id);
      // Unmeasured relays keep the server's order, after every relay that
      // answered and before every one that didn't.
      let score = ms === undefined ? 10_000 + index : ms === null ? 1_000_000 + index : ms;
      if ((penalties.get(relay.id) ?? 0) > now) score += 10_000_000;
      return { relay, score };
    })
    .sort((a, b) => a.score - b.score)
    .map(({ relay }) => relay);
}

function buildServers(): IceServer[] {
  // STUN is the app's own measured list (PUBLIC_STUN), not the server's.
  return [...PUBLIC_STUN, ...rankedRelays().slice(0, MAX_RELAYS).map((relay) => relay.server)];
}

/** Measures every relay from the current network (in the background; skipped
 * during calls and when a recent measurement for this network exists). */
export function probeRelays(force = false): Promise<void> {
  const relays = cached?.relays ?? [];
  if (!probingAllowed || relays.length === 0) return Promise.resolve();
  const network = networkKey();
  if (!force && measurement && measurement.network === network && Date.now() - measurement.at < PROBE_TTL_MS) {
    return Promise.resolve();
  }
  if (probing) return probing;
  probing = (async () => {
    const results = await Promise.all(relays.map(async (relay) => [relay.id, await probeRelay(relay.server)] as const));
    measurement = { network, at: Date.now(), ms: new Map(results) };
  })().finally(() => {
    probing = null;
  });
  return probing;
}

function listenForNetworkChanges() {
  if (networkListening) return;
  networkListening = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  addNetworkChangeListener((path) => {
    if (path.status !== "satisfied") return;
    if (timer) clearTimeout(timer);
    // Let the new path settle (DHCP, DNS) before measuring on it.
    timer = setTimeout(() => void probeRelays(true), 2000);
  });
}

/** Calls pause probing (no extra traffic or allocations mid-call). */
export function setRelayProbingAllowed(allowed: boolean): void {
  probingAllowed = allowed;
  if (allowed) void probeRelays();
}

/** Start fetching credentials and measuring relays in the background. */
export function warmIceServers(): void {
  listenForNetworkChanges();
  if (!fresh()) void fetchFromServer();
  else void probeRelays();
}

/** "server": relays from the turn-credentials function. "fallback": the
 * list bundled in the app. */
export type IceServerSet = { servers: IceServer[]; source: "server" | "fallback" };

/** The fetched servers if they are fresh right now, without waiting;
 * otherwise null (and a fetch is started so getIceServers finds it running). */
export function peekIceServers(): IceServerSet | null {
  if (fresh()) return { servers: buildServers(), source: "server" };
  void fetchFromServer();
  return null;
}

/** The servers to build this call's peer connection with. Never waits longer
 * than FETCH_TIMEOUT_MS; on a miss the call uses the bundled list. */
export async function getIceServers(): Promise<IceServerSet> {
  if (fresh()) return { servers: buildServers(), source: "server" };
  const ok = await Promise.race([
    fetchFromServer(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FETCH_TIMEOUT_MS)),
  ]);
  return ok && cached ? { servers: buildServers(), source: "server" } : { servers: FALLBACK_ICE_SERVERS, source: "fallback" };
}

/**
 * The call on the relay at `url` (a TURN URL from the call's stats) is
 * going badly: send that relay to the back of the line and return the
 * re-ranked servers — or null when there's no other relay to move to.
 */
export function penalizeRelayForUrl(url: string): { servers: IceServer[]; from: string; to: string } | null {
  if (!cached) return null;
  const host = hostOf(url);
  const current = cached.relays.find((relay) => urlsOf(relay.server).some((candidate) => hostOf(candidate) === host));
  if (!current) return null;
  penalties.set(current.id, Date.now() + PENALTY_MS);
  const next = rankedRelays()[0];
  if (!next || next.id === current.id) return null;
  return { servers: buildServers(), from: current.id, to: next.id };
}

/** True when the last fetched set includes a TURN relay. */
export function hasServerRelay(): boolean {
  return !!fresh()?.relays.length;
}
