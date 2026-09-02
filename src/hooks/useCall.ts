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
  | { type: "decline" }
  // Sent by the callee once its signaling channel is actually joined.
  // Realtime broadcast has no replay for late joiners, so the caller's
  // original offer -- sent while the callee was still resolving the peer and
  // subscribing -- was simply dropped, leaving Accept doing nothing and the
  // caller stuck on "Ringing...". The caller re-sends the offer on this.
  | { type: "callee-ready" };

/**
 * The actual media engine lives inside a hidden WebView (see WebRtcBridge +
 * webrtcBridgeHtml) — plain browser getUserMedia/RTCPeerConnection, which
 * Expo Go's WebView already supports without a custom native module. This
 * hook owns the call state machine and signaling; it talks to the bridge only
 * through JSON commands/events, never touching WebRTC types directly.
 */
/** How long an unanswered call keeps ringing before it's marked missed. */
const RING_TIMEOUT_MS = 45_000;

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
  // Set when the user taps Accept before the caller's offer has arrived.
  // Accept used to just re-ping the caller and return, so the offer would
  // land a moment later and sit unused — the button appeared dead and you had
  // to keep tapping it. The offer handler now checks this and answers as soon
  // as the offer shows up.
  const acceptRequestedRef = useRef(false);
  const roleRef = useRef<"caller" | "callee" | null>(null);
  const startingRef = useRef(false);
  // listenForOffer() needs answerCall(), which is declared below it. A ref
  // breaks the ordering cycle without reshuffling the file.
  const answerCallRef = useRef<
    ((call: CallRow, offerSdp: string, kind: CallKind) => Promise<void>) | null
  >(null);

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
    // Must reset, or a tap that was never fulfilled on one call would
    // auto-answer the NEXT incoming call without the user consenting.
    acceptRequestedRef.current = false;
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

  /** Like sendSignal, but resolves once the broadcast has actually been
   * handed off — used before cleanup() tears the channel down. */
  const sendSignalAndWait = useCallback(async (signal: Signal) => {
    const channel = signalChannelRef.current;
    if (!channel || !channelReadyRef.current) return;
    try {
      await channel.send({ type: "broadcast", event: "signal", payload: signal });
    } catch {
      // Best effort: if the send fails the local side still tears down, and
      // the peer falls back to its own timeout.
    }
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
      // Guard against a double-tap: the call sites check state.phase, but
      // placeCall() awaits a peer lookup first, so a second tap slips through
      // that window and creates a second call row + a leaked channel.
      if (startingRef.current || roleRef.current) return;
      startingRef.current = true;

      const { data: call, error } = await supabase
        .from("calls")
        .insert({ conversation_id: conversationId, caller_id: userId, kind, status: "ringing" })
        .select("*")
        .single();

      if (error || !call) {
        startingRef.current = false;
        setState({ phase: "ended", reason: "failed" });
        return;
      }
      startingRef.current = false;

      roleRef.current = "caller";
      setState({ phase: "outgoing", call });

      joinSignalChannel(call.id, async (signal) => {
        if (signal.type === "callee-ready") {
          // The callee joined after our offer already went out (broadcast has
          // no replay), so re-send it now that someone is listening.
          const offer = pendingOfferRef.current;
          if (offer?.sdp) {
            sendSignal({ type: "offer", sdp: offer.sdp, kind: offer.kind });
          }
        } else if (signal.type === "answer") {
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

  answerCallRef.current = answerCall;

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

          // The user already tapped Accept while we were still waiting for
          // this. Consent is given, so answer immediately instead of leaving
          // the offer sitting here and the call unanswerable.
          if (acceptRequestedRef.current) {
            acceptRequestedRef.current = false;
            void answerCallRef.current?.(call, signal.sdp, signal.kind);
          }
        } else if (signal.type === "hangup") {
          setState({ phase: "ended", reason: "hangup" });
          cleanup();
        } else if (signal.type === "ice-candidate") {
          sendCommand({ type: "ice-candidate", candidate: signal.candidate });
        }
      });

      // Tell the caller we're listening now. Their offer was very likely
      // broadcast before this channel existed (resolving the peer takes two
      // network round trips first), and broadcast doesn't replay for late
      // joiners — without this the offer is lost and Accept does nothing.
      // sendSignal queues until SUBSCRIBED, so this is safe to call here.
      sendSignal({ type: "callee-ready" });
    },
    [joinSignalChannel, cleanup, sendCommand, sendSignal]
  );

  const accept = useCallback(async () => {
    if (state.phase !== "incoming") return;
    // If the offer still hasn't arrived, remember that the user wants to
    // answer and re-ask the caller for it. The offer handler in
    // listenForOffer() completes the answer the moment it lands. Previously
    // this just returned, so a tap that landed before the offer did nothing
    // at all and the call could not be answered.
    if (!pendingOfferRef.current?.sdp) {
      acceptRequestedRef.current = true;
      sendSignal({ type: "callee-ready" });
      return;
    }
    const { sdp, kind } = pendingOfferRef.current;
    await answerCall(state.call, sdp, kind);
  }, [state, answerCall, sendSignal]);

  const decline = useCallback(async () => {
    if (state.phase !== "incoming") return;
    // AWAIT the broadcast before cleanup(): removeChannel() cancels an
    // in-flight send, which is why "decline" never reached the caller and
    // left them stuck on "Ringing…".
    await sendSignalAndWait({ type: "decline" });
    await supabase.from("calls").update({ status: "declined" }).eq("id", state.call.id);
    setState({ phase: "ended", reason: "declined" });
    cleanup();
  }, [state, sendSignalAndWait, cleanup]);

  const hangup = useCallback(async () => {
    if (state.phase === "idle" || state.phase === "ended") return;
    // Same as decline: the peer only learns the call ended via this
    // broadcast, so it must actually leave before the channel is removed.
    await sendSignalAndWait({ type: "hangup" });
    await supabase
      .from("calls")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", state.call.id);
    setState({ phase: "ended", reason: "hangup" });
    cleanup();
  }, [state, sendSignalAndWait, cleanup]);

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
        const kind = pendingOfferRef.current?.kind ?? "audio";
        // Keep the SDP so it can be re-sent if the callee joins the channel
        // after this first broadcast (see the "callee-ready" handler).
        pendingOfferRef.current = { sdp: event.sdp, kind };
        sendSignal({ type: "offer", sdp: event.sdp, kind });
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

  // Missed-call timeout. Without this an unanswered call rings forever on
  // both devices — the "missed" state existed in the type and the UI but
  // nothing ever set it.
  useEffect(() => {
    if (state.phase !== "outgoing" && state.phase !== "incoming") return;

    const timer = setTimeout(() => {
      void (async () => {
        if (state.phase === "outgoing") {
          await sendSignalAndWait({ type: "hangup" });
          await supabase
            .from("calls")
            .update({ status: "missed", ended_at: new Date().toISOString() })
            .eq("id", state.call.id);
        }
        setState({ phase: "ended", reason: "missed" });
        cleanup();
      })();
    }, RING_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [state, sendSignalAndWait, cleanup]);

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
