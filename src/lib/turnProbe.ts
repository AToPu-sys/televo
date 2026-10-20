import { getWebRtc } from "./webrtcModule";

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * How long one TURN relay takes to hand this phone a relay address, in ms,
 * or null if it doesn't within the timeout (unreachable from this network,
 * port blocked, credentials refused).
 *
 * Measured with WebRTC itself rather than a hand-rolled STUN client: a
 * throwaway peer connection restricted to relay candidates and to this one
 * server. Its first relay candidate arrives after a full TURN Allocate —
 * two round trips to the server — which is exactly the path a relayed call
 * would take. No media is involved (a data channel only), so it never
 * touches the microphone or the audio session.
 */
export function probeRelay(server: IceServer, timeoutMs = 3000): Promise<number | null> {
  const webrtc = getWebRtc();
  if (!webrtc) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let pc: InstanceType<typeof webrtc.RTCPeerConnection> | null = null;
    const started = Date.now();
    const finish = (result: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc?.close();
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      pc = new webrtc.RTCPeerConnection({ iceServers: [server], iceTransportPolicy: "relay" });
      // react-native-webrtc types the event without its payload.
      (pc as unknown as { onicecandidate: (event: { candidate: { candidate?: string } | null }) => void }).onicecandidate = (
        event
      ) => {
        if (event.candidate?.candidate?.includes(" typ relay")) finish(Date.now() - started);
      };
      pc.createDataChannel("probe");
      pc.createOffer({})
        .then((offer) => pc?.setLocalDescription(offer))
        .catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}
