import { setAudioModeAsync } from "expo-audio";
import { audioRouteSnapshot, configureForVoiceCall } from "expo-speaker-toggle";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Animated, Platform, StyleSheet, View } from "react-native";
import type {
  MediaStream,
  RTCPeerConnection as RTCPeerConnectionType,
} from "react-native-webrtc";

import { addNetworkChangeListener, currentNetwork, type NetworkPath } from "expo-televo-audio";
import { tuneSdp } from "../lib/webrtc";
import { getWebRtc } from "../lib/webrtcModule";

export type BridgeEvent =
  | { type: "ready" }
  | { type: "local-ready" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "connection-state"; state: string }
  // pc.connectionState reaching "connected" only means ICE + DTLS succeeded
  // — a relay that accepted the handshake but never actually forwards RTP
  // (an overloaded/misbehaving TURN server, the exact failure mode of the
  // shared public relay this app falls back to) still reports "connected"
  // while both sides hear and see nothing. "media-flowing" only fires once
  // getStats() confirms bytes are ACTUALLY arriving from the peer — see
  // watchForInboundMedia below.
  | { type: "media-flowing" }
  // The mirror failure case: watchForInboundMedia's deadline passed with no
  // growth in bytesReceived at all — media genuinely never started, most
  // likely a saturated/misbehaving TURN relay that accepted the handshake
  // but never forwards RTP. Lets useCall decide what to do about a call that
  // LOOKS connected but is provably dead, instead of leaving the UI showing
  // "Connecting…" forever with no path forward.
  | { type: "media-timeout" }
  // ICE has been negotiating for several seconds without reaching
  // "connected". Reported rather than acted on here: useCall owns the ICE
  // restart budget (MAX_ICE_RESTARTS) and the caller/callee role, and when
  // this component restarted on its own those two mechanisms stacked —
  // a stall restart and a media-timeout restart could both fire for one
  // call, on top of the callee restarting simultaneously. One decision
  // maker, one budget.
  | { type: "negotiation-stalled" }
  // A snapshot of what the connection actually did, for call_diagnostics
  // (049_call_diagnostics.sql). Emitted alongside media-flowing/media-timeout
  // rather than on a timer: those are exactly the two moments where the
  // answer to "did this call work, and did it go through a relay" is known.
  | {
      type: "call-stats";
      /** Inbound AUDIO only — see collectCallStats. A call can report
       * healthy combined media while carrying no audio at all. */
      audioBytesReceived?: number;
      audioPacketsReceived?: number;
      /** OUTBOUND audio — what THIS device is sending, independent of
       * whether the peer's report shows it arriving. */
      outboundAudioBytesSent?: number;
      outboundAudioPacketsSent?: number;
      /** The local mic track's own state, read directly off the sender —
       * the most direct possible answer to "is the mic itself broken." */
      localAudioTrackEnabled?: boolean | null;
      localAudioTrackReadyState?: string | null;
      localAudioTrackMuted?: boolean | null;
      /** The remote (inbound) audio track's own state, read directly off
       * the receiver — see collectCallStats for why this is separate from
       * inbound-rtp byte/packet counts. */
      remoteAudioTrackEnabled?: boolean | null;
      remoteAudioTrackReadyState?: string | null;
      remoteAudioTrackMuted?: boolean | null;
      selectedCandidatePair: string | null;
      turnServer: string | null;
      /** Round trip on the selected candidate pair, and what congestion
       * control currently thinks it can send — the numbers the call screen's
       * signal-quality bars are built from. */
      rttMs?: number | null;
      availableOutgoingKbps?: number | null;
      /** Inbound packets received across all tracks, for a loss RATE (the
       * lost counter alone only ever grows). */
      packetsReceived?: number | null;
      /** The TURN server URL (as configured) behind this device's relay
       * candidate when the call is relayed through it — what useCall uses to
       * pick a different relay when this one performs badly. */
      relayUrl?: string | null;
      msToMedia: number | null;
      bytesReceived: number | null;
      packetsLost: number | null;
      jitterMs: number | null;
    }
  | { type: "log"; message: string }
  | { type: "error"; message: string };

export type WebRtcBridgeHandle = {
  send: (command: object) => void;
  /** The peer's current streamURL (the same string passed to <RTCView>'s
   * streamURL prop below), or null if no remote stream exists yet. This is
   * what expo-call-pip's startCallPip needs — it resolves this exact string
   * back to a real RTCMediaStream natively, via the same
   * WebRTCModule.streamForReactTag: lookup <RTCView> itself uses. */
  getRemoteStreamUrl: () => string | null;
  /** Same idea as getRemoteStreamUrl, for this device's OWN camera stream —
   * expo-call-pip composites this as a small corner thumbnail over the
   * peer's full-size video inside the PiP window, matching FaceTime's own
   * PiP layout (both people visible, not just the peer). */
  getLocalStreamUrl: () => string | null;
};

// Set by useCallManager right before it calls call.accept() for a call that
// was answered from CallKit's own UI (lock screen / system call screen).
// CallKit activates the shared AVAudioSession itself for such a call —
// opening the mic before that lands means WebRTC's own session
// configuration and CallKit's fight over the audio route, which is how a
// call answered from the lock screen could connect with no audio despite
// negotiating fine. Module-level rather than a prop: it needs to be set
// synchronously from outside this component's own render, the same
// constraint that made peerPublicKeyRef a ref instead of a prop in useCall.
// REVERTED 2026-09-20 along with useManualAudio.
//
// markNextCallAsAnsweredViaCallKit/clearCallKitAudioSessionWait/
// waitForCallKitAudioSession existed to make acquireMedia PAUSE and wait for
// CallKit's manual audio handover (see CallKitDelegate.didActivate, which no
// longer performs one) before deciding whether to configure the session
// itself. With that handover gone, this device always configures and
// activates its own session — there is nothing left to wait for, and
// waiting was actively harmful: a call that connected quickly could still
// be sitting in this 1500ms window with the mic not yet properly routed,
// which is consistent with the unusually fast connecting→connected gap
// measured on the caller leg of a call that then produced almost no audio.
//
// The two exported functions are kept as no-ops rather than removed, since
// useCall.ts and useCallManager.tsx still call them at several call sites —
// deleting them would mean editing every call site for no behavioural gain.
export function markNextCallAsAnsweredViaCallKit(): void {}
export function clearCallKitAudioSessionWait(): void {}

type MediaTrackHandle = {
  stop?: () => void;
  /** react-native-webrtc's own non-standard API — see releaseTrack. */
  release?: () => void;
};

/** Frees a capture track's underlying hardware.
 *
 * `track.stop()` is NOT sufficient in react-native-webrtc. Its implementation
 * (node_modules/react-native-webrtc/src/MediaStreamTrack.ts) is:
 *
 *     stop() { this.enabled = false; this._readyState = 'ended'; }
 *
 * and the `enabled` setter early-returns when the value is unchanged:
 *
 *     set enabled(v) { if (v === this._enabled) return; ... }
 *
 * The native `stopCapture` only runs from inside that setter. So a video
 * track that is ALREADY disabled — which is exactly the case when the user
 * turned their camera off during the call, and also the case for the second
 * of two stop() calls on the same object — never reaches native at all, and
 * the AVCaptureSession keeps running with the green camera indicator lit.
 *
 * `release()` maps to `mediaStreamTrackRelease`, whose native implementation
 * (ios/RCTWebRTC/WebRTCModule+RTCMediaStream.m) unconditionally does
 * `isEnabled = NO; [captureController stopCapture]; removeObjectForKey:` with
 * no guards at all. That is the real teardown primitive; stop() is kept as a
 * fallback purely for any build where release() is unavailable. */
function releaseTrack(track: MediaTrackHandle | null | undefined): void {
  if (!track) return;
  if (typeof track.release === "function") {
    track.release();
    return;
  }
  track.stop?.();
}

type WebRtcBridgeProps = {
  onEvent: (event: BridgeEvent) => void;
  /** true renders the video surfaces; false is an audio-only call. */
  visible: boolean;
  /** true once the peer's video should be shown. While false (a video call
   * that is still ringing) the local preview takes the full screen instead
   * of sitting in the corner, so the user sees themselves before the call
   * connects. */
  peerVideoVisible: boolean;
  /** False once the call is over (any reason). The bridge releases the
   * camera, mic and audio session itself when this goes false, instead of
   * relying on a "hangup" command arriving in time.
   *
   * Teardown used to depend on a chain: a timer fired, a command was sent,
   * the ref still had to be non-null, and the bridge had to still be
   * mounted. Every one of those links broke in practice — most visibly when
   * the overlay unmounted the bridge the instant a call ended, so the
   * command landed on a null ref and the camera kept running until the OS
   * reclaimed it on backgrounding. Deriving teardown from state instead of
   * a message makes it impossible to miss. */
  callActive: boolean;
  /** Swaps which stream is full-screen: false (default) is peer-big/self-
   * corner, true is self-big/peer-corner. Geometry only — never changes
   * which RTCView carries the remote (peer) AUDIO track, which always stays
   * the full-size "remote" RTCView underneath. See CallOverlay's own
   * comment on why swap is done this way rather than swapping the actual
   * remote/local RTCView instances. */
  swapped?: boolean;
  /** Live drag offset for the corner box, in screen points from its resting
   * corner position — an Animated.ValueXY so the drag can run on the native
   * thread without round-tripping through React state on every touch move.
   * Undefined/omitted pins the box to its resting position. */
  cornerDrag?: Animated.ValueXY;
  /** Which corner the small box rests in when not being dragged. */
  cornerAnchor?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** True hides the corner box entirely (still capturing/sending video —
   * only the picture-in-picture-style thumbnail is hidden), so a "restore"
   * button elsewhere in the UI can bring it back without touching the call
   * itself. */
  cornerHidden?: boolean;
};

