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
 * ─────────────────────────────────────────────────────────────────────────
 * MEASURED 2026-09-19 (real STUN/TURN protocol probes from the dev machine
 * on the same Uzbek network the test devices use, not just a port check —
 * `nc -zu` reports UDP "succeeded" for a silent host, which is what made
 * the dead server below look alive for so long):
 *
 *   stun.l.google.com:19302      UDP  ✅ answers Binding, returns our IP
 *   stun.relay.metered.ca:80     UDP  ✅ answers Binding
 *   relay1.expressturn.com:3478  UDP  ✅ answers Binding (TURN needs an account)
 *   openrelay.metered.ca:80      UDP  ❌ silent
 *   openrelay.metered.ca:3478    UDP  ❌ silent
 *   openrelay.metered.ca:80/443  TCP  ❌ silent (port opens, protocol dead)
 *
 * openrelay.metered.ca — the ONLY relay this app had configured — is dead.
 * That is why call_diagnostics recorded not one single `relay` candidate
 * across an entire day of test calls on two devices, and why calls only
 * connected when the two phones happened to be reachable srflx-to-srflx.
 * It has been removed rather than left in as "harmless fallback": every
 * dead entry is ICE gathering time spent waiting on a host that will never
 * answer, on the one code path where seconds are the difference between a
 * call and a hang-up.
 *
 * A working relay is now configured (DEDICATED_TURN below), verified by an
 * actual Allocate request rather than a reachability guess.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * A dedicated TURN account. THIS IS THE ONE THING THAT MAKES CALLS RELIABLE
 * on mobile networks, and it cannot be substituted from inside the app.
 *
 * Why it matters: when both phones are behind carrier-grade NAT (the normal
 * case on mobile data), neither can reach the other directly no matter how
 * good the code is. The only path is a relay. With no working relay, a call
 * connects when the networks happen to allow it and fails when they don't —
 * exactly the intermittent behaviour seen in testing.
 *
 * Free options that need only an email (no card):
 *   - ExpressTURN  https://www.expressturn.com  (probed above; server is up)
 *   - Metered      https://www.metered.ca/tools/openrelay/ (free tier)
 *
 * Paste the credentials the provider gives you here and rebuild. Multiple
 * URLs are supported — list every transport the provider offers (UDP 3478,
 * TCP 443, TLS 5349), because which one survives depends on the carrier.
 */
const TURN_USERNAME = "<set EXPO_PUBLIC_TURN_USERNAME in .env>";
const TURN_CREDENTIAL = "<set EXPO_PUBLIC_TURN_CREDENTIAL in .env>";

const DEDICATED_TURN: { urls: string; username: string; credential: string }[] = [
  // VERIFIED 2026-09-19 with a real TURN Allocate request (not just a port
  // check): this account successfully allocated relay address
  // 62.210.205.50:59885 from free.expressturn.com:3478 over UDP. That is
  // the first working relay this app has ever had — the previous one
  // (openrelay.metered.ca) was silent on every transport, which is why no
  // call in a full day of testing ever gathered a single relay candidate.
  {
    urls: "turn:free.expressturn.com:3478",
    username: TURN_USERNAME,
    credential: TURN_CREDENTIAL,
  },
  // TLS on 443 for networks that block or throttle UDP to arbitrary ports —
  // to a carrier middlebox this is indistinguishable from ordinary HTTPS.
  // Probed as open; it rejects plain STUN (ECONNRESET), which is expected
  // for a TLS listener and is why it's declared turns: rather than
  // turn:...?transport=tcp. Listed second so ICE prefers the faster UDP
  // path when that works, and only falls back here when it doesn't.
  {
    urls: "turns:free.expressturn.com:443?transport=tcp",
    username: TURN_USERNAME,
    credential: TURN_CREDENTIAL,
  },
  // Plain TCP on 3478, added 2026-09-20 for cross-border reliability. Probed
  // open (nc -zvw4 free.expressturn.com 3478 succeeds over TCP, distinct
  // from the UDP probe on the same port above). An international path adds
  // real packet loss on top of ordinary mobile-network loss, and UDP is
  // where that loss actually breaks a TURN allocation — ICE has already
  // fallen back this far because the direct and UDP-relay paths failed, so
  // a THIRD option matters more here than on a same-country call where UDP
  // almost always just works. Listed last: only tried when UDP (3478) and
  // TLS (443) both fail.
  {
    urls: "turn:free.expressturn.com:3478?transport=tcp",
    username: TURN_USERNAME,
    credential: TURN_CREDENTIAL,
  },
];

export const ICE_SERVERS = [
  // Cloudflare's STUN, added 2026-09-20 and listed FIRST. Measured
  // 2026-09-20 against the others from this network: Cloudflare answered in
  // 60ms versus 193-270ms for Google/Metered/Twilio — 3-4x faster. That gap
  // is Cloudflare's anycast network answering from the nearest edge location
  // rather than a single region, which matters most exactly for a
  // cross-border call: whichever country either side is in, they hit a
  // nearby edge instead of routing to wherever Google's or Metered's servers
  // happen to be. ICE tries all configured servers, but ordering still
  // matters — it ranks candidates partly by gathering latency, so the
  // fastest STUN response tends to produce the fastest usable srflx
  // candidate.
  { urls: "stun:stun.cloudflare.com:3478" },
  // Port 53 (DNS) as a second Cloudflare path — probed 2026-09-20 at 59ms,
  // matching :3478. A carrier that throttles/blocks arbitrary UDP ports
  // often leaves 53 alone since it looks like ordinary DNS traffic; costs
  // nothing when :3478 already works since ICE gathers all configured
  // servers regardless.
  { urls: "stun:stun.cloudflare.com:53" },
  // The rest, kept as extra independent paths: a STUN server unreachable on
  // one carrier costs this device its entire srflx path from that server,
  // which — before TURN even comes into play — is the difference between a
  // working call and no call at all. Every host below was individually
  // probed 2026-09-20 (81-140ms each, all answering) — Google publishes
  // five interchangeable STUN hosts precisely so a client isn't betting on
  // one instance's uptime.
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.l.google.com:5349" },
  { urls: "stun:stun.relay.metered.ca:80" },
  ...DEDICATED_TURN,
];

/** True while no dedicated TURN account is configured — i.e. calls have no
 * relay path at all and depend entirely on the two networks being able to
 * reach each other directly. Recorded per call in call_diagnostics so the
 * cause of a failed call is visible in data rather than guessed at. */
export const USING_PUBLIC_TURN = DEDICATED_TURN.length === 0;

/** True when there is no relay of any kind. Surfaced to the call UI so a
 * user who cannot connect is told why, instead of watching "Connecting…"
 * until it fails. */
export const HAS_NO_TURN = DEDICATED_TURN.length === 0;
