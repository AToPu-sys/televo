/**
 * ICE servers for call connectivity.
 *
 * A direct peer-to-peer connection only works when at least one side is
 * reachable from the internet. Most phones aren't: carrier NAT, home
 * routers and corporate firewalls all sit in the way. STUN discovers a
 * device's external address (enough when the NAT is permissive), and TURN
 * relays the media when it isn't — without a working TURN server, calls
 * between two people on mobile data simply fail to connect.
 *
 * TURN sees only the encrypted stream: WebRTC encrypts media end-to-end
 * with DTLS-SRTP, so a relay carries ciphertext it cannot read.
 *
 * Port 443 and the TCP variant matter for reach, not redundancy — a network
 * that blocks UDP entirely (many office and hotel networks) can still get a
 * call through over TCP/443, which is indistinguishable from HTTPS traffic.
 */

/** Set these to switch off the shared public relay below.
 *
 * The default TURN servers are the Open Relay Project's free public ones,
 * whose credentials ("<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>") are the same for every app on
 * earth that uses them. They work, but they're a shared free resource with
 * no capacity guarantee and no way to raise a limit — if they're saturated
 * or retired, calls between users behind NAT stop connecting and there's no
 * fix that doesn't require shipping a new build.
 *
 * A dedicated TURN account (metered.ca, Twilio, Xirsys, or self-hosted
 * coturn) removes that dependency. Fill these in and the app uses them
 * instead; leave them empty and it falls back to the public relay.
 */
const TURN_URL = "";
const TURN_USERNAME = "";
const TURN_CREDENTIAL = "";

// Two independent free relay providers, not one. A single shared public
// relay (just openrelay.metered.ca) is one saturation event away from every
// call behind strict NAT going "Connected" with no media — the exact bug
// diagnosed in this codebase's watchForInboundMedia/mediaConfirmed machinery
// (WebRtcBridge.tsx, useCall.ts, CallOverlay.tsx), which exists BECAUSE that
// relay accepts the ICE/DTLS handshake while sometimes never forwarding RTP
// under load. WebRTC's ICE agent tries every candidate from every server in
// parallel and keeps whichever pair actually connects — so listing a SECOND,
// operationally independent free relay here costs nothing on a call that
// works, and gives ICE a real alternative path on a call that would
// otherwise silently die on the first relay alone. This does not replace a
// dedicated paid TURN account (still the right fix for guaranteed capacity),
// but it is the strongest redundancy available with no external account to
// create.
const PUBLIC_FALLBACK_TURN = [
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>",
    credential: "<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>",
    credential: "<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>",
    credential: "<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>",
  },
  // freeturn.net (Wispresso) — a second, independently operated free relay.
  // Same reasoning as above: two unrelated providers are far less likely to
  // BOTH be saturated or blocked at the same moment than either alone.
  {
    urls: "turn:freeturn.net:3478",
    username: "free",
    credential: "free",
  },
  {
    urls: "turn:freeturn.net:5349?transport=tcp",
    username: "free",
    credential: "free",
  },
  {
    urls: "turns:freeturn.net:5349?transport=tcp",
    username: "free",
    credential: "free",
  },
];

const dedicatedTurn =
  TURN_URL && TURN_USERNAME && TURN_CREDENTIAL
    ? [{ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL }]
    : [];

export const ICE_SERVERS = [
  // Three STUN servers, not one: STUN is a single UDP round trip, and each
  // additional provider costs nothing while removing any one of them as a
  // single point of failure for the cheap path that avoids relaying
  // entirely — the path every call should prefer when the network allows it.
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.l.google.com:5349" },
  { urls: "stun:stun.cloudflare.com:3478" },
  ...dedicatedTurn,
  // The public fallbacks are ADDITIVE to a configured dedicated TURN account,
  // not replaced by it — more independent relay candidates for ICE to try
  // only ever helps connectivity, and a dedicated account still gets tried
  // first in practice since ICE prioritizes candidates by priority/RTT, not
  // by list order. Previously this list emptied entirely once TURN_URL was
  // set, which made the paid account a single point of failure again — the
  // exact thing having more than one relay in the first place was for.
  ...PUBLIC_FALLBACK_TURN,
];

/** True when calls are relying on the shared public TURN servers. Surfaced
 * so this shows up in call diagnostics instead of being invisible when a
 * connection fails. */
export const USING_PUBLIC_TURN = dedicatedTurn.length === 0;
