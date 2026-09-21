import { onCallKitAudioSessionInterruption, reportMuteState } from "expo-callkit";
import { resetAudioRoute, setSpeakerphoneOn } from "expo-speaker-toggle";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BridgeEvent, WebRtcBridgeHandle } from "../components/WebRtcBridge";
import {
  clearCallKitAudioSessionWait,
  markNextCallAsAnsweredViaCallKit,
} from "../components/WebRtcBridge";
import { supabase } from "../lib/supabase";
import { ICE_SERVERS, USING_PUBLIC_TURN } from "../lib/webrtc";
import type { Database } from "../types/database";
import { useE2ee } from "./useE2ee";
import type { SignalEnvelope } from "../lib/e2e";

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
 * The media engine is native WebRTC (see WebRtcBridge, backed by
 * react-native-webrtc). This hook owns the call state machine and signaling;
 * it talks to the engine only through commands/events and never touches
 * WebRTC types directly.
 *
 * This previously ran browser WebRTC inside a WebView so it would work in
 * Expo Go. That could never have worked: the page was served from an inline
 * html source, so its origin is not secure and WKWebView leaves
 * navigator.mediaDevices undefined — the mic and camera were never
 * requested. Calls now require a development build.
 */
/** How long an unanswered call keeps ringing before it's marked missed. */
const RING_TIMEOUT_MS = 45_000;

/**
 * On-device call diagnostics. A remote debugger isn't available once a call
 * is running on a real phone away from a laptop, so this keeps a running
 * trace of the handshake in memory — timestamped, in order — and exposes it
 * through the same hook so the UI can show it on demand (long-press the
 * Accept/ringing area). This is the fastest way to see exactly which step a
 * broken call actually stopped at, instead of guessing from "it doesn't
 * work."
 */
export type CallDiagnosticsEntry = { t: number; label: string; detail?: string };
const MAX_DIAGNOSTICS_ENTRIES = 40;

