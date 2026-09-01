// Free public TURN service (Open Relay Project) for NAT traversal, plus
// Google's public STUN server. This is fine for development and light usage;
// swap in dedicated TURN credentials for production load.
//
// Left untyped (as plain objects) rather than annotated with RTCIceServer:
// that name resolves to the ambient DOM lib's type here, not
// react-native-webrtc's own (structurally identical) type, and mixing the two
// is what caused the EventTarget/MediaStream type conflicts elsewhere.
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