type Command =
  | { type: "start-local"; video?: boolean; iceServers?: RTCIceServer[] }
  | { type: "create-offer"; iceServers: RTCIceServer[]; video?: boolean }
  | { type: "create-answer"; iceServers: RTCIceServer[]; sdp: string; video?: boolean }
  | { type: "accept-answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "set-mic"; enabled: boolean }
  | { type: "set-camera"; enabled: boolean }
  | { type: "switch-camera" }
  // Re-gathers ICE candidates on the EXISTING peer connection and produces a
  // fresh offer, giving the call a second chance at a working candidate pair
  // without tearing down tracks or renegotiating media. The caller sends
  // this after a media-timeout; see useCall's handler for why one retry is
  // worth it before declaring the call failed.
  | { type: "restart-ice" }
  // Swaps the relay list on the live connection (keeping every other
  // setting it was created with). Takes effect at the next ICE restart.
  | { type: "set-ice-servers"; iceServers: RTCIceServer[] }
  // Caller with a cold credential cache: start-local went without servers;
  // build the connection (and start gathering) as soon as they arrive, while
  // the camera may still be opening. create-offer then reuses it.
  | { type: "prepare-peer"; iceServers: RTCIceServer[] }
  // The callee's half of an ICE restart: applies the caller's re-offer to
  // the peer connection that is ALREADY up and answers it. Distinct from
  // "create-answer", which builds a brand new connection and re-opens the
  // mic — correct for answering a call, fatal mid-call.
  | { type: "renegotiate-answer"; sdp: string }
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
  {
    onEvent,
    visible,
    peerVideoVisible,
    callActive,
    swapped = false,
    cornerDrag,
    cornerAnchor = "top-right",
    cornerHidden = false,
  },
  ref
) {
  const pcRef = useRef<RTCPeerConnectionType | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // The in-flight getUserMedia promise — see getMedia. Holding the PROMISE
  // rather than only the resolved stream is what stops two overlapping
  // callers from each opening their own capture session.
  const mediaPromiseRef = useRef<Promise<MediaStream> | null>(null);
  // ICE candidates that arrive before the remote description is set cannot be
  // added yet; WebRTC rejects them. They are queued and flushed afterwards.
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  // Mirrors remoteUrl for the imperative handle below, which is pinned with
  // an empty dependency array (see its own comment on why) and so can never
  // read a state value directly without going stale — reading a ref instead
  // always sees the current value regardless of when the handle itself was
  // built.
  const remoteUrlRef = useRef<string | null>(null);
  remoteUrlRef.current = remoteUrl;
  // Same mirroring reasoning as remoteUrlRef — needed for the imperative
  // handle's getLocalStreamUrl(), which expo-call-pip uses to also composite
  // the self-view inside the PiP window (FaceTime-style small corner
  // thumbnail over the peer's full-size video), not just the peer alone.
  const localUrlRef = useRef<string | null>(null);
  localUrlRef.current = localUrl;
  // getUserMedia always opens facingMode "user", so every call starts on the
  // front camera; switch-camera toggles this.
  const [usingFrontCamera, setUsingFrontCamera] = useState(true);

  // onEvent is read through a ref so the imperative handle never goes stale
  // mid-call if the parent re-renders with a new callback identity.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const post = (event: BridgeEvent) => onEventRef.current(event);

  // Releases the camera/mic the moment the call stops being active, without
  // waiting for a command to arrive. This is the primary teardown path — the
  // "hangup" command and the unmount cleanup below are now just redundant
  // safety nets rather than the thing being relied on.
  //
  // Reached through a ref rather than calling releaseMedia directly: this
  // effect is declared above that function, and a `function` declaration is
  // hoisted but the closure it captures is re-created every render. Going
  // through a ref that is refreshed on every render means teardown always
  // runs against the CURRENT stream and peer connection, never a stale
  // capture — which is the difference between the camera light going out and
  // staying on until the OS reclaims it.
  const releaseMediaRef = useRef<() => void>(() => {});

  // True from the moment the call stops being active until the next call
  // opens media. getUserMedia is asynchronous — on a cold CallKit answer it
  // can still be in flight when the call ends — and its promise resolves
  // AFTER releaseMedia has already run against null refs. The resolved
  // stream was then stored anyway and never stopped by anything, which is
  // exactly the camera that stays on with no call in progress: the syslog
  // shows the capture graph "Starting" with no matching "Stopping".
  const mediaCancelledRef = useRef(false);
  // Generation counter for watchForInboundMedia. An ICE restart starts a new
  // watchdog while the previous one may still be inside its 8s deadline;
  // without this, the stale loop would post a media-timeout for a connection
  // the restart had already fixed. Each loop captures the value at entry and
  // stops as soon as it no longer matches.
  const mediaWatchGenerationRef = useRef(0);

  /** Drives periodicallyRefreshStats — same invalidation pattern as
   * mediaWatchGenerationRef, kept separate because this loop outlives the
   * one-shot media-flowing check that starts it. */
  const statsRefreshGenerationRef = useRef(0);

  /** Mirrors the callActive prop for the unmount cleanup, which closes over
   * the first render's value and would otherwise always read false. */
  const callActiveRef = useRef(false);
  /** The peer's incoming stream. Held only so teardown can drop the
   * reference; the gain machinery that used to read it was removed
   * 2026-09-21 (see ontrack). */
  const remoteStreamRef = useRef<MediaStream | null>(null);
  /** The offer SDP this bridge has already built an answer for, so a
   * duplicated create-answer cannot tear down the live connection. See the
   * create-answer branch. */
  const answeredSdpRef = useRef<string | null>(null);
  /** Same protection for the caller: a duplicated create-offer would
   * otherwise replace a peer connection that is already negotiating. */
  const offerCreatedRef = useRef(false);
  // Fires one ICE re-gather if the connection is still negotiating after a
  // few seconds — see onconnectionstatechange. Cleared on connect and on
  // teardown so it can never fire into a finished or replaced call.
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallRestartedRef = useRef(false);

  /**
   * True on the side that created the offer for this call.
   *
   * An ICE restart may only ever be started by ONE side. Both sides used to
   * run the 6s stall rescue below, because it lives in createPeer() which
   * both create-offer and create-answer call — so on a slow network both
   * phones hit 6s, both called createOffer({iceRestart:true}), and each
   * received the other's restart offer while mid-restart itself. That is
   * classic SDP glare: neither negotiation can complete, ICE re-gathers
   * from scratch on both ends (the callee's second round in the 17:46
   * trace produced nothing but host candidates), and the call sits in
   * "connecting" until somebody hangs up. Every ended_no_media_event row in
   * call_diagnostics with a "stalled at 6s" line on BOTH sides is this.
   *
   * The callee never restarts on its own now. It does not need to: the
   * caller's restart offer re-gathers candidates on both ends anyway, and
   * the callee already mirrors it through renegotiate-answer.
   */
  const isCallerRef = useRef(false);
  // Counts relay candidates gathered in the CURRENT round, reset at the
  // start of each createPeer/restart. Lets the null-candidate ("gathering
  // complete") handler tell "no relay was ever offered by ICE" apart from
  // "a relay was offered but the pair failed" — two very different faults
  // that otherwise both just look like "no relay in the selected pair" in
  // call-stats after the fact, with no way to say WHICH one happened.
  const relayCandidateCountRef = useRef(0);
  // The configuration the live connection was built with. setConfiguration
  // replaces it wholesale, and changing bundle/rtcp-mux policy afterwards is
  // refused, so swapping relays has to resend everything else unchanged.
  const peerConfigRef = useRef<object | null>(null);

  // Wi-Fi <-> cellular (or Low Data Mode toggled) mid-call: re-apply the
  // video ceiling to the live connection.
  useEffect(() => {
    const sub = addNetworkChangeListener((path) => {
      if (path.status !== "satisfied" || !pcRef.current) return;
      void applyVideoCeiling(pcRef.current, path);
    });
    return () => sub.remove();
    // applyVideoCeiling only reads refs; subscribe once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // True until this effect has seen callActive go true at least once, i.e.
  // until a call has actually started in this mount. Without it, the effect's
  // teardown branch ran on MOUNT — React runs every effect once immediately,
  // and this bridge is mounted for the "incoming"/"outgoing" phases where
  // callActive is still false — and cleared the CallKit arm that
  // markNextCallAsAnsweredViaCallKit had set moments earlier.
  //
  // That is the CallKit-answer bug: answering from the system UI sets the
  // arm, the overlay then mounts this bridge, this effect fires on mount and
  // wipes the arm, so getMedia() later sees no arm, skips
  // waitForCallKitAudioSession, and reconfigures an audio session CallKit had
  // already configured and activated — leaving WebRTC bound to a route that
  // no longer exists. Answering IN-APP never sets the arm in the first place,
  // so that path was unaffected, which is exactly the asymmetry reported.
  const hasBeenActiveRef = useRef(false);

  useEffect(() => {
    // Kept in a ref so the mount effect's unmount cleanup — which closes
    // over the first render's props — can tell a transient unmount from a
    // real teardown.
    callActiveRef.current = callActive;
    if (callActive) {
      // A new call is starting: media is wanted again.
      mediaCancelledRef.current = false;
      hasBeenActiveRef.current = true;
      return;
    }
    // Mount-time run before any call became active: nothing to tear down, and
    // clearing the CallKit arm here is precisely the bug described above.
    if (!hasBeenActiveRef.current) return;

    mediaCancelledRef.current = true;
    releaseMediaRef.current();
    // See clearCallKitAudioSessionWait: an unconsumed arm must not leak into
    // whatever call comes next.
    clearCallKitAudioSessionWait();
    setLocalUrl(null);
    setRemoteUrl(null);
    // The next call opens facingMode "user" again, so the mirror state has to
    // go back with it — otherwise a call ended on the rear camera leaves the
    // next call's self-view un-mirrored.
    setUsingFrontCamera(true);
  }, [callActive]);

  useEffect(() => {
    post({ type: "ready" });
    // Teardown on unmount: a surviving stream keeps the camera/mic light on.
    //
    // Skipped while the call is STILL LIVE. This cleanup is unconditional
    // teardown — releaseMedia closes the peer connection, stops the capture
    // tracks, runs enableWebRtcAudio(false) and kills the audio watchdog —
    // so running it for a transient unmount is a mid-call kill switch: the
    // user hears about a second of audio and then silence while the call
    // still shows as connected. That is the 2026-09-20 Bek → Shakha report.
    //
    // A genuine end-of-call teardown does not rely on this path: the
    // callActive effect below already calls releaseMedia when callActive
    // goes false, which happens before the overlay unmounts. This cleanup
    // only has to cover the case where the tree is torn down while no call
    // is in progress.
    return () => {
      if (callActiveRef.current) return;
      releaseMediaRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      send(command: object) {
        void handleCommand(command as Command);
      },
      getRemoteStreamUrl() {
        return remoteUrlRef.current;
      },
      getLocalStreamUrl() {
        return localUrlRef.current;
      },
    }),
    // Pinned with [] deliberately — this is load-bearing.
    //
    // Without a dependency array React rebuilds the handle on EVERY render,
    // and because the parent passes a callback ref (setBridgeRef in
    // useCall), React detaches it first: setBridgeRef(null), then
    // setBridgeRef(newHandle). For that window bridgeRef.current is null,
    // and sendCommand's "no bridge yet" branch pushes the command onto the
    // replay queue instead of delivering it. The bridge re-renders
    // constantly during a call (setLocalUrl/setRemoteUrl from ontrack, the
    // camera-facing toggle, the overlay's per-second timer), so that window
    // opens over and over for the whole call.
    //
    // That is how ONE logical create-answer got delivered twice on
    // 2026-09-20 (Bek → Shakha: two "local answer created" 74ms apart,
    // second peer connection built over the first, ~1s of audio then
    // silence). Pinning the handle keeps bridgeRef.current stable, so
    // commands are delivered directly and never enter the queue mid-call.
    //
    // Safe to pin: handleCommand is redefined each render, but every value
    // it touches is a ref or a state setter, so the first closure stays
    // correct for the life of the component — the same discipline the rest
    // of this file already follows (see onEventRef).
    []
  );

  /** Serialises getMedia. The resolved-value check inside acquireMedia is
   * NOT a lock: getMedia is called from more than one command in the same
   * call (start-local, then create-offer/create-answer a tick later), and
   * the first call awaits the CallKit audio session (up to 1500ms) and then
   * getUserMedia (a permission prompt) before it ever assigns
   * localStreamRef. A second call entering that window sees a still-null
   * ref, opens a SECOND AVCaptureSession, and both assign localStreamRef —
   * the loser is then referenced by nothing, so releaseMedia has no handle
   * with which to release it and its camera capture is never stopped. That
   * is the "camera indicator stays on after a video call" bug: the orphaned
   * capture session outlives the call. Memoising the in-flight promise (not
   * just the resolved value) makes the second caller await the first. */
  function getMedia(video: boolean): Promise<MediaStream> {
    if (localStreamRef.current) {
      // Re-announce the stream even though it is being reused.
      //
      // acquireMedia's own tail — setLocalUrl + post("local-ready") — is
      // skipped by this early return, and useCall's local-ready handler is
      // what initialises the call's speaker state and route. Without this,
      // the path this early return exists for (a second call starting
      // before the previous one's teardown finished) came up with the
      // speaker state never initialised and the self-view still pointing at
      // the previous call's stream URL.
      //
      // Only the announcement is repeated here — no audio-session calls, so
      // this cannot disturb a route that is already live.
      setLocalUrl(localStreamRef.current.toURL());
      post({ type: "local-ready" });
      return Promise.resolve(localStreamRef.current);
    }
    if (mediaPromiseRef.current) return mediaPromiseRef.current;
    const pending = acquireMedia(video).finally(() => {
      mediaPromiseRef.current = null;
    });
    mediaPromiseRef.current = pending;
    return pending;
  }

  /**
   * Opens the camera/mic and hands the stream to WebRTC.
   *
   * REWRITTEN 2026-09-21. Everything that used to live here — CallKit audio
   * session waits, setAudioModeAsync, configureForVoiceCall,
   * enableWebRtcAudio, a 500ms watchdog re-asserting all of it, a "reused
   * stream" special case — is gone. None of it was the actual problem.
   *
   * Real telemetry (2026-09-21, Bek <-> Shakha) showed calls connecting
   * fine, audio flowing normally for several seconds, both legs' local mic
   * tracks staying enabled/live/unmuted and continuously SENDING bytes for
   * the whole call (outbound-rtp kept growing) — while the PEER stopped
   * receiving new packets a few seconds in, on a TURN relay pair. That is a
   * transport-level fault (ICE/relay), not anything an iOS audio session
   * API can fix. All the manual session management above was solving
   * problems from an earlier, different bug (CallKit's manual audio
   * handover racing WebRTC — see the rewrite history in this file's git
   * log) and had become dead weight once that was fixed by reverting
   * useManualAudio.
   *
   * What's left: call getUserMedia, hand the tracks to WebRTC, done.
   * RTCAudioSession (useManualAudio = false, set once at launch in
   * CallKitAppDelegateSubscriber) owns session activation entirely on its
   * own, exactly as it did in the last period this app is known to have
   * carried real 2+ minute calls (before 2026-09-18).
   */
  async function acquireMedia(video: boolean) {
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
      // Plain `true` on purpose: react-native-webrtc's constraints only
      // accept video fields (see its Constraints.d.ts). Echo cancellation
      // and automatic gain come from RTCAudioSessionConfiguration.webRTC()'s
      // own default mode, applied by the framework itself now that nothing
      // here overrides it.
      audio: true,
      // Ranges, not fixed values. Without constraints react-native-webrtc
      // negotiates something very conservative (often 320x240) that looks
      // soft on a phone screen — but pinning 720p/30 is the opposite
      // mistake: the capture device is then locked to that size regardless
      // of the network, and congestion control can only throw frames away.
      // Giving min/ideal/max lets the encoder actually scale down outdoors
      // on mobile data and back up on wifi.
      video: video
        ? {
            facingMode: "user",
            width: { min: 320, ideal: 1280, max: 1280 },
            height: { min: 240, ideal: 720, max: 720 },
            frameRate: { min: 15, ideal: 30, max: 30 },
          }
        : false,
    });

    // The call ended while the camera/mic were still opening. Nothing will
    // ever stop this stream — releaseMedia already ran, against refs that
    // were still null at the time — so stop it here and hand back nothing.
    // Without this the capture graph starts and is never torn down: the
    // camera indicator stays lit with no call on screen.
    if (mediaCancelledRef.current) {
      ((stream as MediaStream).getTracks() as MediaTrackHandle[]).forEach(releaseTrack);
      throw new Error("call ended before media was ready");
    }

    // Android has no RTCAudioSession-equivalent that claims the
    // communication audio path on its own — unlike iOS (see this function's
    // doc comment), where WebRTC's own native session owns this entirely and
    // calling anything here would be redundant. Without this, Android's
    // audio stream defaults to a plain media-playback mode: calls still
    // carry RTP (confirmed in call_diagnostics — audioBytes grows normally
    // on both legs) but play back through the wrong audio path, measured as
    // quiet/muffled compared to the iOS leg of the same call (2026-10-02).
    // iOS is untouched: this is a no-op there.
    if (Platform.OS === "android") {
      configureForVoiceCall();
    }

    localStreamRef.current = stream as MediaStream;
    setLocalUrl((stream as MediaStream).toURL());
    post({ type: "local-ready" });
    return stream as MediaStream;
  }

  /** Fully releases the camera, microphone and audio session.
   *
   * Every teardown path goes through this one function. They used to be
   * written out separately in the hangup command and the unmount cleanup,
   * and drifted: only one of them released the audio session, and NEITHER
   * stopped the tracks held by the peer connection's senders. addTrack()
   * hands the track to a sender that keeps its own reference, so stopping
   * only localStream's copies left the camera capturing — which is why the
   * green indicator stayed on after a call even though the code "stopped
   * the tracks". */
  function releaseMedia() {
    // Or the stall rescue fires into a call that is already over, and the
    // "one restart per call" flag leaks into the next one.
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    stallRestartedRef.current = false;
    isCallerRef.current = false;
    // Stop the periodic stats snapshot loop — it must not keep polling a
    // connection that is being torn down.
    statsRefreshGenerationRef.current += 1;

    answeredSdpRef.current = null;
    remoteStreamRef.current = null;
    offerCreatedRef.current = false;

    const pc = pcRef.current;
    if (pc) {
      // Senders hold their own references to the capture tracks; release
      // those before closing, or the native camera stays open.
      try {
        pc.getSenders?.().forEach((sender: { track?: MediaTrackHandle | null }) => {
          releaseTrack(sender.track);
        });
      } catch {
        // getSenders is absent on some react-native-webrtc versions; the
        // localStream release below still covers the common case.
      }
      // Outside the try above: close() used to sit inside it, so a throw
      // from getSenders/releaseTrack skipped it entirely and the native
      // RTCPeerConnection was never closed — peerConnectionDispose then
      // never ran and the native PC, its listeners and its track adapters
      // leaked for the lifetime of the process.
      try {
        pc.close();
      } catch {
        // Already closed, or closed underneath us — nothing to recover.
      }
    }
    (localStreamRef.current?.getTracks() as MediaTrackHandle[] | undefined)?.forEach(releaseTrack);
    localStreamRef.current = null;
    // An acquisition still in flight must not resolve into a stream nobody
    // releases; the mediaCancelledRef guard inside acquireMedia releases it,
    // and dropping the memoised promise here stops the NEXT call from
    // awaiting this dead one.
    mediaPromiseRef.current = null;
    pcRef.current = null;
    // Cleared here, not only in the "hangup" command: callActive-driven
    // teardown is the primary path, and leaving these queued meant the next
    // call applied the previous call's ICE candidates to a fresh peer
    // connection.
    pendingCandidatesRef.current = [];

    // Drop iOS's recording session. Restored 2026-09-21 after the audio
    // rewrite removed it along with everything else that touched
    // setAudioModeAsync.
    //
    // Stopping the tracks is not enough on its own: the playAndRecord
    // session stays active, so the OS keeps the orange recording indicator
    // lit and keeps ducking other audio. useRinger is now the only other
    // writer of this flag and it only ever sets it TRUE — with this gone,
    // nothing ever set it back, and the indicator stayed on until the app
    // was force-quit. Unlike the setCategory calls the rewrite removed,
    // this runs strictly AFTER the call's media is already torn down, so
    // there is no live audio for it to disturb.
    void setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false }).catch(
      () => {}
    );
  }

  /** Confirms media is ACTUALLY arriving from the peer, not just that ICE and
   * DTLS finished. pc.connectionState hits "connected" the moment the
   * handshake succeeds — a TURN relay that accepts connections but never
   * forwards RTP (the shared public relay this app falls back to under load)
   * reports the exact same "connected" state while both sides hear and see
   * nothing. Polling getStats()'s inbound-rtp bytesReceived a few times a
   * second and requiring it to actually GROW is the only way to tell "media
   * is flowing" from "the relay lied". Posts "media-flowing" once, the first
   * time growth is observed, then stops — this is a one-shot gate for the UI
   * to leave its "connecting" stage, not an ongoing quality monitor. */
  /** Reads the one-shot connection facts worth keeping after a call: which
   * candidate pair ICE settled on (relay vs direct — the question that
   * decides whether TURN capacity is the problem), the relay address if any,
   * and basic inbound quality counters. Best-effort throughout: getStats
   * shapes vary between platforms and WebRTC versions, and a missing field
   * here must never interfere with the call itself. */
  /** Keeps re-posting call-stats every 5s for the rest of the call, so
   * whatever ends up in call_diagnostics reflects near the ACTUAL end of the
   * call rather than a single snapshot taken seconds after it started. See
   * the call site in watchForInboundMedia for why this exists.
   *
   * 5s rather than the old watchdog's 500ms deliberately: this is a
   * diagnostic value, not something being acted on, so it doesn't need
   * sub-second freshness — and getStats() has a real cost that a 500ms
   * poll for the rest of every call is not worth paying just to make a
   * number in a database slightly more current. */
  async function periodicallyRefreshStats(pc: RTCPeerConnectionType) {
    const generation = ++statsRefreshGenerationRef.current;
    const loopStartedAt = Date.now();
    // 2s rather than a flat 5s: measured 2026-09-21, several real calls
    // lasted only 11-14s total — media-flowing fired around the 7-10s mark,
    // and the user hung up 2-4s later. A 5s interval never got a second
    // sample in before the call ended, so the "how did audio behave for the
    // REST of the call" question this exists to answer went right back to
    // being unanswerable for exactly the short calls where it matters most
    // (a call someone hangs up quickly because they can't hear anything IS
    // the symptom). Cheap enough to run this often — getStats() is a local
    // read, not a network call.
    //
    // 2026-09-24: real calls show audioPkts frozen from the FIRST 2s sample
    // through the entire rest of a 76s call on both legs — meaning the
    // freeze happens somewhere inside that first 2s window, which this
    // cadence is too coarse to localize. For the first 6s after
    // media-flowing (i.e. right where tuneForMobileNetwork's setParameters
    // also runs), sample every 500ms instead, so the exact tick where
    // audioPkts stops advancing is visible rather than inferred.
    let lastAudioPackets = -1;
    let sawGrowthAfterFirstSample = false;
    while (true) {
      const elapsed = Date.now() - loopStartedAt;
      await new Promise((resolve) => setTimeout(resolve, elapsed < 6000 ? 500 : 2000));
      if (statsRefreshGenerationRef.current !== generation) return;
      if (pcRef.current !== pc) return;
      const state = pc.connectionState;
      if (state === "closed" || state === "failed") return;
      try {
        const stats = await collectCallStats(pc, null);
        const currentPackets = stats.audioPacketsReceived ?? -1;
        if (lastAudioPackets >= 0 && currentPackets > lastAudioPackets) {
          sawGrowthAfterFirstSample = true;
        } else if (lastAudioPackets >= 0 && currentPackets === lastAudioPackets && !sawGrowthAfterFirstSample) {
          post({
            type: "log",
            message: `audioPkts stalled at ${currentPackets} (t=${elapsed}ms, no growth since first sample)`,
          });
        }
        lastAudioPackets = currentPackets;
        post(stats);
      } catch {
        return;
      }
      // Route snapshot on the SAME cadence, not just the one-shot at
      // media-flowing. Added because the one-shot version's error handling
      // was fixed (it used to swallow failures with a bare `catch {}`,
      // which is why call_diagnostics 158/159 on 2026-09-24 never showed
      // this line at all despite media-flowing firing on both legs) but a
      // single snapshot still can't tell "silent from the start" apart
      // from "was fine, then something changed the route mid-call" (a
      // Bluetooth device connecting, an interruption ending, CallKit
      // handing the session back). Best-effort and read-only, same as the
      // one-shot version — a failure here must never end the call, only
      // be visible in its trace.
      try {
        const snap = audioRouteSnapshot();
        const outputs = Array.isArray(snap.outputs)
          ? (snap.outputs as { portType?: string; portName?: string }[])
              .map((o) => `${o.portType ?? "?"}/${o.portName ?? "?"}`)
              .join(",")
          : "none";
        post({
          type: "log",
          message:
            `audio route (periodic): outputs=[${outputs}] volume=${String(snap.outputVolume ?? "?")} ` +
            `category=${String(snap.category ?? "?")} mode=${String(snap.mode ?? "?")} ` +
            `rtcEnabled=${String(snap.rtcIsAudioEnabled ?? "?")} rtcActive=${String(snap.rtcIsActive ?? "?")} ` +
            `otherAudioPlaying=${String(snap.isOtherAudioPlaying ?? "?")} ` +
            `ioChannels=${String(snap.rtcInputChannels ?? "?")}/${String(snap.rtcOutputChannels ?? "?")} ` +
            `sampleRate=${String(snap.rtcSampleRate ?? "?")} ioBuffer=${String(snap.rtcIOBufferDuration ?? "?")}`,
        });
      } catch (snapshotError) {
        post({
          type: "log",
          message: `audio route (periodic) snapshot failed: ${
            snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
          }`,
        });
      }
    }
  }

  async function collectCallStats(
    pc: RTCPeerConnectionType,
    msToMedia: number | null
  ): Promise<Extract<BridgeEvent, { type: "call-stats" }>> {
    const result: Extract<BridgeEvent, { type: "call-stats" }> = {
      type: "call-stats",
      selectedCandidatePair: null,
      audioBytesReceived: 0,
      audioPacketsReceived: 0,
      turnServer: null,
      msToMedia,
      bytesReceived: null,
      packetsLost: null,
      jitterMs: null,
    };
    try {
      const report = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      report.forEach((stat: Record<string, unknown>) => {
        if (typeof stat.id === "string") byId.set(stat.id, stat);
      });

      let bytes = 0;
      let lost = 0;
      let received = 0;
      let jitter: number | null = null;
      let audioBytes = 0;
      let audioPackets = 0;
      let outboundAudioBytes = 0;
      let outboundAudioPackets = 0;
      byId.forEach((stat) => {
        if (stat.type === "inbound-rtp") {
          if (typeof stat.bytesReceived === "number") bytes += stat.bytesReceived;
          if (typeof stat.packetsLost === "number") lost += stat.packetsLost;
          if (typeof stat.packetsReceived === "number") received += stat.packetsReceived;
          // Reported in seconds by the spec; stored as milliseconds.
          if (typeof stat.jitter === "number") jitter = stat.jitter * 1000;
          // Split out AUDIO specifically.
          //
          // Everything above sums audio and video together, which made
          // "media-flowing" fire — and every diagnostic read healthy — on a
          // call where only the VIDEO track was arriving and the audio track
          // was silent. That is invisible in a combined byte count, because
          // video dwarfs audio by two orders of magnitude, and it is why a
          // full day of route/session fixes kept reporting success on calls
          // the user could not hear.
          if (stat.kind === "audio" || stat.mediaType === "audio") {
            if (typeof stat.bytesReceived === "number") {
              audioBytes += stat.bytesReceived;
            }
            if (typeof stat.packetsReceived === "number") {
              audioPackets += stat.packetsReceived;
            }
          }
        }
        // OUTBOUND audio — what THIS device is actually sending, not what
        // the peer received.
        //
        // Never tracked before. Every diagnostic in this file only ever
        // looked at inbound-rtp, so a device whose own microphone capture
        // was broken (track present, but not producing samples — a muted
        // hardware mic, a capture session that failed to start, a track
        // whose `enabled` got left false) was invisible from its OWN trace:
        // it could only be inferred after the fact from the PEER's inbound
        // count being low, which then had to be attributed to something —
        // route, session, ICE — with no way to rule any of them in or out
        // directly. This makes "did my own mic actually produce audio"
        // answerable from a single side's data.
        if (stat.type === "outbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) {
          if (typeof stat.bytesSent === "number") outboundAudioBytes += stat.bytesSent;
          if (typeof stat.packetsSent === "number") outboundAudioPackets += stat.packetsSent;
        }
      });
      result.bytesReceived = bytes;
      result.audioBytesReceived = audioBytes;
      result.audioPacketsReceived = audioPackets;
      result.outboundAudioBytesSent = outboundAudioBytes;
      result.outboundAudioPacketsSent = outboundAudioPackets;
      result.packetsLost = lost;
      result.packetsReceived = received;
      result.jitterMs = jitter;

      // Local track state — the most direct possible answer to "is the mic
      // itself the problem." Read straight off the sender's track, not
      // derived from anything WebRTC has negotiated or transmitted, so this
      // is true even if outbound-rtp above is empty because nothing has
      // been sent yet.
      try {
        const senders = (
          pc as unknown as {
            getSenders?: () => { track?: { kind?: string; enabled?: boolean; readyState?: string; muted?: boolean } | null }[];
          }
        ).getSenders?.();
        const audioSender = senders?.find((s) => s.track?.kind === "audio");
        if (audioSender?.track) {
          result.localAudioTrackEnabled = audioSender.track.enabled ?? null;
          result.localAudioTrackReadyState = audioSender.track.readyState ?? null;
          result.localAudioTrackMuted = audioSender.track.muted ?? null;
        } else {
          result.localAudioTrackEnabled = null;
          result.localAudioTrackReadyState = "no-audio-sender";
          result.localAudioTrackMuted = null;
        }
      } catch {
        // Diagnostics only.
      }

      // Remote (inbound) track state — added 2026-09-24 alongside the
      // stalled-audioPkts detection above. Distinguishes two very different
      // failures that both look like "audioPkts stopped growing": the
      // TRANSPORT stopped delivering RTP (this stays enabled/live/unmuted
      // while inbound-rtp simply reports nothing new — a network/relay
      // problem), versus the receiver's OWN track going muted/ended while
      // the transport is fine (a local playback/decoder problem, which
      // outbound-rtp on the peer's own trace could never reveal since that
      // peer's send path might be working perfectly).
      try {
        const receivers = (
          pc as unknown as {
            getReceivers?: () => { track?: { kind?: string; enabled?: boolean; readyState?: string; muted?: boolean } | null }[];
          }
        ).getReceivers?.();
        const audioReceiver = receivers?.find((r) => r.track?.kind === "audio");
        if (audioReceiver?.track) {
          result.remoteAudioTrackEnabled = audioReceiver.track.enabled ?? null;
          result.remoteAudioTrackReadyState = audioReceiver.track.readyState ?? null;
          result.remoteAudioTrackMuted = audioReceiver.track.muted ?? null;
        } else {
          result.remoteAudioTrackEnabled = null;
          result.remoteAudioTrackReadyState = "no-audio-receiver";
          result.remoteAudioTrackMuted = null;
        }
      } catch {
        // Diagnostics only.
      }

      // The selected pair is the one marked selected, or (on some
      // implementations) the succeeded pair referenced by the transport.
      // Follow the transport's own pointer first — the spec-sanctioned way.
      //
      // The previous selector relied on `stat.selected === true`, a legacy
      // non-standard field libwebrtc's standard stats API does not emit at
      // all, leaving `state === "succeeded"` as the only working half. A
      // sample taken while ICE is still on an in-progress pair that is
      // nonetheless carrying RTP then found nothing and reported "pair=?"
      // for a perfectly healthy call — which is exactly what the caller's
      // leg logged on 2026-09-20 while media was demonstrably flowing,
      // sending this investigation looking for a stale peer connection that
      // did not exist.
      let pair: Record<string, unknown> | undefined;
      let selectedPairId: string | undefined;
      byId.forEach((stat) => {
        if (stat.type === "transport" && typeof stat.selectedCandidatePairId === "string") {
          selectedPairId = stat.selectedCandidatePairId;
        }
      });
      if (selectedPairId) pair = byId.get(selectedPairId);
      if (!pair) {
        byId.forEach((stat) => {
          if (
            stat.type === "candidate-pair" &&
            (stat.nominated === true || stat.selected === true || stat.state === "succeeded")
          ) {
            if (!pair || stat.nominated === true || stat.selected === true) pair = stat;
          }
        });
      }
      if (pair) {
        const local = byId.get(String(pair.localCandidateId ?? ""));
        const remote = byId.get(String(pair.remoteCandidateId ?? ""));
        const localType = typeof local?.candidateType === "string" ? local.candidateType : "?";
        const remoteType = typeof remote?.candidateType === "string" ? remote.candidateType : "?";
        result.selectedCandidatePair = `${localType}/${remoteType}`;
        if (typeof pair.currentRoundTripTime === "number") result.rttMs = Math.round(pair.currentRoundTripTime * 1000);
        if (typeof pair.availableOutgoingBitrate === "number") result.availableOutgoingKbps = Math.round(pair.availableOutgoingBitrate / 1000);
        // Only a relay candidate carries a meaningful server address.
        const relay = localType === "relay" ? local : remoteType === "relay" ? remote : undefined;
        if (relay) {
          const address = relay.address ?? relay.ip ?? null;
          const port = relay.port ?? null;
          if (address) result.turnServer = port ? `${address}:${port}` : String(address);
        }
        if (localType === "relay" && typeof local?.url === "string") result.relayUrl = local.url;
      }
    } catch {
      // Stats are diagnostics, never a reason to disturb a live call.
    }
    return result;
  }

  async function watchForInboundMedia(pc: RTCPeerConnectionType) {
    const startedAt = Date.now();
    // Raised from 8000ms 2026-09-20 for cross-border reliability. An
    // international relay path (two intercontinental hops through one TURN
    // server — caller to relay, relay to callee) carries real added RTT on
    // top of the usual congestion, and a connection that reports
    // "connected" can still take a few seconds longer to get its first RTP
    // packet flowing than the same call within one country. 8s was timing
    // that out as a dead relay before it had actually failed.
    const deadline = startedAt + 12000;
    const generation = ++mediaWatchGenerationRef.current;
    let lastBytes = -1;
    while (Date.now() < deadline) {
      if (mediaCancelledRef.current || pcRef.current !== pc) return;
      // Superseded by a newer watchdog (an ICE restart armed one): stop
      // silently rather than racing it to report an outcome.
      if (mediaWatchGenerationRef.current !== generation) return;
      try {
        const report = await pc.getStats();
        let bytes = 0;
        report.forEach((stat: { type: string; kind?: string; bytesReceived?: number }) => {
          if (stat.type === "inbound-rtp" && typeof stat.bytesReceived === "number") {
            bytes += stat.bytesReceived;
          }
        });
        if (lastBytes >= 0 && bytes > lastBytes) {
          // Entry marker, unconditional and outside any try/catch — proves
          // this branch was actually reached, independent of whether the
          // snapshot below succeeds. Without this, "no audio route line in
          // the trace" is ambiguous between "the snapshot call threw" and
          // "this code path never ran at all" (e.g. bytes never grew, or
          // grew on a stats read this function's own generation guard had
          // already invalidated). Exactly the ambiguity that made
          // call_diagnostics 158/159 (2026-09-24) unreadable.
          post({ type: "log", message: "media-flowing branch entered" });
          // One-time, READ-ONLY route snapshot the instant media is proven
          // to be flowing.
          //
          // Added 2026-09-23 after telemetry showed a 34-second call with
          // audio packets arriving continuously and symmetrically on both
          // legs, surviving a mid-call network change — and the user still
          // heard nothing. That rules out WebRTC, ICE and the transport
          // entirely: decoded audio was arriving at the track. What was
          // never actually verified is what happens after that — whether
          // the OS route those decoded samples are being played through
          // has a live output at all, or is pointed at something silent
          // (system volume at 0, a route to a disconnected Bluetooth
          // device, a route with no output). This is read-only diagnostics
          // — it does not call setCategory or touch the route in any way,
          // so it cannot itself disturb a working call the way earlier
          // "fixes" in this file did.
          try {
            const snap = audioRouteSnapshot();
            const outputs = Array.isArray(snap.outputs)
              ? (snap.outputs as { portType?: string; portName?: string }[])
                  .map((o) => `${o.portType ?? "?"}/${o.portName ?? "?"}`)
                  .join(",")
              : "none";
            post({
              type: "log",
              message:
                `audio route: outputs=[${outputs}] volume=${String(snap.outputVolume ?? "?")} ` +
                `category=${String(snap.category ?? "?")} mode=${String(snap.mode ?? "?")} ` +
                `rtcEnabled=${String(snap.rtcIsAudioEnabled ?? "?")} rtcActive=${String(snap.rtcIsActive ?? "?")} ` +
                `otherAudioPlaying=${String(snap.isOtherAudioPlaying ?? "?")} ` +
                `ioChannels=${String(snap.rtcInputChannels ?? "?")}/${String(snap.rtcOutputChannels ?? "?")} ` +
                `sampleRate=${String(snap.rtcSampleRate ?? "?")} ioBuffer=${String(snap.rtcIOBufferDuration ?? "?")}`,
            });
          } catch (snapshotError) {
            // Surfaced, not swallowed: a bare `catch {}` here is exactly
            // why this diagnostic went missing from real call traces on
            // 2026-09-24 (call_diagnostics ids 158/159) — media-flowing
            // fired on both legs but the "audio route:" line that should
            // have preceded it never appeared in either trace, which is
            // only possible if something in this block threw and was
            // silently discarded. Posting the failure AS a log line (not
            // throwing further — this must never affect the call) means
            // the next real call's trace shows WHY the snapshot is
            // missing instead of just that it's missing.
            post({
              type: "log",
              message: `audio route snapshot failed: ${
                snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
              }`,
            });
          }
          post({ type: "media-flowing" });
          post(await collectCallStats(pc, Date.now() - startedAt));
          // Keep re-snapshotting stats for the rest of the call.
          //
          // Until this, call-stats was posted exactly once, right here —
          // whatever audioBytes/audioPkts the call had at THIS instant is
          // what call_diagnostics stored for its entire duration, however
          // long the call actually ran afterward. A call that looked
          // healthy 4 seconds in could still go completely silent a moment
          // later with nothing in the data to show it, which is exactly
          // the gap between "the trace says audio was flowing" and "the
          // user couldn't hear anything." Comparing consecutive audioPkts
          // snapshots is what actually answers "did audio keep flowing for
          // the whole call, or die partway through."
          void periodicallyRefreshStats(pc);
          return;
        }
        lastBytes = bytes;
      } catch {
        // getStats unsupported or the connection closed mid-poll — nothing
        // to recover, just stop polling.
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Timed out with no growth: media genuinely never started flowing (dead
    // TURN relay is the common cause). onconnectionstatechange's own
    // "disconnected"/"failed" handling in useCall never fires for this case
    // — the PC's connectionState legitimately says "connected" throughout,
    // since the ICE/DTLS handshake really did succeed; only the media plane
    // is silently dead. Posting media-timeout lets useCall attempt an ICE
    // restart (a real second chance at a working relay pair, not just a
    // label change) instead of leaving the call sitting on "Connecting…"
    // forever with no way out but a manual hangup.
    if (
      !mediaCancelledRef.current &&
      pcRef.current === pc &&
      mediaWatchGenerationRef.current === generation
    ) {
      // Stats BEFORE the timeout event: useCall may restart ICE or end the
      // call on receiving media-timeout, and the candidate pair that failed
      // is the single most useful thing to have recorded about it.
      post(await collectCallStats(pc, null));
      post({ type: "media-timeout" });
    }
  }

  /** Tunes how the connection spends a limited uplink.
   *
   * On a congested mobile network WebRTC has to drop something, and by
   * default it treats audio and video as equals — so a call on a weak
   * connection degrades into broken speech, which is the one thing that
   * makes a call worthless. Audio is tiny (tens of kbit/s) compared to
   * video (hundreds), so protecting it costs almost nothing in picture
   * quality but is the difference between "grainy but usable" and "can't
   * hear you".
   *
   * Best-effort throughout: setParameters and the encoding fields it takes
   * are optional in react-native-webrtc, and an older build simply keeps
   * the defaults rather than failing the call. */
  // Video ceiling by network, so a call doesn't eat a mobile data plan:
  // Wi-Fi/wired 2.5 Mbit/s (720p, sharp through motion), cellular 1 Mbit/s
  // (≈450 MB/h instead of ≈1.1 GB/h, still 720p for a steady picture and
  // scaled down by congestion control on motion), Low Data Mode 350 kbit/s at
  // 20 fps. Re-applied on every path change mid-call (see the listener in
  // the call effect), since Wi-Fi -> cellular keeps the same connection.
  function videoCeiling(path: NetworkPath | null): { maxBitrate: number; maxFramerate: number } {
    if (path?.constrained) return { maxBitrate: 350_000, maxFramerate: 20 };
    if (path?.interface === "cellular" || path?.expensive) return { maxBitrate: 1_000_000, maxFramerate: 30 };
    return { maxBitrate: 2_500_000, maxFramerate: 30 };
  }

  async function applyVideoCeiling(pc: RTCPeerConnectionType, path: NetworkPath | null) {
    const senders = (pc as unknown as { getSenders?: () => { track?: { kind?: string } | null; getParameters?: () => { encodings?: Record<string, unknown>[] }; setParameters?: (p: unknown) => Promise<void> }[] }).getSenders?.();
    const ceiling = videoCeiling(path);
    for (const sender of senders ?? []) {
      if (sender.track?.kind !== "video" || !sender.getParameters || !sender.setParameters) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      for (const encoding of params.encodings) Object.assign(encoding, ceiling);
      try {
        await sender.setParameters(params);
        post({ type: "log", message: `video ceiling ${ceiling.maxBitrate / 1000}k/${ceiling.maxFramerate}fps (${path?.interface ?? "unknown"}${path?.constrained ? ", low data" : ""})` });
      } catch (error) {
        post({ type: "log", message: `video ceiling failed: ${String(error)}` });
      }
    }
  }

  async function tuneForMobileNetwork(pc: RTCPeerConnectionType) {
    try {
      const senders = (
        pc as unknown as {
          getSenders?: () => {
            track?: { kind?: string } | null;
            getParameters?: () => { encodings?: Record<string, unknown>[] };
            setParameters?: (p: unknown) => Promise<void>;
          }[];
        }
      ).getSenders?.();
      if (!senders) return;

      for (const sender of senders) {
        const kind = sender.track?.kind;
        if (!kind || !sender.getParameters || !sender.setParameters) continue;

        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }

        for (const encoding of params.encodings) {
          if (kind === "audio") {
            // Highest priority, and a floor high enough for full-band speech
            // rather than the narrowband fallback congestion control would
            // otherwise pick. 64 kbit/s is wideband Opus — the difference
            // between "clear" and "telephone quality", for a rounding error
            // of bandwidth next to video.
            encoding.priority = "high";
            encoding.networkPriority = "high";
            encoding.maxBitrate = 64000;
          } else {
            // 900 kbit/s. 600 kbit/s was tried and proved too aggressive for
            // 720p/30fps — the encoder starves and the picture visibly lags
            // even on a solid connection, which is what "video quality badly
            // degraded" turned out to be. Audio no longer needs video capped
            // this hard to protect it: the encoding above already gives audio
            // its own "high" priority/networkPriority and a 64 kbit/s floor,
            // which is what actually keeps speech clear under congestion —
            // starving video further on top of that just made the picture
            // worse without helping audio.
            encoding.priority = "medium";
            encoding.networkPriority = "medium";
            // 700kbit/s, revised 2026-09-20 after measurement (briefly 300k
            // while reliability was unproven, originally 900k).
            //
            // 300k was chosen to protect cross-border calls that had not yet
            // been shown to work at all; they now do, including over relay,
            // so the extra headroom is better spent on the picture. 700k
            // suits 540p comfortably while still leaving room for audio's
            // 64kbit/s floor and its "high" priority below — on a congested
            // international relay the degradation preference (framerate-
            // first) absorbs the rest rather than the call breaking up.
            //
            // 2026-10-17: raised to 2.5 Mbit/s with H.264 hardware encoding
            // on iOS (lib/webrtc tuneVideoSdp) and a 1.2 Mbit/s start
            // bitrate — 900k capped a 720p picture at visibly soft even on
            // fast Wi-Fi. Congestion control still steps it down on a weak
            // link; this is only the ceiling.
            Object.assign(encoding, videoCeiling(currentNetwork()));
            // "balanced", 2026-10-17. "maintain-framerate" (below, kept for
            // the history) dropped RESOLUTION first under any pressure, which
            // is the blurry picture people reported; balanced gives up a
            // little of each, so faces stay readable and motion stays smooth.
            // Was: prefers dropping resolution over frame rate when the link
            // tightens — smoothness reads as "call is working" on a long
            // relay path, and keeps audio from being starved by video retries.
            encoding.degradationPreference = "balanced";
          }
        }

        await sender.setParameters(params);
        if (kind === "audio") {
          // 2026-09-24: real calls show inbound/outbound RTP counters
          // frozen solid within 1-2s of connect — right where this runs on
          // BOTH peers (connectionState -> "connected" fires close together
          // on caller and callee). A silently swallowed failure here, or a
          // native encoder that accepts the call but glitches applying it,
          // would explain a freeze with no other trace event anywhere. This
          // makes the outcome a fact instead of a blind spot: confirms the
          // call succeeded, or (if the catch below fires) that it didn't.
          post({
            type: "log",
            message: "tuneForMobileNetwork: audio setParameters applied ok",
          });
        }
      }
    } catch (tuneError) {
      // Any failure here leaves WebRTC's own defaults in place; the call
      // still works, just without the audio-first bias. Logged rather than
      // silently swallowed as of 2026-09-24 — see the audio branch above.
      post({
        type: "log",
        message: `tuneForMobileNetwork failed: ${
          tuneError instanceof Error ? tuneError.message : String(tuneError)
        }`,
      });
    }
  }

  releaseMediaRef.current = releaseMedia;

  function createPeer(iceServers: RTCIceServer[]) {
    const webrtc = getWebRtc();
    if (!webrtc) throw new Error("Calls need a development build.");
    // Close any previous connection first. Without this, a renegotiation or a
    // duplicated answer leaves the old peer connection alive and holding the
    // mic, while candidates for the new one are applied to a connection
    // nobody reads.
    pcRef.current?.close();
    const config = {
      iceServers,
      // iceCandidatePoolSize (previously 4) REMOVED 2026-09-19: it was
      // added to gather candidates before the offer for a faster pickup,
      // but calls that worked reliably on 2026-09-16 (3-4 minute real
      // calls, confirmed via the calls table) ran WITHOUT it — this option
      // did not exist in that version of createPeer at all. Every call
      // since it was added has gathered host and srflx candidates fine but
      // NEVER a single relay candidate, on either side, across multiple
      // test calls and multiple TURN transport variants (UDP:80, UDP:443,
      // TCP:443) — consistent with react-native-webrtc's own known issues
      // around pre-gathering a candidate pool before setLocalDescription
      // interacting badly with TURN allocation specifically (the pooled
      // gathering runs against a placeholder session description, and some
      // native WebRTC versions handle the TURN permission/allocation
      // lifecycle differently for pooled vs. on-demand candidates). Pulling
      // it back out restores the exact peer connection shape that was
      // proven to reach relay candidates before.
      //
      // Lets ICE re-pick a working route mid-call (e.g. Wi-Fi to cellular
      // handover) rather than dropping the call when the current path dies.
      iceTransportPolicy: "all" as const,
      // Android only (iOS's react-native-webrtc doesn't read this key): keep
      // gathering candidates for the whole call, so a Wi-Fi <-> cellular
      // switch surfaces a working new path on its own. iOS gets the same
      // effect from the network monitor in useCall, which restarts ICE the
      // moment the interface changes.
      // (not in react-native-webrtc's TS types, hence the spread)
      ...({ continualGatheringPolicy: "gather_continually" } as object),
      // Both added 2026-09-19 to cut the time spent in "Connecting…".
      //
      // Measured problem: with a relay now in play, ICE needs a few seconds
      // to find a working pair, and real users hang up before it does —
      // call_diagnostics shows three calls abandoned at 8, 13 and 14
      // seconds while still negotiating, versus the one call that was given
      // time and connected fine over relay. Nothing was broken in those
      // calls; they simply ran out of patience.
      //
      // max-bundle puts audio and video on ONE transport instead of
      // negotiating a separate ICE component per media type, so there is a
      // single connectivity check to win rather than two — roughly halving
      // the work before a video call can start. require rtcp-mux folds RTCP
      // onto that same port as well, removing another port's worth of
      // checks. Both are universally supported by modern WebRTC stacks
      // (and by the identical react-native-webrtc build on both ends here),
      // so there is no fallback risk in requiring them.
      bundlePolicy: "max-bundle" as const,
      rtcpMuxPolicy: "require" as const,
    };
    peerConfigRef.current = config;
    const pc = new webrtc.RTCPeerConnection(config);

    // react-native-webrtc types these callbacks as a bare Event<string>
    // without the payload fields, so the runtime shapes are annotated here.
    relayCandidateCountRef.current = 0;
    pc.onicecandidate = (event: unknown) => {
      const { candidate } = event as { candidate: RTCIceCandidate | null };
      if (candidate) {
        // Diagnostic only, added 2026-09-19 while investigating calls stuck
        // on "Connecting" indefinitely on both real devices in a test call:
        // the existing trace showed candidates being SENT but gave no way
        // to tell whether a "relay" (TURN) candidate was ever gathered at
        // all, versus gathered but never successfully paired. candidateType
        // is parsed straight out of the ICE candidate string's "typ" field
        // (host/srflx/relay per RFC 5245) rather than relying on any
        // react-native-webrtc-specific field, since that library's
        // RTCIceCandidate typing is otherwise as thin as onicecandidate's
        // event shape above.
        const typeMatch = /typ (\w+)/.exec(candidate.candidate ?? "");
        const candType = typeMatch?.[1] ?? "?";
        if (candType === "relay") relayCandidateCountRef.current += 1;
        post({
          type: "log",
          message: `ice-candidate gathered: type=${candType} protocol=${candidate.protocol ?? "?"}`,
        });
        post({ type: "ice-candidate", candidate: candidate.toJSON() });
      } else {
        // A null candidate is the spec's own signal for "gathering finished
        // for this generation" — distinct from icegatheringstatechange
        // firing "complete" (both exist; this one is guaranteed to include
        // the final tally at the point gathering actually stops).
        //
        // Flagged here, not just left to the post-call selectedCandidatePair
        // stat, because those look identical from the trace afterward —
        // "no relay in the pair" is ambiguous between "TURN never offered
        // one" (all three transports blocked/down — the fault is the relay
        // itself) and "a relay was offered but ICE picked something else or
        // the pair failed" (the fault is elsewhere). A zero-relay round
        // means every ExpressTURN transport (UDP:3478, TLS:443, TCP:3478)
        // failed to allocate for THIS device on THIS network, which is
        // exactly the fact call_diagnostics needs to tell "our TURN account
        // is the bottleneck" apart from "this specific pairing didn't work
        // this time."
        if (relayCandidateCountRef.current === 0) {
          post({
            type: "log",
            message: "gathering complete with ZERO relay candidates — all TURN transports failed for this network",
          });
        }
        post({ type: "log", message: "ice-candidate gathering complete (null candidate)" });
      }
    };

    pc.ontrack = (event: unknown) => {
      const [stream] = (event as { streams: MediaStream[] }).streams ?? [];
      if (!stream) return;
      remoteStreamRef.current = stream;
      setRemoteUrl(stream.toURL());

      // Gain boost re-added 2026-10-03. Removed 2026-09-21 only because it
      // was, at the time, the last untested link in a total-silence bug —
      // not because it was ever confirmed to cause anything. That bug's
      // real cause (createAudioPlayer missing keepAudioSessionActive, killing
      // the shared iOS session — see project memory) was found and fixed
      // 2026-09-24/2026-10-02, so _setVolume was never actually at fault.
      // 2.5x brings both legs of a call up from "audible but quiet" to
      // comfortable at normal device volume, on top of (not instead of) the
      // Android communication-mode fix in acquireMedia and the ringer volume
      // bump in useRinger — same intent (louder everywhere), three different
      // links in the chain (the ringtone before answer, the OS audio route
      // during the call, and now the signal gain itself).
      ((event as { streams: MediaStream[] }).streams[0]
        ?.getAudioTracks() as unknown as { _setVolume?: (v: number) => void }[] | undefined
      )?.forEach((track) => {
        try {
          track._setVolume?.(2.5);
        } catch {
          // Best-effort — a call must never fail over a volume tweak.
        }
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState ?? "unknown";
      post({ type: "connection-state", state });
      // Encoder parameters only exist once the connection is actually up:
      // before setLocalDescription there are no encodings to modify, so
      // tuning at addTrack time (where this used to run) silently did
      // nothing at all. Re-applied on every reconnect too, since a fresh
      // negotiation resets them.
      if (state === "connected") {
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }
        void tuneForMobileNetwork(pc);
        void watchForInboundMedia(pc);
      }

      // Stalled-negotiation rescue. WebRTC's own ICE failure timeout is on
      // the order of 15-30s, and real users do not wait that long: three
      // calls on 2026-09-19 were hung up at 8, 13 and 14 seconds while
      // still in "connecting", all of them with a usable relay candidate
      // already gathered on both sides.
      //
      // Caller only (isCallerRef), and reported rather than acted on: this
      // used to call createOffer({iceRestart:true}) directly, from a timer
      // that both sides armed. Every failed call in call_diagnostics on
      // 2026-09-19 shows the result — "stalled at 6s" on BOTH ends, two
      // restart offers crossing, ICE re-gathering from scratch on each
      // side, and a hangup ~6s later with no candidate pair ever selected.
      //
      // 9s rather than 6s: the same traces show candidates still arriving
      // at 10.6s on a working relay path, so 6s was interrupting
      // negotiations that were still making progress. 9s is still well
      // inside the window where a caller is willing to wait.
      if (
        state === "connecting" &&
        isCallerRef.current &&
        !stallTimerRef.current &&
        !stallRestartedRef.current
      ) {
        stallTimerRef.current = setTimeout(() => {
          stallTimerRef.current = null;
          if (pcRef.current !== pc) return;
          if (pc.connectionState === "connected") return;
          stallRestartedRef.current = true;
          post({ type: "log", message: "negotiation stalled at 9s" });
          post({ type: "negotiation-stalled" });
        }, 9000);
      }
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
    // A command queued before teardown (or broadcast late) must not
    // re-acquire media after the call is over. useCall's pendingCommands
    // queue is replayed on the next bridge "ready", and a stray
    // create-offer/create-answer/start-local surviving into that replay
    // opened the camera with no call on screen. "hangup" is exempt — it is
    // the teardown itself.
    // A setup command re-arms the bridge rather than being dropped.
    //
    // mediaCancelledRef is set when callActive goes false and cleared only
    // when the callActive EFFECT runs on the way back up. But the overlay
    // keeps this bridge mounted through the "ended" phase (it unmounts only
    // at "idle", 3s later), and startCall/accept call sendCommand in the
    // SAME tick as the setState that flips callActive — so the command
    // arrives synchronously, before React has run that effect, while the
    // flag is still true from the previous call. The command was then
    // silently dropped with no queue to replay it (pendingCommandsRef only
    // covers the case where the bridge isn't mounted at all).
    //
    // Symptom: start a second call within ~3s of the previous one ending,
    // and the mic never opens, no offer is ever sent, and the callee rings
    // until it times out.
    //
    // Only the three commands that BEGIN a call re-arm; everything else
    // still respects the cancellation, so a late ice-candidate or a toggle
    // arriving after teardown cannot resurrect a dead call.
    if (
      mediaCancelledRef.current &&
      (command.type === "start-local" ||
        command.type === "create-offer" ||
        command.type === "create-answer")
    ) {
      mediaCancelledRef.current = false;
    }
    if (mediaCancelledRef.current && command.type !== "hangup") return;
    try {
      if (command.type === "start-local") {
        // Start ICE gathering NOW, in parallel with opening the camera,
        // rather than after it.
        //
        // Measured 2026-09-19: the single strongest predictor of whether a
        // video call connects is how quickly the first candidate is
        // gathered. Calls whose first candidate appeared at 35ms connected
        // in ~540ms; calls where it appeared at 1398ms and 4372ms both died
        // with no candidate pair ever selected. The delay was never the
        // network — it was this side not having STARTED yet, because
        // createPeer ran only after acquireMedia, which first awaits the
        // CallKit audio session (up to 1500ms) and then getUserMedia (a
        // permission prompt and an AVCaptureSession start).
        //
        // Gathering candidates needs none of that: it is a property of the
        // network interfaces and the ICE servers, not of the microphone. So
        // the peer connection is built here, the moment the call starts, and
        // begins probing STUN/TURN while the camera is still warming up. By
        // the time create-offer has a stream to attach, the relay candidate
        // it needs has usually already arrived.
        //
        // create-offer reuses this connection (pcRef) instead of building a
        // second one — see its own branch. iceServers is optional purely so
        // older callers of start-local keep working unchanged.
        if (command.iceServers && !pcRef.current) {
          isCallerRef.current = true;
          createPeer(command.iceServers);
        }
        await getMedia(!!command.video);
        return;
      }

      if (command.type === "create-offer") {
        const stream = await getMedia(!!command.video);
        // mediaCancelledRef is only checked at the TOP of handleCommand —
        // but this await can take long enough (permission prompt, a slow
        // capture-session start) for a hangup to land while it was in
        // flight. Without re-checking here, execution carries on: createPeer
        // builds a brand new RTCPeerConnection and addTrack()s onto it AFTER
        // the call is already over, and nothing ever calls releaseMedia()
        // again for it — the callActive effect that drives teardown already
        // fired once, on the PREVIOUS transition to false, and won't fire
        // again until callActive goes true. The result is an orphaned
        // RTCPeerConnection holding the camera/mic open with no call on
        // screen — indistinguishable from "the green camera indicator never
        // turns off after a video call".
        if (mediaCancelledRef.current) {
          (stream.getTracks() as MediaTrackHandle[]).forEach(releaseTrack);
          return;
        }
        // Same duplicate protection as create-answer — a replayed
        // create-offer would otherwise build a second offer over a
        // connection that is already negotiating.
        if (offerCreatedRef.current) {
          post({ type: "log", message: "duplicate create-offer ignored" });
          return;
        }
        offerCreatedRef.current = true;
        isCallerRef.current = true;
        // Reuse the connection start-local already built, if it did. Calling
        // createPeer again here would close it and throw away every
        // candidate it has gathered in the meantime — which is the entire
        // point of pre-creating it. Falls back to building one when
        // start-local ran without iceServers (an older caller, or a path
        // that skips it).
        const pc = pcRef.current ?? createPeer(command.iceServers);
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const created = await pc.createOffer({});
        const offer = { type: created.type, sdp: tuneSdp(created.sdp ?? "", Platform.OS === "ios") };
        await pc.setLocalDescription(offer);
        post({ type: "offer", sdp: offer.sdp });
        return;
      }

      if (command.type === "create-answer") {
        // Refuse a duplicate answer for an SDP this bridge already answered.
        //
        // Measured 2026-09-20 (Bek → Shakha): the callee's trace shows TWO
        // "local answer created" entries 74ms apart, i.e. create-answer ran
        // twice for one call. The second run calls createPeer(), which
        // closes the first connection — but the media tracks and the audio
        // unit are already bound to that first one. The result is exactly
        // one second of working audio followed by silence, on a call that
        // otherwise reports connected with a healthy relay pair.
        //
        // The duplicate reaches here through sendCommand's replay queue:
        // commands issued while the bridge was still mounting are queued AND
        // the same command can be delivered directly once bridgeRef appears,
        // so both copies arrive. Deduplicating on the offer SDP is the
        // narrow fix — a genuine renegotiation carries different SDP and
        // goes through "renegotiate-answer" anyway, never through here.
        if (answeredSdpRef.current === command.sdp) {
          post({ type: "log", message: "duplicate create-answer ignored" });
          return;
        }
        answeredSdpRef.current = command.sdp;
        const webrtc = getWebRtc();
        if (!webrtc) return;
        isCallerRef.current = false;

        // Build the connection and apply the remote offer BEFORE awaiting
        // the camera, not after.
        //
        // Same measurement as start-local's: the callee in the failed
        // 18:22 call on 2026-09-19 gathered its first candidate only at
        // 5536ms, because this branch used to open with
        // `await getMedia(...)` — the CallKit audio-session wait (up to
        // 1500ms) plus getUserMedia ran to completion before
        // setRemoteDescription, and ICE cannot begin gathering until the
        // remote description exists. Applying the offer first lets STUN/TURN
        // probing run concurrently with the camera starting.
        //
        // Unlike the caller, the callee cannot pre-create its connection in
        // start-local: createPeer here needs command.iceServers and the
        // connection has to be built around this specific remote offer.
        const pc = createPeer(command.iceServers);
        await pc.setRemoteDescription(
          new webrtc.RTCSessionDescription({ type: "offer", sdp: command.sdp })
        );
        await flushCandidates(pc);

        const stream = await getMedia(!!command.video);
        // Same guard as create-offer above, and for the same reason. Also
        // re-checked because the connection now exists before the media
        // does: a hangup landing in that window must not leave it open.
        if (mediaCancelledRef.current) {
          (stream.getTracks() as MediaTrackHandle[]).forEach(releaseTrack);
          return;
        }
        // Still the same connection? A hangup/teardown during the await
        // above replaces or clears pcRef, and adding tracks to a discarded
        // connection would strand the camera with no call on screen.
        if (pcRef.current !== pc) {
          (stream.getTracks() as MediaTrackHandle[]).forEach(releaseTrack);
          return;
        }
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const created = await pc.createAnswer();
        const answer = { type: created.type, sdp: tuneSdp(created.sdp ?? "", Platform.OS === "ios") };
        await pc.setLocalDescription(answer);
        post({ type: "answer", sdp: answer.sdp });
        return;
      }

      if (command.type === "renegotiate-answer") {
        const pc = pcRef.current;
        const webrtc = getWebRtc();
        if (!pc || !webrtc) return;
        // No getMedia() and no createPeer(): the tracks are already attached
        // and flowing (or at least negotiated) on this connection. Calling
        // either would re-prompt for the mic and drop the call's existing
        // media path — the whole reason this is separate from create-answer.
        await pc.setRemoteDescription(
          new webrtc.RTCSessionDescription({ type: "offer", sdp: command.sdp })
        );
        const created = await pc.createAnswer();
        const answer = { type: created.type, sdp: tuneSdp(created.sdp ?? "", Platform.OS === "ios") };
        await pc.setLocalDescription(answer);
        post({ type: "answer", sdp: answer.sdp });
        // Same reasoning as the caller's restart-ice branch: arm the
        // watchdog here so the callee also observes whether the restarted
        // connection actually carries media. Generation-guarded, so this
        // supersedes rather than races any loop already running.
        void watchForInboundMedia(pc);
        return;
      }

      if (command.type === "prepare-peer") {
        if (!pcRef.current) {
          isCallerRef.current = true;
          createPeer(command.iceServers);
        }
        return;
      }

      if (command.type === "set-ice-servers") {
        const pc = pcRef.current;
        if (!pc || !peerConfigRef.current) return;
        const config = { ...peerConfigRef.current, iceServers: command.iceServers };
        try {
          pc.setConfiguration(config);
          peerConfigRef.current = config;
        } catch (error) {
          post({ type: "log", message: `set-ice-servers failed: ${String(error)}` });
        }
        return;
      }

      if (command.type === "restart-ice") {
        // A restart re-gathers from scratch, so the zero-relay diagnostic
        // must count THIS round, not carry the original round's total
        // forward and mask a restart that genuinely got no relay.
        relayCandidateCountRef.current = 0;
        const pc = pcRef.current;
        if (!pc) return;
        // Deliberately NOT createPeer(): that closes the current connection
        // and builds a new one, which would drop the already-negotiated
        // tracks and force the whole call to start over. iceRestart only
        // re-gathers candidates on the connection that already exists, so
        // the media pipeline stays intact and only the network path is
        // renegotiated — which is the entire point, since the tracks were
        // never the problem, the dead relay was.
        const created = await pc.createOffer({ iceRestart: true });
        const offer = { type: created.type, sdp: tuneSdp(created.sdp ?? "", Platform.OS === "ios") };
        await pc.setLocalDescription(offer);
        post({ type: "offer", sdp: offer.sdp ?? "" });
        // Re-arm the watchdog explicitly rather than relying on
        // onconnectionstatechange: a restart that finds a new pair quickly
        // can stay in "connected" throughout, so that handler may never
        // re-fire and the restart's outcome would go unobserved. Safe to
        // start unconditionally because watchForInboundMedia is
        // generation-guarded — this supersedes any loop still running.
        void watchForInboundMedia(pc);
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
          // MUST come from the module, not a global: react-native-webrtc only
          // installs globals via registerGlobals(), which this app never
          // calls. A bare `new RTCIceCandidate(...)` threw a ReferenceError
          // straight into the catch below, so every trickled candidate that
          // arrived after the remote description was silently discarded — the
          // reason calls would ring, "connect", and then carry no media.
          await pc.addIceCandidate(new webrtc.RTCIceCandidate(command.candidate));
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

      if (command.type === "switch-camera") {
        // Track which way the camera faces so the preview can stop mirroring.
        setUsingFrontCamera((previous) => !previous);
        // Flips between the front and rear camera mid-call. _switchCamera is
        // react-native-webrtc's own helper: it swaps the capture device on
        // the existing track, so the peer connection and its sender are
        // untouched and no renegotiation is needed.
        localStreamRef.current
          ?.getVideoTracks()
          .forEach((track) => (track as unknown as { _switchCamera?: () => void })._switchCamera?.());
        return;
      }

      if (command.type === "hangup") {
        // Snapshot stats ONE LAST TIME before the connection is torn down.
        //
        // Until now call-stats was only ever posted once, at the first
        // media-flowing/media-timeout check a few seconds into the call —
        // the number call_diagnostics stored was frozen at that instant for
        // the entire rest of the call, however long it ran. A call reported
        // as "connected, audioBytes=2795" from a 4-second-in snapshot could
        // still have gone completely silent at second 5 with nothing in the
        // data to show it — exactly the gap this closes: audioPkts here vs.
        // the earlier snapshot's audioPkts tells whether audio kept flowing
        // for the call's whole duration or died partway through.
        if (pcRef.current) {
          try {
            post(await collectCallStats(pcRef.current, null));
          } catch {
            // Best-effort — never block hanging up on a stats read.
          }
        }
        releaseMedia();
        pendingCandidatesRef.current = [];
        setLocalUrl(null);
        setRemoteUrl(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Not a failure: the call ended while media was still opening, and
      // getMedia deliberately aborted so the stream could be stopped rather
      // than leaked. Reporting it would show a "call failed" error for a
      // call the user themselves just hung up.
      if (message === "call ended before media was ready") return;
      post({ type: "error", message });
    }
  }

  // Resolved at render time rather than imported: in Expo Go there is no
  // native view to render, and the streams stay null anyway.
  const RTCView = getWebRtc()?.RTCView;

  // The container always keeps its real size and stays on screen; only the
  // video surfaces are hidden for an audio call.
  //
  // It used to be collapsed to 1x1 and pushed off-screen for audio calls,
  // which is how "we can't hear each other" happened: audio playback on iOS
  // is driven by the RTCView rendering the remote stream, and a view with no
  // area outside the visible bounds is not reliably rendered at all — so the
  // remote audio track was decoded but never played. Audio must never depend
  // on video layout.
  // 2026-09-26: tapping the corner thumbnail swaps which video is
  // full-screen. This is the one place that has to disagree with the
  // "remote RTCView must always stay full-size for its audio" rule above —
  // the user explicitly asked for peer-in-corner as an option, after being
  // told the risk (the peer's audio is bound to this same view, and
  // shrinking a view that carries live audio is exactly the bug fixed on
  // 2026-09-24). It is being tried deliberately, not by accident: verify
  // audio still survives an actual swap on a real call before trusting this.
  const remoteIsCorner = swapped && peerVideoVisible;
  const localIsCorner = !swapped && peerVideoVisible;

  // 2026-09-26: the swap feature crashed a real call (camera toggle stopped
  // working, then the app crashed outright) when this used to render a
  // DIFFERENT JSX subtree per RTCView depending on corner-vs-full state — a
  // bare <RTCView> in one branch, the same stream wrapped in an
  // <Animated.View><RTCView> in the other. React has no way to know those
  // are "the same" view across a re-render (different element types at the
  // same tree position), so it unmounted and remounted the native RTCView
  // on every swap/geometry change — tearing down and rebuilding the native
  // binding to a LIVE MediaStream. react-native-webrtc is not documented as
  // safe against that, and this is consistent with what was observed: video
  // state corrupted after a toggle, then a native-level crash.
  //
  // Fixed by always rendering exactly ONE persistent RTCView per stream —
  // never remounted — and moving only its wrapping View's style/transform
  // between "corner" and "full" geometry. The element identity (and so the
  // native view instance) never changes, only where it's drawn.
  const remoteBoxStyle = remoteIsCorner
    ? [
        styles.cornerBox,
        cornerAnchorStyle(cornerAnchor),
        cornerHidden ? styles.cornerBoxHidden : null,
        cornerDrag ? { transform: cornerDrag.getTranslateTransform() } : null,
      ]
    : visible
      ? styles.remote
      : styles.remoteAudioOnly;

  // 2026-09-27: swapping to self-full-screen went to a black screen — this
  // fallback used to read `peerVideoVisible ? styles.local : styles.localFull`
  // unconditionally, which is pre-swap logic ("corner if there's a peer,
  // full screen only if there's no call yet"). With swapped=true and a
  // peer video present, localIsCorner is false NOT because there's no
  // peer, but because local is supposed to take over the full screen — yet
  // this still resolved to styles.local, the small FIXED top-right corner
  // box (not full-screen, and not even the draggable corner — that's
  // cornerBox/cornerAnchorStyle). The self video kept rendering pinned
  // to that stale spot while remote had already moved to the real corner
  // box, leaving nothing rendering full-screen at all.
  const localBoxStyle = localIsCorner
    ? [
        styles.cornerBox,
        cornerAnchorStyle(cornerAnchor),
        cornerHidden ? styles.cornerBoxHidden : null,
        cornerDrag ? { transform: cornerDrag.getTranslateTransform() } : null,
      ]
    : swapped
      ? styles.localFull
      : peerVideoVisible
        ? styles.local
        : styles.localFull;

  return (
    <View
      style={visible ? styles.visible : styles.audioOnly}
      pointerEvents="none"
    >
      {/* 2026-09-29: zOrder is react-native-webrtc's OWN native z-stack —
          separate from, and not governed by, React Native's usual
          later-sibling-paints-on-top rule. It used to be hardcoded
          local=1/remote=(implicit 0), which was only ever correct for the
          UN-swapped layout (local small in a corner ON TOP of remote
          full-screen). After a swap, local becomes full-screen and remote
          moves into the corner — but local kept the higher zOrder, so
          local's full-screen surface kept painting OVER remote's corner
          box even though remote's corner sits geometrically inside local's
          full-screen area. That's the "tap self to go full-screen and the
          peer's corner thumbnail vanishes" bug: it was there the whole
          time, just fully hidden behind local. Whichever side is
          CURRENTLY in the corner needs the higher zOrder now, so it always
          paints above whichever side is full-screen underneath it. */}
      {RTCView && remoteUrl ? (
        <Animated.View style={remoteBoxStyle}>
          <RTCView
            streamURL={remoteUrl}
            style={styles.fill}
            objectFit="cover"
            zOrder={remoteIsCorner ? 1 : 0}
          />
        </Animated.View>
      ) : null}
      {RTCView && localUrl && visible ? (
        <Animated.View style={localBoxStyle}>
          <RTCView
            streamURL={localUrl}
            style={styles.fill}
            objectFit="cover"
            zOrder={localIsCorner ? 1 : 0}
            // Only the front camera is mirrored. Mirroring is what makes a
            // self-view feel like a mirror, but applying it to the REAR
            // camera flips the world horizontally — text reads backwards and
            // anything pointed at appears on the wrong side.
            mirror={usingFrontCamera}
          />
        </Animated.View>
      ) : null}
    </View>
  );
});

function cornerAnchorStyle(anchor: "top-right" | "top-left" | "bottom-right" | "bottom-left") {
  switch (anchor) {
    case "top-left":
      return { top: 60, left: 16 };
    case "bottom-right":
      return { bottom: 100, right: 16 };
    case "bottom-left":
      return { bottom: 100, left: 16 };
    case "top-right":
    default:
      return { top: 60, right: 16 };
  }
}

const styles = StyleSheet.create({
  visible: StyleSheet.absoluteFillObject,
  // Audio-only: on screen and full size (so the remote RTCView renders and
  // its audio actually plays), but fully transparent and behind everything,
  // so it neither covers the call UI nor takes touches.
  audioOnly: { ...StyleSheet.absoluteFillObject, opacity: 0, zIndex: -1 },
  // The remote surface still needs real dimensions in an audio call — a
  // zero-area view is not rendered, and on iOS that silences its audio.
  remoteAudioOnly: { ...StyleSheet.absoluteFillObject, opacity: 0 },
  remote: { ...StyleSheet.absoluteFillObject },
  local: {
    position: "absolute",
    right: 16,
    top: 60,
    width: 100,
    height: 150,
    borderRadius: 12,
    overflow: "hidden",
  },
  // Pre-connection: the user's own camera fills the screen.
  localFull: { ...StyleSheet.absoluteFillObject },
  fill: { width: "100%", height: "100%" },
  // Base geometry for the draggable/swappable corner box — position (top/
  // left/right/bottom) is added per-anchor by cornerAnchorStyle, and drag
  // offset by the cornerDrag transform, both applied where this is used.
  cornerBox: {
    position: "absolute",
    width: 100,
    height: 150,
    borderRadius: 12,
    overflow: "hidden",
  },
  // Hides the box visually without unmounting it — the stream underneath
  // keeps flowing (this is cosmetic only, see cornerHidden's own doc
  // comment), and pointerEvents keeps a hidden box from eating touches meant
  // for whatever's now behind it.
  cornerBoxHidden: { opacity: 0 },
});
