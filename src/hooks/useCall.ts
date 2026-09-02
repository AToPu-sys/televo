import { useCallback, useEffect, useRef, useState } from "react";

import type { BridgeEvent, WebRtcBridgeHandle } from "../components/WebRtcBridge";
import { supabase } from "../lib/supabase";
import { ICE_SERVERS } from "../lib/webrtc";
import type { Database } from "../types/database";

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
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "hangup" }
  | { type: "decline" };

/**
 * The actual media engine lives inside a hidden WebView (see WebRtcBridge +
 * webrtcBridgeHtml) — plain browser getUserMedia/RTCPeerConnection, which
 * Expo Go's WebView already supports without a custom native module. This
 * hook owns the call state machine and signaling; it talks to the bridge only
 * through JSON commands/events, never touching WebRTC types directly.
 */
export function useCall(userId: string | undefined) {
  const [state, setState] = useState<CallState>({ phase: "idle" });
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);

  const bridgeRef = useRef<WebRtcBridgeHandle | null>(null);
  const signalChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // A channel object exists synchronously after .channel().subscribe(), but
  // the join itself is async — sending before the SUBSCRIBED callback fires
  // is a known way for Supabase Realtime broadcast to silently drop the
  // message. Signals sent too early are queued here and flushed once ready,
  // rather than lost (this is what caused "decline" to never reach the
  // caller, leaving it stuck on "Ringing…").
  const channelReadyRef = useRef(false);
  const pendingSignalsRef = useRef<Signal[]>([]);
  const pendingOfferRef = useRef<{ sdp: string; kind: CallKind } | null>(null);
  const roleRef = useRef<"caller" | "callee" | null>(null);

  const setBridgeRef = useCallback((handle: WebRtcBridgeHandle | null) => {
    bridgeRef.current = handle;
  }, []);

  const sendCommand = useCallback((command: object) => {
    bridgeRef.current?.send(command);
  }, []);

  const cleanup = useCallback(() => {
    sendCommand({ type: "hangup" });
    roleRef.current = null;
    pendingOfferRef.current = null;
    channelReadyRef.current = false;
    pendingSignalsRef.current = [];

    if (signalChannelRef.current) {
      void supabase.removeChannel(signalChannelRef.current);
      signalChannelRef.current = null;
    }
  }, [sendCommand]);

  const sendSignal = useCallback((signal: Signal) => {
    if (!signalChannelRef.current) return;
    if (!channelReadyRef.current) {
      // Not joined yet — queue it. flushed once the channel reports
      // SUBSCRIBED (see joinSignalChannel below).
      pendingSignalsRef.current.push(signal);
      return;
    }
    void signalChannelRef.current.send({ type: "broadcast", event: "signal", payload: signal });
  }, []);

  const joinSignalChannel = useCallback(
    (callId: string, onSignal: (signal: Signal) => void) => {
      channelReadyRef.current = false;
      pendingSignalsRef.current = [];

      const channel = supabase
        .channel(`call:${callId}`, { config: { broadcast: { self: false } } })
        .on("broadcast", { event: "signal" }, ({ payload }: { payload: Signal }) => {
          onSignal(payload);
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            channelReadyRef.current = true;
            const queued = pendingSignalsRef.current;
            pendingSignalsRef.current = [];
            for (const signal of queued) {
              void channel.send({ type: "broadcast", event: "signal", payload: signal });
            }
          }
        });

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

      roleRef.current = "caller";
      setState({ phase: "outgoing", call });

      joinSignalChannel(call.id, async (signal) => {
        if (signal.type === "answer") {
          sendCommand({ type: "accept-answer", sdp: signal.sdp });
          setState({ phase: "active", call });
        } else if (signal.type === "ice-candidate") {
          sendCommand({ type: "ice-candidate", candidate: signal.candidate });
        } else if (signal.type === "decline") {
          await supabase.from("calls").update({ status: "declined" }).eq("id", call.id);
          setState({ phase: "ended", reason: "declined" });
          cleanup();
        } else if (signal.type === "hangup") {
          setState({ phase: "ended", reason: "hangup" });
          cleanup();
        }
      });

      sendCommand({ type: "create-offer", iceServers: ICE_SERVERS, video: kind === "video" });
      // The bridge replies with a "offer" BridgeEvent once ready; see
      // handleBridgeEvent below, which forwards it as the signal.
      pendingOfferRef.current = { sdp: "", kind };
    },
    [userId, joinSignalChannel, sendCommand, cleanup]
  );

  /** Callee side: accept an incoming call, answer with local SDP. */
  const answerCall = useCallback(
    async (call: CallRow, offerSdp: string, kind: CallKind) => {
      setState({ phase: "connecting", call });
      roleRef.current = "callee";
      sendCommand({
        type: "create-answer",
        iceServers: ICE_SERVERS,
        sdp: offerSdp,
        video: kind === "video",
      });

      await supabase
        .from("calls")
        .update({ status: "active", answered_at: new Date().toISOString() })
        .eq("id", call.id);

      setState({ phase: "active", call });
    },
    [sendCommand]
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
        } else if (signal.type === "ice-candidate") {
          sendCommand({ type: "ice-candidate", candidate: signal.candidate });
        }
      });
    },
    [joinSignalChannel, cleanup, sendCommand]
  );

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
    const next = !muted;
    sendCommand({ type: "set-mic", enabled: !next });
    setMuted(next);
  }, [muted, sendCommand]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOff;
    sendCommand({ type: "set-camera", enabled: !next });
    setCameraOff(next);
  }, [cameraOff, sendCommand]);

  const reset = useCallback(() => {
    setState({ phase: "idle" });
    cleanup();
  }, [cleanup]);

  /** Wired to WebRtcBridge's onEvent prop by the component that renders it. */
  const handleBridgeEvent = useCallback(
    (event: BridgeEvent) => {
      if (event.type === "ready") {
        setBridgeReady(true);
      } else if (event.type === "offer" && roleRef.current === "caller") {
        sendSignal({ type: "offer", sdp: event.sdp, kind: pendingOfferRef.current?.kind ?? "audio" });
      } else if (event.type === "answer" && roleRef.current === "callee") {
        sendSignal({ type: "answer", sdp: event.sdp });
      } else if (event.type === "ice-candidate") {
        sendSignal({ type: "ice-candidate", candidate: event.candidate });
      }
      // "log" / "error" / "local-ready" / "connection-state" are diagnostic
      // only in this app; surface them via console rather than call state.
      if (event.type === "error") {
        // eslint-disable-next-line no-console
        console.warn("[call bridge]", event.message);
      }
    },
    [sendSignal]
  );

  useEffect(() => cleanup, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    muted,
    cameraOff,
    bridgeReady,
    startCall,
    listenForOffer,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCamera,
    reset,
    setBridgeRef,
    handleBridgeEvent,
  };
}
