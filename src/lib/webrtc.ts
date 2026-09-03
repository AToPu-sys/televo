// Free public TURN service (Open Relay Project) for NAT traversal, plus
// Google's public STUN server. This is fine for development and light usage;
// swap in dedicated TURN credentials for production load. Passed straight
// through to the native RTCPeerConnection config.
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
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
];
