import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import type {
  MediaStream,
  RTCPeerConnection as RTCPeerConnectionType,
} from "react-native-webrtc";

import { getWebRtc } from "../lib/webrtcModule";

export type BridgeEvent =
  | { type: "ready" }
  | { type: "local-ready" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "connection-state"; state: string }
  | { type: "log"; message: string }
  | { type: "error"; message: string };

export type WebRtcBridgeHandle = {
  send: (command: object) => void;
};

type WebRtcBridgeProps = {
  onEvent: (event: BridgeEvent) => void;
  /** true renders the video surfaces full-bleed; false keeps them off-screen for audio-only calls. */
  visible: boolean;
};

type Command =
  | { type: "start-local"; video?: boolean }
  | { type: "create-offer"; iceServers: RTCIceServer[]; video?: boolean }
  | { type: "create-answer"; iceServers: RTCIceServer[]; sdp: string; video?: boolean }
  | { type: "accept-answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "set-mic"; enabled: boolean }
  | { type: "set-camera"; enabled: boolean }
  | { type: "hangup" };

/**
 * The real media engine: native WebRTC via react-native-webrtc.
 *
 * This replaces a WebView that ran browser WebRTC inside an HTML page. That
 * approach cannot work: the page was loaded from an inline `html` source, so
 * its origin is `about:blank`, and WKWebView refuses getUserMedia on a
 * non-secure origin — `navigator.mediaDevices` is simply undefined there. The
 * call therefore threw before iOS ever showed a microphone or camera prompt,
 * which is why calls never opened the mic and could not be answered.
 *
 * The command/event contract is unchanged, so useCall's state machine and
 * signaling are untouched. Requires a development build; react-native-webrtc
 * is a native module and is not present in Expo Go.
 */
export const WebRtcBridge = forwardRef<WebRtcBridgeHandle, WebRtcBridgeProps>(function WebRtcBridge(
  { onEvent, visible },
  ref
) {
  const pcRef = useRef<RTCPeerConnectionType | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // ICE candidates that arrive before the remote description is set cannot be
  // added yet; WebRTC rejects them. They are queued and flushed afterwards.
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);

  // onEvent is read through a ref so the imperative handle never goes stale
  // mid-call if the parent re-renders with a new callback identity.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const post = (event: BridgeEvent) => onEventRef.current(event);

  useEffect(() => {
    post({ type: "ready" });
    // Teardown on unmount: a surviving stream keeps the mic light on.
    return () => {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      pcRef.current?.close();
      localStreamRef.current = null;
      pcRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    send(command: object) {
      void handleCommand(command as Command);
    },
  }));

  async function getMedia(video: boolean) {
    if (localStreamRef.current) return localStreamRef.current;

    const webrtc = getWebRtc();
    if (!webrtc) {
      throw new Error(
        "Calls need a development build — the native WebRTC module isn't available in Expo Go."
      );
    }

    // This is what triggers the native iOS microphone/camera permission
    // prompt — the thing the WebView could never reach.
    const stream = await webrtc.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: "user" } : false,
    });

    localStreamRef.current = stream as MediaStream;
    setLocalUrl((stream as MediaStream).toURL());
    post({ type: "local-ready" });
    return stream as MediaStream;
  }

  function createPeer(iceServers: RTCIceServer[]) {
    const webrtc = getWebRtc();
    if (!webrtc) throw new Error("Calls need a development build.");
    const pc = new webrtc.RTCPeerConnection({ iceServers });

    // react-native-webrtc types these callbacks as a bare Event<string>
    // without the payload fields, so the runtime shapes are annotated here.
    pc.onicecandidate = (event: unknown) => {
      const { candidate } = event as { candidate: RTCIceCandidate | null };
      if (candidate) {
        post({ type: "ice-candidate", candidate: candidate.toJSON() });
      }
    };

    pc.ontrack = (event: unknown) => {
      const [stream] = (event as { streams: MediaStream[] }).streams ?? [];
      if (stream) setRemoteUrl(stream.toURL());
    };

    pc.onconnectionstatechange = () => {
      post({ type: "connection-state", state: pc.connectionState ?? "unknown" });
    };

    pcRef.current = pc;
    return pc;
  }

  async function flushCandidates(pc: RTCPeerConnectionType) {
    const webrtc = getWebRtc();
    if (!webrtc) return;
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new webrtc.RTCIceCandidate(candidate));
      } catch {
        // A candidate that no longer applies is not fatal to the call.
      }
    }
  }

  async function handleCommand(command: Command) {
    try {
      if (command.type === "start-local") {
        await getMedia(!!command.video);
        return;
      }

      if (command.type === "create-offer") {
        const stream = await getMedia(!!command.video);
        const pc = createPeer(command.iceServers);
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        post({ type: "offer", sdp: offer.sdp ?? "" });
        return;
      }

      if (command.type === "create-answer") {
        const stream = await getMedia(!!command.video);
        const webrtc = getWebRtc();
        if (!webrtc) return;
        const pc = createPeer(command.iceServers);
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        await pc.setRemoteDescription(
          new webrtc.RTCSessionDescription({ type: "offer", sdp: command.sdp })
        );
        await flushCandidates(pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        post({ type: "answer", sdp: answer.sdp ?? "" });
        return;
      }

      if (command.type === "accept-answer") {
        const pc = pcRef.current;
        const webrtc = getWebRtc();
        if (!pc || !webrtc) return;
        await pc.setRemoteDescription(
          new webrtc.RTCSessionDescription({ type: "answer", sdp: command.sdp })
        );
        await flushCandidates(pc);
        return;
      }

      if (command.type === "ice-candidate") {
        const pc = pcRef.current;
        const webrtc = getWebRtc();
        if (!webrtc) return;
        // Queue until there is a peer WITH a remote description, otherwise
        // addIceCandidate throws and the candidate is lost.
        if (!pc || !pc.remoteDescription) {
          pendingCandidatesRef.current.push(command.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(command.candidate));
        } catch {
          // Stale candidate; not fatal.
        }
        return;
      }

      if (command.type === "set-mic") {
        localStreamRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = command.enabled;
        });
        return;
      }

      if (command.type === "set-camera") {
        localStreamRef.current?.getVideoTracks().forEach((track) => {
          track.enabled = command.enabled;
        });
        return;
      }

      if (command.type === "hangup") {
        localStreamRef.current?.getTracks().forEach((track) => track.stop());
        pcRef.current?.close();
        localStreamRef.current = null;
        pcRef.current = null;
        pendingCandidatesRef.current = [];
        setLocalUrl(null);
        setRemoteUrl(null);
      }
    } catch (error) {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Resolved at render time rather than imported: in Expo Go there is no
  // native view to render, and the streams stay null anyway.
  const RTCView = getWebRtc()?.RTCView;

  return (
    <View style={visible ? styles.visible : styles.hidden} pointerEvents="none">
      {RTCView && remoteUrl ? (
        <RTCView streamURL={remoteUrl} style={styles.remote} objectFit="cover" />
      ) : null}
      {RTCView && localUrl ? (
        <RTCView streamURL={localUrl} style={styles.local} objectFit="cover" zOrder={1} mirror />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  visible: StyleSheet.absoluteFillObject,
  // Off-screen rather than unmounted: keeps the peer connection and mic/cam
  // alive for an audio call without the video surfaces covering the UI.
  hidden: { position: "absolute", width: 1, height: 1, top: -1000, left: -1000, opacity: 0 },
  remote: { ...StyleSheet.absoluteFillObject },
  local: { position: "absolute", right: 16, top: 60, width: 100, height: 150, borderRadius: 12 },
});
