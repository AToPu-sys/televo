import { useCallback, useEffect, useRef, useState } from "react";
import {
  mediaDevices,
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "react-native-webrtc";

import { supabase } from "../lib/supabase";
import { ICE_SERVERS } from "../lib/webrtc";
import type { Database } from "../types/database";

// react-native-webrtc doesn't export event-payload or candidate-init types
// from its package root (RTCIceCandidateEvent, RTCTrackEvent), even though it
// uses them internally — these are the minimal local shapes we actually read.
type IceCandidateInit = ReturnType<RTCIceCandidate["toJSON"]>;
type IceCandidateEvent = { candidate: RTCIceCandidate | null };
type TrackEvent = { streams: MediaStream[] };

type CallKind = Database["public"]["Enums"]["call_kind"];
type CallRow = Database["public"]["Tables"]["calls"]["Row"];

export type CallState =
  | { phase: "idle" }
  | { phase: "outgoing"; call: CallRow }
  | { phase: "incoming"; call: CallRow }
  | { phase: "connecting"; call: CallRow }
  | { phase: "active"; call: CallRow }
  | { phase: "ended"; reason: "declined" | "hangup" | "missed" | "failed" };

// Signaling messages travel over a Realtime broadcast channel keyed by call
// id. Broadcast (not the `calls` table) carries SDP/ICE because those are
// high-frequency, ephemeral, and irrelevant once the call ends — writing each
// one through RLS-checked table inserts would be slow and pointless to keep.
type Signal =
  | { type: "offer"; sdp: string; kind: CallKind }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: IceCandidateInit }
  | { type: "hangup" }
  | { type: "decline" };

