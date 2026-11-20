// Web stand-in for react-native-webrtc, backed by the browser's own WebRTC.
// Televo Web makes AUDIO-ONLY calls: getUserMedia never asks for the camera,
// whatever the caller requested, so the browser only ever prompts for the
// microphone. A video call from a phone is answered as voice.
import { createElement, useEffect, useRef } from "react";

const streams = new Map<string, MediaStream>();
// Our own microphone streams: never played back (that would be an echo).
const localStreams = new WeakSet<MediaStream>();

// react-native-webrtc's MediaStream has toURL(), which <RTCView streamURL>
// uses to find the stream. Give the browser's MediaStream the same.
if (typeof MediaStream !== "undefined" && !(MediaStream.prototype as unknown as { toURL?: unknown }).toURL) {
  Object.defineProperty(MediaStream.prototype, "toURL", {
    value(this: MediaStream) {
      streams.set(this.id, this);
      return this.id;
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

export const RTCPeerConnection = g.RTCPeerConnection;
export const RTCIceCandidate = g.RTCIceCandidate;
export const RTCSessionDescription = g.RTCSessionDescription;
const MediaStreamCtor = g.MediaStream;
export { MediaStreamCtor as MediaStream };
export const MediaStreamTrack = g.MediaStreamTrack;

export const mediaDevices = {
  async getUserMedia(_constraints?: unknown): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    localStreams.add(stream);
    return stream;
  },
  async enumerateDevices() {
    return await navigator.mediaDevices.enumerateDevices();
  },
};

export function registerGlobals() {
  // The browser already provides these globals.
}

/** Plays the remote stream's audio. Audio-only on the web, so nothing is drawn. */
export function RTCView(props: { streamURL?: string; muted?: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const found = props.streamURL ? streams.get(props.streamURL) ?? null : null;
    const stream = found && !localStreams.has(found) ? found : null;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [props.streamURL]);
  return createElement("audio", { ref, autoPlay: true, muted: props.muted ?? false, style: { display: "none" } });
}

export default { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, MediaStream: MediaStreamCtor, mediaDevices, RTCView, registerGlobals };