export function useCall(userId: string | undefined, peerPublicKey?: string | null) {
  const { encryptSignalToPeer, decryptSignalFromPeer, startCallKem, receiveCallKem } = useE2ee();
  // Read through a ref, and settable synchronously via setPeerPublicKey.
  //
  // The prop alone is NOT enough: useCallManager resolves the peer, calls
  // setPeer(), then immediately calls startCall/listenForOffer in the same
  // tick — so the prop is still the PREVIOUS render's value at that point.
  // That desync meant one side encrypted its signals while the other was
  // still on plaintext: the offer was sent encrypted, the callee couldn't
  // decrypt it, the offer was dropped, and Accept did nothing while the
  // phone kept ringing. The caller must therefore hand us the key
  // synchronously before starting a call.
  const peerPublicKeyRef = useRef(peerPublicKey);
  if (peerPublicKey) peerPublicKeyRef.current = peerPublicKey;

  const setPeerPublicKey = useCallback((key: string | null | undefined) => {
    peerPublicKeyRef.current = key;
  }, []);

  // Same synchronous-ref requirement as peerPublicKeyRef, for the peer's
  // ML-KEM public key — used once per call to establish callKemSecretRef.
  const peerKyberPublicKeyRef = useRef<string | null | undefined>(null);
  const setPeerKyberPublicKey = useCallback((key: string | null | undefined) => {
    peerKyberPublicKeyRef.current = key;
  }, []);

  // The per-call hybrid secret (see generateCallKemSecret in lib/e2e): set
  // once, either by startCall generating it or by decodeFromWire recovering
  // it from the caller's first signal, then reused for every later signal in
  // this call. Reset in cleanup() so a new call doesn't inherit a stale one.
  const callKemSecretRef = useRef<Uint8Array | null>(null);
  // The ciphertext this device generated (if it's the caller) still needs
  // attaching to exactly one outgoing signal — the first one actually sent,
  // whichever type that turns out to be (normally the offer, but callee-ready
  // races mean it isn't always predictable which message goes first).
  const pendingKemCiphertextRef = useRef<string | null>(null);
  // In-flight (or completed) encapsulation for this call, so concurrent
  // encodeForWire calls share one mint instead of racing — see encodeForWire.
  const kemMintRef = useRef<Promise<void> | null>(null);

  const diagnosticsRef = useRef<CallDiagnosticsEntry[]>([]);
  const trace = useCallback((label: string, detail?: string) => {
    diagnosticsRef.current.push({ t: Date.now(), label, detail });
    if (diagnosticsRef.current.length > MAX_DIAGNOSTICS_ENTRIES) {
      diagnosticsRef.current.shift();
    }
    // Also mirrored to the Metro console (visible live in the terminal
    // running `expo start`), so a call can be diagnosed without touching the
    // phone at all — not just via the long-press report in CallOverlay.
    // eslint-disable-next-line no-console
    console.log(`[call trace] ${label}${detail ? ` — ${detail}` : ""}`);
  }, []);
  // Diagnostic only — see CallKitDelegate's init and onAudioSessionInterruption's
  // own comment. Subscribed for the whole component lifetime (not gated on
  // being mid-call) since an interruption that lands JUST before a call
  // starts is exactly as relevant as one mid-call, and there is no
  // meaningful per-call teardown needed for a listener this cheap.
  //
  // Added 2026-09-21 after real calls (Bek <-> Shakha) showed audio flowing
  // normally for the first several seconds, then outbound/inbound packet
  // counts freezing solid for the rest of the call with NOTHING else in the
  // trace to explain it — no ICE restart, no route event, no track state
  // change. A system audio interruption is the one thing that can do
  // exactly that, and until now it was invisible: this makes it a fact in
  // the next call's trace instead of a remaining hypothesis.
  useEffect(() => {
    const sub = onCallKitAudioSessionInterruption(({ type, reason, wasSuspended, shouldResume }) => {
      trace(
        "audio session interruption",
        `type=${type} reason=${reason} wasSuspended=${wasSuspended} shouldResume=${shouldResume}`
      );
    });
    return () => sub.remove();
  }, [trace]);

  /** Formats the trace as readable text — call time deltas in ms from the
   * first entry, so it reads as a timeline. */
  const getDiagnosticsReport = useCallback(() => {
    const entries = diagnosticsRef.current;
    if (entries.length === 0) return "No call activity recorded yet.";
    const start = entries[0].t;
    return entries
      .map((entry) => {
        const dt = String(entry.t - start).padStart(5, " ");
        return `+${dt}ms  ${entry.label}${entry.detail ? `  (${entry.detail})` : ""}`;
      })
      .join("\n");
  }, []);

  const [state, setState] = useState<CallState>({ phase: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Separate from `phase`: "active" only means signaling finished (SDP
  // exchanged, PC reports connectionState "connected"), which a TURN relay
  // that accepts the handshake but never forwards RTP satisfies just as well
  // as a genuinely working call — the "Connected, but silent both ways" bug.
  // This flips true only once WebRtcBridge's getStats() poll confirms bytes
  // are actually arriving from the peer (see "media-flowing" below), so the
  // UI can show a distinct "Connecting…" vs "Connected" instead of lying.
  const [mediaConfirmed, setMediaConfirmed] = useState(false);
  const mediaConfirmedRef = useRef(mediaConfirmed);
  mediaConfirmedRef.current = mediaConfirmed;

  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  // Video calls default to speaker on: nobody holds the phone to their ear
  // while looking at the screen, so the earpiece default made every video
  // call effectively silent unless you already knew to dig for a hidden
  // toggle. Voice calls keep the traditional earpiece default.
  const [speakerOn, setSpeakerOnState] = useState(false);
  // Read inside handleBridgeEvent, which is memoised and would otherwise
  // capture whatever speakerOn was when the call started.
  const speakerOnRef = useRef(speakerOn);
  speakerOnRef.current = speakerOn;

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
  const rejoinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOfferRef = useRef<{ sdp: string; kind: CallKind } | null>(null);
  // Set synchronously by listenForOffer, unlike stateRef — which only
  // updates on the NEXT render (setState's effect isn't visible until React
  // commits). acceptFromCallKit/declineFromCallKit run in the same tick as
  // listenForOffer on the cold-launch CallKit path, so reading stateRef
  // there saw "idle" even though the call had already been armed, and fell
  // through to the wrong branch (or, for decline, did nothing at all).
  const activeCallRowRef = useRef<CallRow | null>(null);
  // The call id answerCall has already run for — see its guard. Cleared in
  // cleanup() so the next call can be answered normally.
  const answeredCallIdRef = useRef<string | null>(null);
  // True once this call ever reached phase "active", on EITHER side —
  // answeredCallIdRef above only ever gets set on the callee. Used by
  // flushCallDiagnostics to decide whether a call that ended with no
  // explicit outcome (media-flowing/media-timeout never fired before a
  // manual hangup) is still worth a row: "was connected, then ended for an
  // unknown reason" is itself a diagnosis, unlike "never got past ringing."
  const wasActiveRef = useRef(false);
  // Defense in depth against a duplicate "answer" signal for the SAME call
  // (the root cause was fixed at the source in useCallManager's
  // incomingCallHandledRef, 2026-09-19, but a signal duplicate could in
  // principle also arrive from a network-level redelivery, not just a
  // double-answered call). Applying a second remote answer to a peer
  // connection already in "stable" state throws "Called in wrong state:
  // stable" and drops the call — this makes a duplicate a silent no-op
  // instead.
  //
  // Cleared whenever THIS side starts an ICE restart (see the three
  // restart-ice call sites). A restart makes the callee produce a genuinely
  // new answer for the same call.id, and keying the guard on call.id alone
  // meant that answer was discarded as a "duplicate" — so the caller
  // re-gathered candidates, the callee answered, and the caller ignored it,
  // leaving the connection stuck in "connecting" until someone hung up. The
  // 2026-09-19 traces show exactly this: a second answer arriving at
  // 14372ms that never moved the connection state.
  const answerAppliedForCallIdRef = useRef<string | null>(null);
  // Set when the user taps Accept before the caller's offer has arrived.
  // Accept used to just re-ping the caller and return, so the offer would
  // land a moment later and sit unused — the button appeared dead and you had
  // to keep tapping it. The offer handler now checks this and answers as soon
  // as the offer shows up.
  const acceptRequestedRef = useRef(false);
  // Caller side: set when "callee-ready" arrives before the local offer SDP
  // has actually been generated (pendingOfferRef.current.sdp is still the ""
  // placeholder set synchronously in startCall — WebRTC's createOffer is
  // async and typically resolves after this). Without this flag that
  // "callee-ready" was silently dropped (offer?.sdp was falsy) and the real
  // offer, once generated, was sent only once — if the callee's channel
  // wasn't joined yet at that exact moment, broadcast's no-replay semantics
  // lost it for good, leaving Accept stuck sending "callee-ready" forever.
  const calleeReadyRef = useRef(false);
  // Every ICE candidate this side has broadcast, kept so they can be re-sent
  // when the peer announces it has joined the channel (see "callee-ready").
  const sentCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const roleRef = useRef<"caller" | "callee" | null>(null);
  // How many ICE restarts this call has already attempted, capped so a
  // genuinely dead network ends the call instead of looping forever.
  //
  // Raised from a single boolean to a count of 2 on 2026-09-19: one restart
  // has to cover BOTH failure shapes (connectionState "failed", and
  // "connected but no RTP"), so a call that burned its only retry on the
  // first had nothing left for the second. Each restart is a fresh
  // candidate gathering pass, and with a working relay now configured the
  // second attempt has a real chance rather than being a formality.
  const iceRestartCountRef = useRef(0);
  /** True between sending a restart-ice and the next connected/media-flowing.
   *
   * Three independent handlers can each decide to restart for the same call
   * within seconds of each other: "connection-state: failed",
   * "negotiation-stalled" (9s, from the bridge's own timer) and
   * "media-timeout" (12s, from watchForInboundMedia). Before this, two of
   * them landing meant two restart offers, two renegotiate-answers from the
   * callee, and the caller applying only the first — leaving its remote
   * description matched to restart #1 while the callee's local description
   * matched restart #2, which is a permanently stuck "connecting".
   *
   * stallRestartedRef already prevented a second STALL restart, but not a
   * stall restart followed by a media-timeout restart. */
  const restartInFlightRef = useRef(false);
  // Raised from 2 to 3, 2026-09-20, for cross-border reliability: an
  // international path has more candidate pairs that can individually fail
  // (longer route, more middleboxes), so it costs an extra ~9-12s of
  // "Connecting…" in the worst case but gives ICE a third fresh gathering
  // pass before giving up on a call the user is still holding the phone up
  // for.
  const MAX_ICE_RESTARTS = 3;
  /** True once any restart has happened — for diagnostics labelling. */
  const iceRestartedRef = { get current() { return iceRestartCountRef.current > 0; } };
  // Latest connection stats from the bridge, held until the call ends so
  // they can be written to call_diagnostics with the final outcome — the
  // stats arrive mid-call, but the outcome is only known at teardown.
  const callStatsRef = useRef<Extract<BridgeEvent, { type: "call-stats" }> | null>(null);
  // Set at teardown so the diagnostics row records what actually happened
  // rather than inferring it from state that cleanup() has already reset.
  const callOutcomeRef = useRef<string | null>(null);
  // cleanup() is declared above the function that writes diagnostics (which
  // needs userId and trace), so it is reached through a ref rather than
  // reordering the file around a single call.
  const flushCallDiagnosticsRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);
  // listenForOffer() needs answerCall(), which is declared below it. A ref
  // breaks the ordering cycle without reshuffling the file.
  const answerCallRef = useRef<
    ((call: CallRow, offerSdp: string, kind: CallKind) => Promise<void>) | null
  >(null);

  const setBridgeRef = useCallback((handle: WebRtcBridgeHandle | null) => {
    bridgeRef.current = handle;
  }, []);

  // Commands sent before the bridge has mounted. CallOverlay mounts
  // WebRtcBridge only once the phase leaves "idle", and startCall/accept
  // both call sendCommand in the SAME tick as the setState that triggers
  // that mount — so bridgeRef.current is still null at that point and the
  // command used to just vanish into the `?.`. create-offer hitting this
  // exactly is why calls could ring, open the mic, and then never actually
  // produce an SDP offer: the callee had nothing to answer and Accept could
  // wait forever with "no offer yet". Queued here and flushed in order once
  // the bridge reports "ready", instead of adding a bespoke pending-ref for
  // every command type that happens to race this window.
  const pendingCommandsRef = useRef<object[]>([]);

  // Pending "the connection has been disconnected too long" timer — see the
  // connection-state handler. Held in a ref so it can be cancelled the
  // moment ICE recovers.
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendCommand = useCallback((command: object) => {
    if (bridgeRef.current) {
      // Sent directly, so it must NOT also sit in the replay queue.
      //
      // Both paths could fire for one command: it was queued while
      // bridgeRef was still null, and then the "ready" handler flushed the
      // queue while this same command was ALSO delivered directly once the
      // ref appeared. The callee then ran create-answer twice, and the
      // second run's createPeer() closed the connection the first run's
      // media was already bound to — one second of audio, then silence
      // (measured Bek → Shakha, 2026-09-20).
      const queue = pendingCommandsRef.current;
      const type = (command as { type?: string }).type;
      // Only for the commands that START a call. Those are identified by
      // their type alone — there is exactly one create-answer per call — so
      // dropping an older queued copy is always right.
      //
      // Scoped deliberately: ice-candidate, set-mic and set-camera all
      // carry a distinct payload per message, and filtering those by type
      // would silently discard a queued candidate when a different one is
      // sent directly, losing it permanently (the sentCandidates replay
      // re-sends to the PEER, never to the local bridge).
      if (
        queue.length > 0 &&
        (type === "create-offer" || type === "create-answer" || type === "start-local")
      ) {
        pendingCommandsRef.current = queue.filter(
          (queued) => (queued as { type?: string }).type !== type
        );
      }
      bridgeRef.current.send(command);
      return;
    }
    // Queuing a teardown command is worse than dropping it: "hangup" exists
    // to free the camera/mic NOW, and a bridge that isn't mounted has
    // nothing to free — but the queued copy would then fire at the START of
    // the NEXT call, killing its media the moment it opened. Only setup
    // commands are worth replaying.
    if ((command as { type?: string }).type === "hangup") return;
    pendingCommandsRef.current.push(command);
  }, []);

  /** Opens the local mic/camera, deferring until the bridge exists. */
  const requestLocalMedia = useCallback(
    (video: boolean, iceServers?: typeof ICE_SERVERS) => {
      // iceServers is passed ONLY by the caller (startCall). It makes the
      // bridge build the peer connection immediately and begin gathering
      // ICE while the camera is still opening — see start-local's branch in
      // WebRtcBridge for the measurements behind this. The callee must NOT
      // pass it: create-answer builds its connection around the remote
      // offer, and a pre-built one would be replaced anyway.
      sendCommand({ type: "start-local", video, iceServers });
    },
    [sendCommand]
  );

  const cleanup = useCallback(() => {
    // Flush diagnostics FIRST: everything this needs (the call row, the
    // stats, the trace) is cleared by the resets below, and the whole point
    // of the table is that this survives the call.
    flushCallDiagnosticsRef.current?.();
    sendCommand({ type: "hangup" });
    setMediaConfirmed(false);
    roleRef.current = null;
    iceRestartCountRef.current = 0;
    restartInFlightRef.current = false;
    // Drop the loudspeaker preference the moment a call ends, not on the 3s
    // auto-dismiss timer in reset().
    //
    // speakerEnabled lives in the native module and drives the session MODE
    // (.videoChat = loudspeaker profile, .voiceChat = earpiece). reset() is
    // the only other thing that clears it, and it runs 3s after the call
    // ends — so starting a new call inside that window inherited the
    // previous call's preference. Measured 2026-09-20: a video call at
    // 10:21:36 was followed by an AUDIO call at 10:22:17, and the caller's
    // leg came up in .videoChat/[Speaker] for a voice call while the callee
    // correctly used .voiceChat/[Receiver] — the two ends on different
    // profiles for the same call.
    resetAudioRoute();
    pendingOfferRef.current = null;
    activeCallRowRef.current = null;
    answeredCallIdRef.current = null;
    answerAppliedForCallIdRef.current = null;
    wasActiveRef.current = false;
    // Disarm the CallKit audio-session wait, so it can never leak into the
    // NEXT call.
    //
    // The flag is armed in three places (startCall, and two paths in
    // useCallManager) but was consumed by only the first getMedia that ran
    // — and a single answer can arm it more than once. Whatever was left
    // over stayed armed for the following call, where waitForCallKitAudioSession
    // then reported "CallKit owns the session" for a call CallKit was never
    // told about. acquireMedia takes that to mean CallKit will enable the
    // audio unit itself, so it skips setAudioModeAsync, configureForVoiceCall
    // AND enableWebRtcAudio(true) — and with useManualAudio = true nothing
    // else ever turns the unit on. The call then connects perfectly, video
    // shows, getStats confirms inbound RTP, and there is no sound at all:
    // exactly the "звонок активен, звука нет" report on 2026-09-19, whose
    // trace shows a healthy srflx/relay pair with media-flowing confirmed.
    //
    // clearCallKitAudioSessionWait has existed for this since it was
    // written; nothing ever called it.
    clearCallKitAudioSessionWait();
    // Or a call to peer B would be encrypted with peer A's key: the
    // render-time assignment only overwrites these when the prop is
    // non-null, so a null prop (setPeer(null) on idle) left the previous
    // peer's key in place for any path that doesn't re-resolve the peer.
    peerPublicKeyRef.current = null;
    peerKyberPublicKeyRef.current = null;
    // Otherwise a channel-join retry armed for a call that just ended fires
    // later and rejoins a signaling channel nothing is listening to anymore.
    if (rejoinTimerRef.current) {
      clearTimeout(rejoinTimerRef.current);
      rejoinTimerRef.current = null;
    }
    // Must reset, or a tap that was never fulfilled on one call would
    // auto-answer the NEXT incoming call without the user consenting.
    acceptRequestedRef.current = false;
    calleeReadyRef.current = false;
    sentCandidatesRef.current = [];
    channelReadyRef.current = false;
    // A crashed/failed startCall left this true forever, which silently
    // disabled every later call attempt until the app was restarted.
    startingRef.current = false;
    pendingCommandsRef.current = [];
    pendingSignalsRef.current = [];
    // Each call gets its own hybrid secret — carrying one over would mean
    // the next call's signals are encrypted with a key derived from a KEM
    // ciphertext that was never sent for THIS call.
    callKemSecretRef.current = null;
    pendingKemCiphertextRef.current = null;
    // Or the next call would await a resolved promise from the previous one
    // and skip minting its own secret entirely.
    kemMintRef.current = null;
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }

    if (signalChannelRef.current) {
      void supabase.removeChannel(signalChannelRef.current);
      signalChannelRef.current = null;
    }
  }, [sendCommand]);

  /** Writes one row to call_diagnostics for the call that just ended, so the
   * reason a call failed outlives the process. Fire-and-forget and fully
   * guarded: diagnostics must never interfere with ending a call. */
  const flushCallDiagnostics = useCallback(() => {
    const call = activeCallRowRef.current;
    const stats = callStatsRef.current;
    const outcome = callOutcomeRef.current;
    const wasAnswered = wasActiveRef.current;
    // Reset immediately so a second cleanup() (teardown paths can overlap)
    // cannot write the same call twice.
    callStatsRef.current = null;
    callOutcomeRef.current = null;
    // Nothing worth recording for a call that never got past dialing/ringing
    // — no call row, or never answered. A call that WAS answered is recorded
    // even with no explicit outcome and no stats: a user hanging up manually
    // before either media-flowing or media-timeout fired (e.g. right after
    // the 10-second mark this exact symptom produces) used to leave nothing
    // behind at all, which is precisely the case this table exists to catch
    // — "the call was answered, then ended, and nobody knows why" must
    // itself be a recorded outcome, not silence.
    if (!call || !userId || !wasAnswered) return;

    const report = getDiagnosticsReport();
    void supabase
      .from("call_diagnostics")
      .insert({
        call_id: call.id,
        user_id: userId,
        outcome:
          outcome ?? (stats?.msToMedia != null ? "connected" : "ended_no_media_event"),
        selected_candidate_pair: stats?.selectedCandidatePair ?? null,
        turn_server: stats?.turnServer ?? null,
        using_public_turn: USING_PUBLIC_TURN,
        ms_to_media: stats?.msToMedia ?? null,
        bytes_received: stats?.bytesReceived ?? null,
        packets_lost: stats?.packetsLost ?? null,
        jitter_ms: stats?.jitterMs ?? null,
        trace: report,
      })
      .then(({ error }) => {
        if (error) {
          // eslint-disable-next-line no-console
          console.error("[useCall] failed to write call diagnostics:", error.message);
        }
      });
  }, [userId, getDiagnosticsReport]);

  flushCallDiagnosticsRef.current = flushCallDiagnostics;

  // Watches the call ROW directly, independent of the broadcast signalling
  // channel used for offer/answer/hangup. That channel has no guaranteed
  // delivery — it drops on a background transition, a network handover, or
  // simply a lost packet — and when the "hangup" broadcast never arrived,
  // this side's phase never moved to "ended": callActive stayed true forever,
  // WebRtcBridge never called releaseMedia, and the camera/mic stayed live
  // until the app was killed by hand. Postgres changes on the row itself is
  // the fallback: whichever side DID manage to write status="ended" (hangup
  // always writes this even when the broadcast to the peer is lost) now
  // reaches the other side through a completely different transport.
  useEffect(() => {
    const current = stateRef.current;
    if (current.phase === "idle" || current.phase === "ended" || !("call" in current)) return;
    const callId = current.call.id;

    let cancelled = false;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const join = () => {
      const channel = supabase
        // private: true routes the join through Realtime Authorization, so
        // the server checks the RLS policy on realtime.messages (see
        // 039_private_call_channels.sql) instead of admitting anyone who
        // knows the call id.
        .channel(`call-status:${callId}`, { config: { private: true } })
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "calls", filter: `id=eq.${callId}` },
          (payload) => {
            const status = (payload.new as { status?: string } | null)?.status;
            const latest = stateRef.current;
            if (latest.phase === "idle" || latest.phase === "ended") return;
            if (status === "ended" || status === "declined" || status === "missed") {
              trace("call row watchdog", `status=${status} — signalling channel likely dropped the hangup`);
              setState({
                phase: "ended",
                reason: status === "declined" ? "declined" : status === "missed" ? "missed" : "hangup",
              });
              cleanup();
            }
          }
        )
        .subscribe((status) => {
          if (cancelled) return;
          // Same cold-launch Realtime-auth race as joinSignalChannel: a
          // private channel joined within milliseconds of process launch
          // (the CallKit-answered path) can fail its first attempt before
          // the restored session's JWT has reached the Realtime socket.
          // This channel is a fallback safety net, not the primary
          // signaling path, so a missed retry here is lower-stakes than on
          // joinSignalChannel — but leaving it permanently unsubscribed
          // after a transient error silently disables the hangup-recovery
          // fallback for the rest of the call, which is exactly the kind of
          // failure this channel exists to catch.
          if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT") return;
          retryTimer = setTimeout(() => {
            if (cancelled) return;
            if (stateRef.current.phase === "idle" || stateRef.current.phase === "ended") return;
            void supabase.removeChannel(channel);
            join();
          }, 800);
        });

      activeChannel = channel;
    };

    join();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (activeChannel) void supabase.removeChannel(activeChannel);
    };
    // Re-subscribes whenever a new call starts (state.phase transitions into
    // a non-idle, non-ended value) — the filter is baked into the channel at
    // subscribe time and can't be updated on an existing one.
  }, [state.phase, cleanup, trace]);

  // Wire format: encrypted straight to the peer's public key whenever it's
  // known, so SDP/ICE — which carry real IP addresses — aren't sent as plain
  // JSON over Realtime broadcast. Falls back to plaintext only if the peer's
  // key genuinely isn't available (e.g. they've never opened a version of
  // the app that publishes one) rather than dropping the call outright; the
  // media itself is still protected either way by WebRTC's own DTLS-SRTP.
  const encodeForWire = useCallback(
    async (signal: Signal): Promise<{ encrypted: SignalEnvelope } | { plain: Signal }> => {
      const peerKey = peerPublicKeyRef.current;
      if (peerKey) {
        // ONLY the caller mints the call's hybrid secret. An ML-KEM
        // encapsulation is one-way: whoever runs it holds a secret the other
        // side can only obtain by decapsulating that exact ciphertext. When
        // both sides encapsulated — which is what happened here, because the
        // callee's "callee-ready" is itself an outgoing signal — each ended
        // up sealing under a secret the other had no way to derive, and both
        // silently dropped everything the other sent. The offer never
        // arrived, Accept did nothing, and the call rang until it timed out.
        // The callee gets this secret instead by decapsulating the
        // kemCiphertext the caller attaches (see decodeFromWire).
        if (
          roleRef.current === "caller" &&
          !callKemSecretRef.current &&
          !kemMintRef.current &&
          peerKyberPublicKeyRef.current
        ) {
          // Memoised as a PROMISE, not just guarded by the secret ref.
          // startCallKem is async, so two signals encoded in the same tick —
          // which is the normal case, ICE candidates arrive in bursts — both
          // saw a null secret, both encapsulated, and the second overwrote
          // the first. The callee then decapsulated whichever ciphertext it
          // happened to receive and every message sealed under the other
          // secret failed to open. Awaiting one shared promise makes the
          // mint happen exactly once per call.
          kemMintRef.current = startCallKem(peerKyberPublicKeyRef.current).then((started) => {
            if (started && !callKemSecretRef.current) {
              callKemSecretRef.current = started.secret;
              pendingKemCiphertextRef.current = started.ciphertext;
            }
          });
        }
        if (kemMintRef.current) {
          try {
            await kemMintRef.current;
          } catch {
            // Encapsulation failed (a malformed peer Kyber key). Fall through
            // with no call secret: encryptSignal then seals X25519-only,
            // which the peer can still open, rather than failing the call.
          }
        }

        const attachKem = pendingKemCiphertextRef.current ?? undefined;
        const envelope = encryptSignalToPeer(signal, peerKey, callKemSecretRef.current, attachKem);
        if (envelope) {
          // Deliberately NOT cleared here. It used to be nulled the moment a
          // signal was encoded ("attached exactly once"), which silently
          // broke the call whenever that encoded signal never actually went
          // out: sendSignal's re-queue path (channel replaced mid-encode by
          // a CHANNEL_ERROR retry — the documented cold-launch case) pushes
          // the RAW signal back onto the queue and throws the envelope away,
          // so the re-encode found the ref already null and the offer went
          // out with no KEM ciphertext at all. The callee then had no way to
          // derive the call secret and dropped every signal as undecryptable
          // — "Accept does nothing, the phone rings forever". Re-sending the
          // ciphertext on subsequent signals is cheap (~1KB) and the
          // receiver's adoption is idempotent (it decapsulates to the same
          // secret every time), so carrying it until the call ends is the
          // safe trade. Cleared in cleanup() with the rest of the KEM state.
          trace(`send:${signal.type}`, callKemSecretRef.current ? "encrypted (hybrid PQ)" : "encrypted");
          return { encrypted: envelope };
        }
        trace(`send:${signal.type}`, "encrypt FAILED, falling back to plaintext");
      } else {
        trace(`send:${signal.type}`, "plaintext, no peer key yet");
      }
      // No peer key (or no local keypair yet) — send in the clear rather than
      // not at all. The media stream is still DTLS-SRTP encrypted either way;
      // only the SDP/ICE metadata is exposed on this path.
      return { plain: signal };
    },
    [encryptSignalToPeer, startCallKem, trace]
  );

  const decodeFromWire = useCallback(
    async (payload: { encrypted: SignalEnvelope } | { plain: Signal }): Promise<Signal | null> => {
      // Accept plaintext unconditionally: the peer either has no key for us
      // or hasn't finished loading its own. Deliberately does NOT flip this
      // side to plaintext — inferring the mode from whichever message
      // happens to arrive first is order-dependent and unsound, and an
      // encrypted message that arrived before any plaintext one would have
      // already been dropped by then. Each side simply encrypts whenever it
      // can and reads whatever it is sent.
      if ("plain" in payload) {
        trace(`recv:${payload.plain.type}`, "plaintext");
        return payload.plain;
      }

      const peerKey = peerPublicKeyRef.current;
      if (!peerKey) {
        trace("recv:encrypted", "DROPPED — no peer key to decrypt with");
        return null;
      }

      // The caller's first encrypted message carries this call's KEM
      // ciphertext. Adopt it unconditionally rather than only when no secret
      // is held yet: the caller is the sole authority on the call secret
      // (see encodeForWire), so anything this side already has is either the
      // same value or a stale one from a previous call, and preferring the
      // local copy is how both ends previously ended up talking past each
      // other with keys the other could not derive.
      if (payload.encrypted.kemCiphertext) {
        // receiveCallKem decapsulates, which THROWS on a ciphertext that
        // isn't a well-formed ML-KEM-768 encapsulation. Unhandled, that
        // rejection escaped through the .then() in joinSignalChannel's
        // broadcast handler and killed the whole signal-handling path for
        // the rest of the call, not just this one message.
        try {
          const recovered = await receiveCallKem(payload.encrypted.kemCiphertext);
          if (recovered) callKemSecretRef.current = recovered;
        } catch {
          trace("recv:encrypted", "KEM decapsulation failed — trying X25519-only");
        }
      }

      // Try the hybrid key first when we hold one, then fall back to plain
      // X25519 (and vice versa). The envelope carries no marker for which
      // scheme sealed it, so each side was choosing purely from whether IT
      // held a call secret — and the two sides do not acquire that secret at
      // the same moment. The caller mints its secret when it encodes its
      // FIRST outgoing signal, which is usually an ICE candidate generated
      // right after setLocalDescription; every "callee-ready" the callee
      // re-sends after that instant (accept() and acceptFromCallKit both
      // send one) is still sealed X25519-only, because the callee has no
      // secret until the offer carrying the ciphertext reaches it. The
      // caller then opened those with secretbox, failed, and dropped them —
      // silently disabling the one mechanism that recovers a lost offer.
      // Trying both costs one extra symmetric open on a rare path and
      // removes the ordering assumption entirely.
      const decrypted =
        decryptSignalFromPeer<Signal>(payload.encrypted, peerKey, callKemSecretRef.current) ??
        (callKemSecretRef.current
          ? decryptSignalFromPeer<Signal>(payload.encrypted, peerKey, null)
          : null);
      if (!decrypted) {
        trace("recv:encrypted", "DROPPED — decryption failed (wrong/stale key?)");
        return null;
      }
      trace(`recv:${decrypted.type}`, callKemSecretRef.current ? "decrypted ok (hybrid PQ)" : "decrypted ok");
      return decrypted;
    },
    [decryptSignalFromPeer, receiveCallKem, trace]
  );

  const sendSignal = useCallback(
    (signal: Signal) => {
      if (!signalChannelRef.current || !channelReadyRef.current) {
        // Queue it — flushed once the channel reports SUBSCRIBED (see
        // joinSignalChannel below).
        //
        // The no-channel-yet case used to `return` here, silently discarding
        // the signal. That is the CallKit-answer bug: acceptFromCallKit can
        // run BEFORE listenForOffer has created the channel (the CallKit
        // answer event can beat the Realtime "ringing" row), and the
        // "callee-ready" it sends — the message that asks the caller to
        // re-send an offer the callee missed — was thrown away. The callee
        // then waited forever for an offer nobody would ever re-send, which
        // is precisely "CallKit says connected, the app shows Ringing and
        // never connects." Answering in-app never hit this because
        // listenForOffer always runs first there.
        pendingSignalsRef.current.push(signal);
        return;
      }
      const channel = signalChannelRef.current;
      void encodeForWire(signal)
        .then((payload) => {
          // encodeForWire is async (it can await a KEM mint) — if a channel
          // rejoin replaced signalChannelRef while this was in flight, the
          // old `channel` is already removed and `.send` on it is silently
          // cancelled. Re-queue instead of losing the signal outright; the
          // new channel's SUBSCRIBED handler will flush it.
          if (signalChannelRef.current !== channel) {
            pendingSignalsRef.current.push(signal);
            return;
          }
          void channel.send({ type: "broadcast", event: "signal", payload });
        })
        .catch((error) => {
          // No catch here previously meant a throw inside encodeForWire (not
          // just the KEM-mint await, which already has its own try/catch,
          // but encryptSignalToPeer itself) silently dropped the signal with
          // no trace at all — on the offer/callee-ready path, an
          // unanswerable call with zero diagnostic signal.
          trace("sendSignal FAILED", String(error));
        });
    },
    [encodeForWire, trace]
  );

  /** Like sendSignal, but resolves once the broadcast has actually been
   * handed off — used before cleanup() tears the channel down. */
  const sendSignalAndWait = useCallback(
    async (signal: Signal) => {
      const channel = signalChannelRef.current;
      if (!channel) return;
      // Wait (briefly) for the join instead of dropping the signal. Declining
      // or hanging up in the first moments of a call happened before the
      // channel reported SUBSCRIBED, and this returned silently — cleanup()
      // then destroyed the channel, so the peer never learned and kept ringing
      // until the 45s missed-call timeout.
      if (!channelReadyRef.current) {
        const joined = await new Promise<boolean>((resolve) => {
          const startedAt = Date.now();
          const poll = setInterval(() => {
            if (channelReadyRef.current) {
              clearInterval(poll);
              resolve(true);
            } else if (Date.now() - startedAt > 3000 || signalChannelRef.current !== channel) {
              clearInterval(poll);
              resolve(false);
            }
          }, 50);
        });
        if (!joined) return;
      }
      try {
        const payload = await encodeForWire(signal);
        await channel.send({ type: "broadcast", event: "signal", payload });
      } catch {
        // Best effort: if the send fails the local side still tears down, and
        // the peer falls back to its own timeout.
      }
    },
    [encodeForWire]
  );

  const joinSignalChannel = useCallback(
    (callId: string, onSignal: (signal: Signal) => void) => {
      channelReadyRef.current = false;
      // NOT cleared. Anything queued before the channel existed is for THIS
      // call and must survive to the flush below — clearing here is the other
      // half of the dropped-"callee-ready" bug described in sendSignal:
      // acceptFromCallKit queues callee-ready, listenForOffer then runs and
      // wiped the queue, so the caller was never asked to re-send its offer.
      // cleanup() already empties this between calls, so a stale signal from
      // a previous call cannot leak in here.
      // Drop any channel still held from a previous call. Overwriting the ref
      // left the old one subscribed for the life of the process, and its
      // handler kept mutating this call's state.
      if (signalChannelRef.current) {
        void supabase.removeChannel(signalChannelRef.current);
        signalChannelRef.current = null;
      }

      const channel = supabase
        .channel(`call:${callId}`, {
          config: { broadcast: { self: false }, private: true },
        })
        .on(
          "broadcast",
          { event: "signal" },
          ({ payload }: { payload: { encrypted: SignalEnvelope } | { plain: Signal } }) => {
            // A signal that fails to decrypt (wrong/stale peer key) is
            // dropped rather than crashing the call state machine on it —
            // the existing signal-loss recovery paths (callee-ready
            // resend, ring timeout) already handle a missing message.
            void decodeFromWire(payload).then((signal) => {
              if (signal) onSignal(signal);
            });
          }
        );

      // Set BEFORE subscribe(), not after. A CHANNEL_ERROR can be delivered
      // synchronously from inside .subscribe() (an auth failure does exactly
      // that), and the retry below only rejoins when
      // `signalChannelRef.current === channel`. With the assignment after
      // subscribe, that comparison ran against the PREVIOUS channel (or
      // null), the rejoin was silently skipped, channelReadyRef stayed false
      // forever, and every queued signal — including the callee-ready that
      // asks the caller to re-send its offer — was never sent. The call then
      // rings until it times out with no offer ever arriving.
      signalChannelRef.current = channel;

      channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            channelReadyRef.current = true;
            const queued = pendingSignalsRef.current;
            pendingSignalsRef.current = [];
            for (const signal of queued) {
              void encodeForWire(signal).then((payload) => {
                // Same re-queue guard as sendSignal: a second rejoin can
                // replace the channel again while this encode is still in
                // flight (the exact case the retry-on-CHANNEL_ERROR path
                // below exists for) — without this, the message this retry
                // was trying to save is the one that gets silently dropped.
                if (signalChannelRef.current !== channel) {
                  pendingSignalsRef.current.push(signal);
                  return;
                }
                void channel.send({ type: "broadcast", event: "signal", payload });
              });
            }
            return;
          }

          // CHANNEL_ERROR / TIMED_OUT were previously ignored entirely — the
          // only status this ever branched on was SUBSCRIBED, so a failed
          // join left channelReadyRef stuck false FOREVER and every signal
          // queued in pendingSignalsRef never got flushed. This is a real
          // race on a cold launch specifically: this channel is `private:
          // true` (039_private_call_channels.sql's RLS on realtime.messages
          // needs auth.uid() already attached to the socket), and a
          // CallKit-answered call reaches this code within milliseconds of
          // process start — before supabase-js has necessarily finished
          // applying the restored session's JWT to the Realtime socket's own
          // auth, separately from the REST client being usable. An in-app
          // answer never hits this: the app has been warm for minutes, so
          // Realtime auth was long since established. Retrying the join
          // (same call id, same handler) covers exactly that gap — the
          // token attaches within a second or two of socket connect, and by
          // the second attempt Realtime auth is normally settled.
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            trace("signal channel", `${status} — retrying join for call ${callId}`);
            if (rejoinTimerRef.current) clearTimeout(rejoinTimerRef.current);
            rejoinTimerRef.current = setTimeout(() => {
              // Only rejoin if nothing already replaced this channel (a new
              // call, or cleanup) — signalChannelRef is the source of truth
              // for "is this still the channel we care about".
              if (signalChannelRef.current === channel) {
                joinSignalChannel(callId, onSignal);
              }
            }, 800);
          }
      });

      return channel;
    },
    [encodeForWire, decodeFromWire, trace]
  );

  /** Caller side: create the call row, then ring the other participant. */
  const startCall = useCallback(
    async (conversationId: string, kind: CallKind) => {
      diagnosticsRef.current = [];
      trace("startCall", `kind=${kind} peerKey=${peerPublicKeyRef.current ? "present" : "MISSING"}`);
      if (!userId) {
        trace("startCall", "ABORTED — no userId");
        return;
      }
      // Guard against a double-tap: the call sites check state.phase, but
      // placeCall() awaits a peer lookup first, so a second tap slips through
      // that window and creates a second call row + a leaked channel.
      if (startingRef.current || roleRef.current) {
        trace("startCall", "ABORTED — already starting/in a call");
        return;
      }
      startingRef.current = true;

      const { data: call, error } = await supabase
        .from("calls")
        .insert({ conversation_id: conversationId, caller_id: userId, kind, status: "ringing" })
        .select("*")
        .single();

      if (error || !call) {
        startingRef.current = false;
        // cleanup() before the state change: without it roleRef and the
        // previous call's channel/queues survive a failed start, and a
        // leftover non-null roleRef makes every SUBSEQUENT startCall abort
        // at its own guard — the user taps Call and nothing happens at all,
        // permanently, until the app is restarted.
        cleanup();
        setState({ phase: "ended", reason: "failed" });
        return;
      }
      startingRef.current = false;

      roleRef.current = "caller";
      // Set for the caller too, not just the callee (listenForOffer). Any
      // ref-based path that treats this as "the call in progress" — hangup,
      // declineFromCallKit — was simply dead on an outgoing call.
      activeCallRowRef.current = call;
      setState({ phase: "outgoing", call });

      // This call is about to be reported to CallKit too (see
      // useCallManager's "outgoing" branch, which fires reportOutgoingCallStarted
      // off this same phase change) via CXStartCallAction — and CallKit
      // activates the shared AVAudioSession for that action exactly the same
      // way it does for CXAnswerCallAction, calling didActivate on
      // CallKitDelegate. Only the callee path armed
      // waitForCallKitAudioSession before today; the caller path opened the
      // mic and unconditionally ran setAudioModeAsync/configureForVoiceCall/
      // enableWebRtcAudio itself, believing it alone owned the session, while
      // CallKit was independently configuring and activating the SAME session
      // for the SAME call a moment later. That is the caller-side mirror of
      // the "answer from CallKit, connects, no audio" bug this file already
      // fixes for callees — reported here as "connected with real RTP flow on
      // both legs but total silence on both legs", since only one of the two
      // legs (whichever one was the caller) needed to be racing CallKit for
      // this to kill the call's audio in both directions.
      markNextCallAsAnsweredViaCallKit();
      // Open the mic (and camera for a video call) immediately, so iOS shows
      // its permission prompt while the phone is ringing instead of only
      // once the peer answers. create-offer below reuses the same stream, so
      // this costs nothing and makes the prompt appear when the user expects.
      requestLocalMedia(kind === "video", ICE_SERVERS);

      joinSignalChannel(call.id, async (signal) => {
        if (signal.type === "callee-ready") {
          // The callee joined after our offer already went out (broadcast has
          // no replay), so re-send it now that someone is listening. If the
          // offer isn't generated yet, remember the callee is waiting so the
          // "offer" BridgeEvent handler below can send it the moment it's
          // ready instead of silently dropping this.
          const offer = pendingOfferRef.current;
          if (offer?.sdp) {
            sendSignal({ type: "offer", sdp: offer.sdp, kind: offer.kind });
          } else {
            calleeReadyRef.current = true;
          }
          // Re-send every candidate gathered so far. ICE gathering starts at
          // setLocalDescription, long before the callee has resolved the peer
          // and subscribed, so those first candidates were broadcast into an
          // empty channel and lost — and broadcast has no replay. Host
          // candidates are usually in that lost set, which is why a call could
          // fail even with both phones on the same Wi-Fi.
          for (const candidate of sentCandidatesRef.current) {
            sendSignal({ type: "ice-candidate", candidate });
          }
        } else if (signal.type === "answer") {
          // Guarded like the connection-state handler below. removeChannel
          // is async, so an "answer" frame already in flight is still
          // delivered after the call ended — and setting "active"
          // unconditionally resurrected an ended call into a phase with no
          // peer connection, no timers and no exit, which also flipped
          // callActive back to true and left the camera indicator lit with
          // no way to turn it off short of killing the app.
          if (stateRef.current.phase === "idle" || stateRef.current.phase === "ended") return;
          // See answerAppliedForCallIdRef's own comment: a second answer for
          // a call this side already applied one for is a duplicate, not a
          // renegotiation — accept-answer's setRemoteDescription throws on
          // a peer connection already in "stable" state if this isn't
          // skipped.
          if (answerAppliedForCallIdRef.current === call.id) return;
          answerAppliedForCallIdRef.current = call.id;
          wasActiveRef.current = true;
          sendCommand({ type: "accept-answer", sdp: signal.sdp });
          setState((c) => (c.phase === "idle" || c.phase === "ended" ? c : { phase: "active", call }));
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
    [userId, joinSignalChannel, sendCommand, cleanup, trace]
  );

  /** Callee side: accept an incoming call, answer with local SDP. */
  const answerCall = useCallback(
    async (call: CallRow, offerSdp: string, kind: CallKind) => {
      // Idempotent per call id. answerCall is reachable from three places
      // (accept, listenForOffer's offer handler, acceptFromCallKit) and two
      // of them go through answerCallRef, bypassing every closure check —
      // and useCallManager can invoke acceptFromCallKit twice for one call
      // (the live onCallKitAnswer event AND checkForCallKitAnswer on the
      // same foregrounding). Running twice sends a second "create-answer",
      // and createPeer closes the peer connection that was already
      // negotiating: the call connects and then immediately fails. Same
      // shape as reportedAnsweredIdRef in useCallManager, which exists for
      // exactly this class of double-invocation.
      if (answeredCallIdRef.current === call.id) {
        trace("answerCall SKIPPED", "already answered this call");
        return;
      }
      const phase = stateRef.current.phase;
      if (phase === "ended" || phase === "idle") {
        trace("answerCall ABORTED", `phase=${phase}`);
        return;
      }
      answeredCallIdRef.current = call.id;
      trace("answerCall", `kind=${kind}`);
      setState({ phase: "connecting", call });
      roleRef.current = "callee";
      sendCommand({
        type: "create-answer",
        iceServers: ICE_SERVERS,
        sdp: offerSdp,
        video: kind === "video",
      });

      // Fire-and-forget: this is call-log bookkeeping, not part of the media
      // path. Awaiting it held the UI on "Connecting…" for the length of a
      // round trip on a slow network, and a failed write would strand the
      // call there entirely. The error IS surfaced (not swallowed) — every
      // observed test call had answered_at stuck at null with no visible
      // cause, and a bare `void` on a Postgres write hides exactly the kind
      // of RLS/permission failure that would explain that silently.
      supabase
        .from("calls")
        .update({ status: "active", answered_at: new Date().toISOString() })
        .eq("id", call.id)
        .then(({ error }) => {
          if (error) {
            trace("answerCall: calls update FAILED", error.message);
            console.error("[useCall] failed to mark call answered:", error.message, error);
          }
        });

      trace("phase -> active");
      wasActiveRef.current = true;
      // Same guard: the call can be ended (remote hangup, CallKit decline)
      // between the create-answer above and this line.
      setState((c) => (c.phase === "idle" || c.phase === "ended" ? c : { phase: "active", call }));
    },
    [sendCommand, trace]
  );

  answerCallRef.current = answerCall;

  /** Listens for an incoming offer on a call id the app already knows about
   * (from a `calls` INSERT elsewhere) and stages the answer path. */
  const listenForOffer = useCallback(
    (call: CallRow) => {
      diagnosticsRef.current = [];
      trace("listenForOffer", `peerKey=${peerPublicKeyRef.current ? "present" : "MISSING"}`);
      // Claim the callee role HERE, not in answerCall. The first outgoing
      // signal ("callee-ready", sent at the end of this function) is encoded
      // before answerCall ever runs, and encodeForWire decides whether to
      // mint this call's KEM secret based on the role. With the role still
      // unset at that moment the decision rested on a null, which is exactly
      // the kind of ordering assumption that broke signalling before.
      roleRef.current = "callee";
      activeCallRowRef.current = call;
      setState({ phase: "incoming", call });

      joinSignalChannel(call.id, (signal) => {
        if (signal.type === "offer") {
          trace("offer received", `kind=${signal.kind}`);
          // An offer arriving on a call that is ALREADY answered is not a
          // new call — it is the caller restarting ICE after a media
          // timeout (see the media-timeout handler). Renegotiate in place
          // on the existing peer connection instead of stashing it as a
          // pending offer that nothing would ever consume, which is what
          // made the caller's restart silently one-sided.
          const answeredPhase = stateRef.current.phase;
          if (
            answeredCallIdRef.current === call.id &&
            (answeredPhase === "connecting" || answeredPhase === "active")
          ) {
            trace("offer received", "ICE restart from caller — renegotiating");
            sendCommand({ type: "renegotiate-answer", sdp: signal.sdp });
            return;
          }

          // Stash the offer; answerCall() is invoked explicitly when the user
          // taps Accept, so the mic/camera prompt only fires on consent.
          pendingOfferRef.current = { sdp: signal.sdp, kind: signal.kind };

          // The user already tapped Accept while we were still waiting for
          // this. Consent is given, so answer immediately instead of leaving
          // the offer sitting here and the call unanswerable.
          if (acceptRequestedRef.current) {
            trace("offer received", "Accept was already tapped — answering now");
            acceptRequestedRef.current = false;
            void answerCallRef.current?.(call, signal.sdp, signal.kind);
          }
        } else if (signal.type === "hangup") {
          trace("hangup received");
          setState({ phase: "ended", reason: "hangup" });
          cleanup();
        } else if (signal.type === "ice-candidate") {
          trace("ice-candidate received");
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
    [joinSignalChannel, cleanup, sendCommand, sendSignal, trace]
  );

  const accept = useCallback(async () => {
    trace("accept() tapped", `phase=${state.phase} hasOffer=${!!pendingOfferRef.current?.sdp}`);
    // Reads activeCallRowRef, NOT state.phase/state.call — the closure this
    // callback was built in can be one React commit behind by the time it
    // actually runs (callRef.current.accept() in useCallManager refreshes
    // the FUNCTION every render, but the function's own closed-over `state`
    // is only as fresh as the render that created it). That gap is exactly
    // where "CallKit answers, the app never connects" kept resurfacing:
    // onCallKitAnswer called accept() in the same tick listenForOffer had
    // just run in, state.phase still read the previous value, the guard
    // below fired, and the whole answer was silently dropped — no DB write,
    // no signal, no trace of why. activeCallRowRef is set synchronously at
    // the top of listenForOffer, so it can't lag behind it this way.
    const row = activeCallRowRef.current;
    if (!row) {
      trace("accept() ABORTED", "no active call row");
      return;
    }
    // Open the mic/camera the instant the user consents, rather than waiting
    // for the offer to arrive. Tapping Accept IS the consent, and this is
    // what triggers iOS's permission prompt — deferring it until after the
    // SDP exchange meant that on the (common) path where the offer hadn't
    // landed yet, the function returned below without ever touching the
    // media devices, so no prompt appeared and the call stayed silent.
    trace("requesting mic/camera");
    requestLocalMedia(row.kind === "video");

    // If the offer still hasn't arrived, remember that the user wants to
    // answer and re-ask the caller for it. The offer handler in
    // listenForOffer() completes the answer the moment it lands. Previously
    // this just returned, so a tap that landed before the offer did nothing
    // at all and the call could not be answered.
    if (!pendingOfferRef.current?.sdp) {
      trace("no offer yet", "waiting — will answer automatically once it arrives");
      acceptRequestedRef.current = true;
      sendSignal({ type: "callee-ready" });
      return;
    }
    const { sdp, kind } = pendingOfferRef.current;
    trace("offer already present — answering immediately");
    await answerCall(row, sdp, kind);
  }, [state, answerCall, sendSignal, sendCommand, requestLocalMedia, trace]);

  /** Answers a call that the user already accepted from CallKit's own UI
   * before this JS was running (lock screen, app terminated).
   *
   * Can't just call accept(): that reads `state` from the closure it was
   * created in, and at this point listenForOffer has only just been kicked
   * off — the phase is still "idle" as far as that closure can see, so
   * accept() hits its `phase !== "incoming"` guard and returns silently.
   * That is exactly the reported bug: iOS shows the call as connected, the
   * app opens on its own Accept screen, and tapping it does nothing.
   *
   * Instead this arms the same deferred-accept path a too-early tap uses:
   * the offer handler in listenForOffer answers the moment the SDP lands,
   * whenever that happens to be. */
  const acceptFromCallKit = useCallback(
    (kind: CallKind) => {
      requestLocalMedia(kind === "video");

      // The offer may already be sitting here — the app can be woken, join
      // the channel and receive the SDP before the answer ever reaches this
      // function. Arming the deferred path in that case would wait forever
      // for a handler that has already run, so answer directly instead.
      //
      // Reads activeCallRowRef, NOT stateRef: this can run in the same tick
      // as listenForOffer on the cold-launch CallKit path, before React has
      // committed the "incoming" state — stateRef.current was still "idle"
      // at that instant, so this used to always fall through to the
      // deferred branch below even when the offer had already arrived AND
      // already been handled (acceptRequestedRef was false when it ran),
      // meaning nothing would ever answer the call.
      const row = activeCallRowRef.current;
      const pendingOffer = pendingOfferRef.current;
      if (pendingOffer?.sdp && row) {
        trace("accept from CallKit", "offer already here — answering now");
        void answerCallRef.current?.(row, pendingOffer.sdp, pendingOffer.kind);
        return;
      }

      trace("accept from CallKit", "arming deferred answer");
      acceptRequestedRef.current = true;
      // Tells the caller we're here, so it re-sends the offer if its first
      // broadcast landed before this device joined the channel.
      sendSignal({ type: "callee-ready" });
    },
    [requestLocalMedia, sendSignal, trace]
  );

  const decline = useCallback(async () => {
    // stateRef, not the closed-over `state` — same one-commit-behind lag
    // that silently broke accept(); a decline that lands in that window
    // used to bail here, never telling the caller, who then rang for the
    // full 45s timeout.
    const current = stateRef.current;
    if (current.phase !== "incoming") return;
    const row = current.call;
    // Phase FIRST, network second. callActive is `phase !== "ended"`, so
    // every millisecond spent awaiting below is a millisecond the camera and
    // microphone stay live after the user has already declined —
    // sendSignalAndWait alone can block 3s waiting for the channel.
    setState({ phase: "ended", reason: "declined" });
    // AWAIT the broadcast before cleanup(): removeChannel() cancels an
    // in-flight send, which is why "decline" never reached the caller and
    // left them stuck on "Ringing…".
    await sendSignalAndWait({ type: "decline" });
    await supabase
      .from("calls")
      .update({ status: "declined", ended_at: new Date().toISOString() })
      .eq("id", row.id);
    cleanup();
  }, [sendSignalAndWait, cleanup]);

  /** Declines a call answered-from-CallKit's-counterpart: the decline
   * requested from the lock screen/system UI before this JS's `state` has
   * committed "incoming" — the exact same same-tick race acceptFromCallKit
   * exists for. decline() reads `state` from its own closure and bails at
   * `phase !== "incoming"` in precisely that window, silently doing nothing:
   * no "decline" broadcast reaches the caller, who then rings for the full
   * 45s timeout instead of learning immediately. */
  const declineFromCallKit = useCallback(async () => {
    const row = activeCallRowRef.current;
    if (!row) return;
    // Defense in depth: today's only caller (useCallManager's onCallKitEnd)
    // already checks phase === "incoming" before reaching here, so this
    // never fires in practice — but activeCallRowRef alone doesn't guarantee
    // that, and a future caller reaching this without that same external
    // check would silently end a call that's already "active"/"connecting",
    // broadcasting "decline" to a peer mid-conversation.
    const phase = stateRef.current.phase;
    if (phase !== "incoming") return;
    // Phase first — see decline() above for why the awaits must not gate it.
    setState({ phase: "ended", reason: "declined" });
    await sendSignalAndWait({ type: "decline" });
    await supabase
      .from("calls")
      .update({ status: "declined", ended_at: new Date().toISOString() })
      .eq("id", row.id);
    cleanup();
  }, [sendSignalAndWait, cleanup]);

  const hangup = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase === "idle" || current.phase === "ended") return;
    const row = current.call;
    // Phase first, so the camera and mic are released the instant the user
    // taps End rather than up to 3-5s later once the broadcast and the DB
    // write have both completed.
    setState({ phase: "ended", reason: "hangup" });
    // Same as decline: the peer only learns the call ended via this
    // broadcast, so it must actually leave before the channel is removed.
    await sendSignalAndWait({ type: "hangup" });
    await supabase
      .from("calls")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", row.id);
    cleanup();
  }, [sendSignalAndWait, cleanup]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    sendCommand({ type: "set-mic", enabled: !next });
    setMuted(next);
    // Not called from setMuteState below: that path is driven BY CallKit's
    // own mute button, and CallKit already knows its own state — reporting
    // back here would just be an unnecessary round trip. This one IS the
    // in-app mute button, which is the case CallKit has no way to find out
    // about on its own; without this its system call screen / Dynamic Island
    // mute indicator never moved when mute was toggled in-app.
    const row = activeCallRowRef.current;
    if (row) reportMuteState(row.id, next);
  }, [muted, sendCommand]);

  // Idempotent, unlike toggleMute: driven by CallKit's own mute button,
  // which reports the desired state directly rather than "flip whatever it
  // currently is" — using toggleMute here would desync in-app and system UI
  // the moment the two disagreed about the starting state even once.
  const setMuteState = useCallback(
    (next: boolean) => {
      if (next === muted) return;
      sendCommand({ type: "set-mic", enabled: !next });
      setMuted(next);
    },
    [muted, sendCommand]
  );

  const toggleCamera = useCallback(() => {
    const next = !cameraOff;
    sendCommand({ type: "set-camera", enabled: !next });
    setCameraOff(next);
  }, [cameraOff, sendCommand]);

  const toggleSpeaker = useCallback(() => {
    const next = !speakerOn;
    // userInitiated: true — this is a direct response to the user tapping
    // the speaker button, so it must always apply even while CallKit owns
    // the session. See setSpeakerphoneOn's doc comment.
    setSpeakerphoneOn(next, true);
    setSpeakerOnState(next);
  }, [speakerOn]);

  // Releasing the camera and mic must not wait for the user to dismiss the
  // "call ended" screen, and it can't be left to whichever code path set
  // `ended` either — a peer hanging up first (the remote-hangup branches)
  // only set the phase, so the green camera indicator stayed lit until the
  // overlay happened to unmount. Keyed off the phase itself so every way a
  // call can end is covered, including ones added later.
  //
  // The short delay exists because the overlay still renders the local
  // preview for a moment after the call ends; tearing the stream down in the
  // same frame blanks it to black mid-animation.
  const reset = useCallback(() => {
    setState({ phase: "idle" });
    // The next call opens a fresh stream with both tracks enabled, so these
    // must go back to their defaults — otherwise the buttons show the
    // previous call's state and "Unmute" actually mutes you.
    setMuted(false);
    setCameraOff(false);
    // resetAudioRoute rather than setSpeakerphoneOn(false): the latter would
    // re-apply a playAndRecord session on a call that's already over, which
    // leaves the recording indicator lit. This just clears the remembered
    // preference so the next call starts on the earpiece.
    resetAudioRoute();
    setSpeakerOnState(false);
    cleanup();
  }, [cleanup]);

  useEffect(() => {
    if (state.phase !== "ended") return;

    // No teardown timer here on purpose. WebRtcBridge releases the camera,
    // mic and audio session the moment `callActive` goes false — driven by
    // this same phase change, so it has already happened by the time this
    // effect runs. Sending a delayed "hangup" was the old approach and it
    // was unreliable: it depended on the bridge still being mounted and the
    // ref still being set when the timer fired.
    //
    // This only closes the "call ended" screen. Dismissal used to be manual
    // only (onDismissEnded), so a user who simply put the phone down left
    // the overlay up indefinitely.
    const dismissTimer = setTimeout(() => {
      reset();
    }, 3000);

    return () => clearTimeout(dismissTimer);
  }, [state.phase, reset]);

  /** Wired to WebRtcBridge's onEvent prop by the component that renders it. */
  const handleBridgeEvent = useCallback(
    (event: BridgeEvent) => {
      if (event.type === "ready") {
        trace("bridge ready");
        setBridgeReady(true);
        // Flush every command queued before this bridge existed — startCall
        // and accept both call sendCommand in the same tick as the setState
        // that mounts the bridge, so bridgeRef.current is still null then.
        // create-offer landing in that gap (with no queue to catch it, only
        // start-local had one) is why a call could open the mic and still
        // never produce an SDP offer for the other side to answer.
        if (pendingCommandsRef.current.length > 0) {
          const queued = pendingCommandsRef.current;
          pendingCommandsRef.current = [];
          trace("flushing deferred commands", `count=${queued.length}`);
          for (const command of queued) {
            bridgeRef.current?.send(command);
          }
        }
      } else if (event.type === "local-ready") {
        // This is the moment getUserMedia actually returned a stream — i.e.
        // iOS granted mic/camera access and the hardware opened. If this
        // never appears in the trace, permission was denied or getUserMedia
        // threw (see the "error" branch below for why).
        trace("local media open", "mic/camera stream acquired");
        // Video starts on the loudspeaker (nobody holds a phone to their ear
        // while watching the screen); voice keeps the earpiece, which is what
        // people expect when they raise the phone to answer. Forcing the
        // loudspeaker on every call meant an ordinary voice call blasted the
        // room — and it also overwrote configureForVoiceCall's .voiceChat
        // mode with .videoChat behind the user's back.
        const current = stateRef.current;
        const wantSpeaker =
          current.phase !== "idle" && current.phase !== "ended" && "call" in current
            ? current.call.kind === "video"
            : false;
        setSpeakerphoneOn(wantSpeaker);
        setSpeakerOnState(wantSpeaker);
      } else if (event.type === "offer" && roleRef.current === "caller") {
        const kind = pendingOfferRef.current?.kind ?? "audio";
        trace("local offer created");
        // Keep the SDP so it can be re-sent if the callee joins the channel
        // after this first broadcast (see the "callee-ready" handler).
        pendingOfferRef.current = { sdp: event.sdp, kind };
        // One send covers both cases: a "callee-ready" that arrived before
        // this offer existed (the flag) and one that arrives after (handled
        // in the callee-ready branch). Sending twice made the callee run
        // answerCall twice, which built a second peer connection over the
        // first one mid-negotiation.
        calleeReadyRef.current = false;
        sendSignal({ type: "offer", sdp: event.sdp, kind });
      } else if (event.type === "answer" && roleRef.current === "callee") {
        trace("local answer created");
        sendSignal({ type: "answer", sdp: event.sdp });
      } else if (event.type === "ice-candidate") {
        sentCandidatesRef.current.push(event.candidate);
        sendSignal({ type: "ice-candidate", candidate: event.candidate });
      } else if (event.type === "connection-state") {
        trace("connection-state", event.state);
        // These were received and thrown away, so a call whose ICE never
        // connected (or that dropped mid-conversation) sat on "Connected"
        // forever with silence and no way out but a manual hangup.
        if (event.state === "failed") {
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          // Same one-retry policy as media-timeout, and for the same
          // reason: "failed" is the ICE agent explicitly giving up on every
          // candidate pair it tried, most commonly because the only relay
          // candidate it gathered came from the shared free TURN server
          // under load — a real, live call (2026-09-19) went "connecting"
          // -> "failed" after 15 seconds on the caller's side while the
          // callee's side never even saw connectionState leave "connecting"
          // at all in the same window, both sides having gathered srflx
          // candidates but zero relay. A fresh ICE gathering pass is a
          // genuine second chance at a working pair (a different STUN/TURN
          // response, not just the identical attempt repeating), not just a
          // label change — restart-ice already exists for exactly this on
          // the media-timeout path; reusing it here instead of ending the
          // call outright is the same fix for the mirror failure mode.
          if (
            roleRef.current === "caller" &&
            !restartInFlightRef.current &&
            iceRestartCountRef.current < MAX_ICE_RESTARTS
          ) {
            iceRestartCountRef.current += 1;
            trace("connection-state failed", "restarting ICE (one retry)");
            // A restart produces a fresh answer for this same call.id; without
            // clearing this the caller would discard it as a duplicate.
            answerAppliedForCallIdRef.current = null;
            restartInFlightRef.current = true;
            sendCommand({ type: "restart-ice" });
            return;
          }
          setState((current) =>
            current.phase === "idle" || current.phase === "ended"
              ? current
              : { phase: "ended", reason: "failed" }
          );
          cleanup();
        } else if (event.state === "disconnected") {
          // Not fatal on its own — WebRTC recovers from a brief network blip
          // (a Wi-Fi/cellular handover, a tunnel) and returns to "connected"
          // by itself, so ending the call here would drop calls that were
          // about to be fine. But it never times out on its own either, so
          // without this a permanently dead route just sits on "Connected"
          // in silence until someone hangs up manually.
          if (!disconnectTimerRef.current) {
            disconnectTimerRef.current = setTimeout(() => {
              disconnectTimerRef.current = null;
              trace("disconnected too long", "ending call");
              setState((current) =>
                current.phase === "idle" || current.phase === "ended"
                  ? current
                  : { phase: "ended", reason: "failed" }
              );
              cleanup();
            }, 15000);
          }
        } else if (event.state === "connected") {
          // Recovered — cancel the pending give-up timer.
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          // Re-assert the audio route now that the connection is up.
          // Setting it at getUserMedia time (which still happens, for the
          // ringing UI) isn't enough on its own: iOS re-evaluates the route
          // as the call's audio unit starts, and can land back on the
          // earpiece — the "speaker is on but it's quiet" symptom. Applying
          // it again here makes the chosen route stick.
          setSpeakerphoneOn(speakerOnRef.current);
        }
      }
      if (event.type === "media-flowing") {
        trace("media-flowing", "getStats confirmed inbound RTP growth");
        // The restart (if any) that led here is finished — allow a later
        // one if this connection subsequently breaks again.
        restartInFlightRef.current = false;
        setMediaConfirmed(true);
        // Records that media DID work, and whether it took an ICE restart to
        // get there — "connected_after_restart" appearing in the data is the
        // direct evidence that the restart is earning its keep.
        callOutcomeRef.current = iceRestartedRef.current
          ? "connected_after_restart"
          : "connected";
      }
      if (event.type === "call-stats") {
        // Held, not written yet: the outcome this belongs to isn't known
        // until the call ends. A later snapshot (e.g. after an ICE restart)
        // legitimately replaces an earlier one.
        callStatsRef.current = event;
        trace(
          "call-stats",
          `pair=${event.selectedCandidatePair ?? "?"} relay=${event.turnServer ?? "none"} ` +
            // Audio shown separately: a combined byte count is dominated by
            // video and stays healthy-looking on a call with no sound at
            // all. audioBytes=0 here is the direct proof that the fault is
            // the audio track itself, not the route or the session.
            `audioBytes=${event.audioBytesReceived ?? "?"} audioPkts=${event.audioPacketsReceived ?? "?"} ` +
            // OUTBOUND — what this device sent, and the local mic track's
            // own state. Together with the inbound numbers above, this
            // finally makes "whose mic is the problem" a fact instead of an
            // inference: a low audioPkts on ONE side's trace is explained
            // directly if that same side's outSent/localMic here also reads
            // low/disabled, rather than needing to be guessed at from the
            // OTHER side's inbound count.
            `outSent=${event.outboundAudioBytesSent ?? "?"}/${event.outboundAudioPacketsSent ?? "?"} ` +
            `localMic=enabled:${event.localAudioTrackEnabled ?? "?"} ` +
            `state:${event.localAudioTrackReadyState ?? "?"} ` +
            `muted:${event.localAudioTrackMuted ?? "?"}`
        );
      }
      if (event.type === "negotiation-stalled") {
        // ICE has been negotiating ~9s without connecting. Same one-restart-
        // at-a-time policy as media-timeout below, and sharing the same
        // counter deliberately: the two conditions can both be true for one
        // call, and before this was centralised here the bridge restarted on
        // its own while media-timeout restarted again on top of it.
        //
        // The role check is belt-and-braces (the bridge only emits this on
        // the caller), but it is the invariant that actually matters: two
        // sides restarting at once is what produced every failed call in
        // call_diagnostics on 2026-09-19.
        if (
          !mediaConfirmedRef.current &&
          roleRef.current === "caller" &&
          !restartInFlightRef.current &&
          iceRestartCountRef.current < MAX_ICE_RESTARTS
        ) {
          iceRestartCountRef.current += 1;
          trace("negotiation-stalled", "still connecting at 9s — restarting ICE");
          // A restart produces a fresh answer for this same call.id; without
            // clearing this the caller would discard it as a duplicate.
            answerAppliedForCallIdRef.current = null;
            restartInFlightRef.current = true;
            sendCommand({ type: "restart-ice" });
        }
        return;
      }
      if (event.type === "media-timeout") {
        // Media never started despite the PC reporting "connected" — a dead
        // relay, not a transient blip (that path is onconnectionstatechange's
        // "disconnected" handling above, which already gives a live route 15s
        // to recover on its own before giving up). Skipped if mediaConfirmed
        // already flipped true: a LATE-arriving media-timeout event racing a
        // media-flowing event that beat it (both can be in flight briefly
        // near the deadline) must not kill a call that just started working.
        if (!mediaConfirmedRef.current) {
          // First timeout on the caller's side: restart ICE rather than
          // hanging up. The handshake succeeded, so the peers can reach
          // each other — it is the chosen candidate pair (typically a
          // saturated public relay) that isn't carrying RTP. Re-gathering
          // gives ICE a genuine second chance at a different pair, which is
          // what the media-timeout event was introduced for in the first
          // place; until now it only ever ended the call, so a call died
          // after exactly one bad relay pick with no retry. The callee
          // doesn't initiate: a restart has to come from one side only, or
          // both re-offer at once and glare.
          if (
            roleRef.current === "caller" &&
            !restartInFlightRef.current &&
            iceRestartCountRef.current < MAX_ICE_RESTARTS
          ) {
            iceRestartCountRef.current += 1;
            trace("media-timeout", "no inbound RTP — restarting ICE (one retry)");
            // A restart produces a fresh answer for this same call.id; without
            // clearing this the caller would discard it as a duplicate.
            answerAppliedForCallIdRef.current = null;
            restartInFlightRef.current = true;
            sendCommand({ type: "restart-ice" });
            return;
          }
          trace(
            "media-timeout",
            iceRestartedRef.current
              ? "no inbound RTP after ICE restart — ending as failed"
              : "no inbound RTP — ending as failed"
          );
          callOutcomeRef.current = iceRestartedRef.current
            ? "media_timeout_after_restart"
            : "media_timeout";
          setState((current) =>
            current.phase === "idle" || current.phase === "ended"
              ? current
              : { phase: "ended", reason: "failed" }
          );
          cleanup();
        }
      }
      if (event.type === "log") {
        // The bridge's own diagnostic notes (currently: per-candidate type
        // as it's gathered, and when gathering finishes) — folded into the
        // same trace/call_diagnostics record as everything else, so a call
        // stuck on "Connecting" shows whether a relay candidate was ever
        // gathered at all, not just that ICE never reached "connected."
        trace("bridge-log", event.message);
      }
      if (event.type === "error") {
        // Errors arriving after the call is over (a late ICE candidate, a
        // toggle on a closed track) must not re-enter teardown or resurrect
        // an ended call as "failed".
        const phase = stateRef.current.phase;
        if (phase === "idle" || phase === "ended") {
          trace("BRIDGE ERROR (ignored, call not active)", event.message);
          return;
        }
        trace("BRIDGE ERROR", event.message);
        // eslint-disable-next-line no-console
        console.warn("[call engine]", event.message);
        // A media failure is fatal to the call: without a microphone there is
        // nothing to send. This used to be logged and swallowed, so a denied
        // permission left the call sitting on "Connecting..." forever with no
        // explanation. Ending it surfaces the failure in the UI instead.
        setState({ phase: "ended", reason: "failed" });
        cleanup();
      }
    },
    [sendSignal, cleanup, sendCommand, trace]
  );

  /** Flips between the front and rear camera during a video call. */
  const switchCamera = useCallback(() => {
    sendCommand({ type: "switch-camera" });
  }, [sendCommand]);

  // Missed-call timeout. Without this an unanswered call rings forever on
  // both devices — the "missed" state existed in the type and the UI but
  // nothing ever set it.
  useEffect(() => {
    if (state.phase !== "outgoing" && state.phase !== "incoming") return;

    const timer = setTimeout(() => {
      void (async () => {
        // Re-read through the ref: the awaits below can take seconds
        // (sendSignalAndWait polls for up to 3s, then a DB round trip), and
        // the user can answer during that window. Without re-checking, a
        // call answered right at the 45s mark connected and was then torn
        // down as "missed" a second or two later, mid-sentence.
        const armed = stateRef.current;
        if (armed.phase !== "outgoing" && armed.phase !== "incoming") return;
        const row = armed.call;

        if (armed.phase === "outgoing") {
          await sendSignalAndWait({ type: "hangup" });
        } else {
          await sendSignalAndWait({ type: "decline" });
        }
        if (stateRef.current.phase !== armed.phase) return;
        // Written for BOTH sides now, not just the caller. Only the caller
        // used to close the row out, relying on its own timer firing too —
        // but the caller can be killed, backgrounded past its timer, or
        // offline by the time this device's timer fires, leaving the row
        // stuck at 'ringing' forever. A stale 'ringing' row is what let a
        // stray foreground reconnect to (and start ringing for) a call that
        // ended long ago. eq("status", "ringing") avoids clobbering a row
        // the peer has already closed out for a different reason.
        await supabase
          .from("calls")
          .update({ status: "missed", ended_at: new Date().toISOString() })
          .eq("id", row.id)
          .eq("status", "ringing");
        // Checked once more: the DB round trip is another window in which
        // the call can legitimately be answered.
        if (stateRef.current.phase !== armed.phase) return;
        setState({ phase: "ended", reason: "missed" });
        cleanup();
      })();
    }, RING_TIMEOUT_MS);

    return () => clearTimeout(timer);
    // Keyed on the PHASE, not the whole state object: `state` gets a new
    // identity on every setState, and sendSignalAndWait changes identity
    // when the E2EE keypair loads — both of which re-ran this effect and
    // re-armed the 45s timer from zero, so RING_TIMEOUT_MS was never the
    // guarantee it looked like.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, sendSignalAndWait, cleanup]);

  useEffect(() => cleanup, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    mediaConfirmed,
    muted,
    setMuteState,
    cameraOff,
    bridgeReady,
    startCall,
    listenForOffer,
    accept,
    acceptFromCallKit,
    decline,
    declineFromCallKit,
    hangup,
    toggleMute,
    toggleCamera,
    switchCamera,
    speakerOn,
    toggleSpeaker,
    reset,
    setBridgeRef,
    setPeerPublicKey,
    setPeerKyberPublicKey,
    handleBridgeEvent,
    getDiagnosticsReport,
  };
}