export function useCall(userId: string | undefined) {
  const [state, setState] = useState<CallState>({ phase: "idle" });
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const signalChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pendingCandidatesRef = useRef<IceCandidateInit[]>([]);

  const cleanup = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;

    localStream?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    setRemoteStream(null);
    pendingCandidatesRef.current = [];

    if (signalChannelRef.current) {
      void supabase.removeChannel(signalChannelRef.current);
      signalChannelRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStream]);

  const sendSignal = useCallback((signal: Signal) => {
    if (!signalChannelRef.current) return;
    void signalChannelRef.current.send({ type: "broadcast", event: "signal", payload: signal });
  }, []);

  const setupPeerConnection = useCallback(
    (stream: MediaStream) => {
      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerRef.current = peer;

      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      // Assigned as on{event} properties rather than addEventListener(): the
      // library's EventTarget overloads resolve more reliably this way, and
      // it sidesteps any ambiguity with the ambient DOM RTCPeerConnection
      // types pulled in by tsconfig's "dom" lib.
      peer.onicecandidate = (event: IceCandidateEvent) => {
        if (event.candidate) {
          sendSignal({ type: "ice-candidate", candidate: event.candidate.toJSON() });
        }
      };

      peer.ontrack = (event: TrackEvent) => {
        if (event.streams[0]) {
          setRemoteStream(event.streams[0]);
        }
      };

      return peer;
    },
    [sendSignal]
  );

  const getLocalStream = useCallback(async (kind: CallKind) => {
    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: kind === "video" ? { facingMode: "user" } : false,
    });
    setLocalStream(stream);
    return stream;
  }, []);

  const joinSignalChannel = useCallback(
    (callId: string, onSignal: (signal: Signal) => void) => {
      const channel = supabase
        .channel(`call:${callId}`, { config: { broadcast: { self: false } } })
        .on("broadcast", { event: "signal" }, ({ payload }: { payload: Signal }) => {
          onSignal(payload);
        })
        .subscribe();

      signalChannelRef.current = channel;
      return channel;
    },
    []
  );

  /** Caller side: create the call row, then ring the other participant. */
  const startCall = useCallback(
    async (conversationId: string, kind: CallKind) => {
      if (!userId) return;

      const { data: call, error } = await supabase
        .from("calls")
        .insert({ conversation_id: conversationId, caller_id: userId, kind, status: "ringing" })
        .select("*")
        .single();

      if (error || !call) {
        setState({ phase: "ended", reason: "failed" });
        return;
      }

      setState({ phase: "outgoing", call });

      const stream = await getLocalStream(kind);
      const peer = setupPeerConnection(stream);

      joinSignalChannel(call.id, async (signal) => {
        if (signal.type === "answer") {
          await peer.setRemoteDescription(new RTCSessionDescription(signal));
          for (const candidate of pendingCandidatesRef.current) {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
          }
          pendingCandidatesRef.current = [];
          setState({ phase: "active", call });
        } else if (signal.type === "ice-candidate") {
          if (peer.remoteDescription) {
            await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            pendingCandidatesRef.current.push(signal.candidate);
          }
        } else if (signal.type === "decline") {
          await supabase.from("calls").update({ status: "declined" }).eq("id", call.id);
          setState({ phase: "ended", reason: "declined" });
          cleanup();
        } else if (signal.type === "hangup") {
          setState({ phase: "ended", reason: "hangup" });
          cleanup();
        }
      });

      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      sendSignal({ type: "offer", sdp: offer.sdp!, kind });
    },
    [userId, getLocalStream, setupPeerConnection, joinSignalChannel, sendSignal, cleanup]
  );

  /** Callee side: accept an incoming call, answer with local SDP. */
  const answerCall = useCallback(
    async (call: CallRow, offerSdp: string, kind: CallKind) => {
      setState({ phase: "connecting", call });

      const stream = await getLocalStream(kind);
      const peer = setupPeerConnection(stream);

      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp: offerSdp })
      );
      for (const candidate of pendingCandidatesRef.current) {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidatesRef.current = [];

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendSignal({ type: "answer", sdp: answer.sdp! });

      await supabase
        .from("calls")
        .update({ status: "active", answered_at: new Date().toISOString() })
        .eq("id", call.id);

      setState({ phase: "active", call });
    },
    [getLocalStream, setupPeerConnection, sendSignal]
  );

  /** Listens for an incoming offer on a call id the app already knows about
   * (from a `calls` INSERT elsewhere) and stages the answer path. */
  const listenForOffer = useCallback(
    (call: CallRow) => {
      setState({ phase: "incoming", call });

      joinSignalChannel(call.id, (signal) => {
        if (signal.type === "offer") {
          // Stash the offer; answerCall() is invoked explicitly when the user
          // taps Accept, so the mic/camera prompt only fires on consent.
          pendingOfferRef.current = { sdp: signal.sdp, kind: signal.kind };
        } else if (signal.type === "hangup") {
          setState({ phase: "ended", reason: "hangup" });
          cleanup();
        } else if (signal.type === "ice-candidate" && peerRef.current) {
          if (peerRef.current.remoteDescription) {
            void peerRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            pendingCandidatesRef.current.push(signal.candidate);
          }
        }
      });
    },
    [joinSignalChannel, cleanup]
  );

  const pendingOfferRef = useRef<{ sdp: string; kind: CallKind } | null>(null);

  const accept = useCallback(async () => {
    if (state.phase !== "incoming" || !pendingOfferRef.current) return;
    const { sdp, kind } = pendingOfferRef.current;
    await answerCall(state.call, sdp, kind);
  }, [state, answerCall]);

  const decline = useCallback(async () => {
    if (state.phase !== "incoming") return;
    sendSignal({ type: "decline" });
    await supabase.from("calls").update({ status: "declined" }).eq("id", state.call.id);
    setState({ phase: "ended", reason: "declined" });
    cleanup();
  }, [state, sendSignal, cleanup]);

  const hangup = useCallback(async () => {
    if (state.phase === "idle" || state.phase === "ended") return;
    sendSignal({ type: "hangup" });
    await supabase
      .from("calls")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", state.call.id);
    setState({ phase: "ended", reason: "hangup" });
    cleanup();
  }, [state, sendSignal, cleanup]);

  const toggleMute = useCallback(() => {
    if (!localStream) return;
    const next = !muted;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  }, [localStream, muted]);

  const toggleCamera = useCallback(() => {
    if (!localStream) return;
    const next = !cameraOff;
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = !next;
    });
    setCameraOff(next);
  }, [localStream, cameraOff]);

  const reset = useCallback(() => {
    setState({ phase: "idle" });
    cleanup();
  }, [cleanup]);

  useEffect(() => cleanup, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    localStream,
    remoteStream,
    muted,
    cameraOff,
    startCall,
    listenForOffer,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCamera,
    reset,
  };
}
