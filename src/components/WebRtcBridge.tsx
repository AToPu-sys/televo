import { setAudioModeAsync } from "expo-audio";
import {
  audioRouteSnapshot,
  configureForVoiceCall,
  enableWebRtcAudio,
  forceRepairAudioRoute,
  isWebRtcAudioEnabled,
  setCallKitOwnsSession,
} from "expo-speaker-toggle";
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
      selectedCandidatePair: string | null;
      turnServer: string | null;
      msToMedia: number | null;
      bytesReceived: number | null;
      packetsLost: number | null;
      jitterMs: number | null;
    }
  | { type: "log"; message: string }
  | { type: "error"; message: string };

export type WebRtcBridgeHandle = {
  send: (command: object) => void;
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

/** Gain applied to the peer's decoded audio (1.0 = unchanged, max 10).
 *
 * iOS levels a voice-processing session conservatively and no route setting
 * raises the far end's actual signal, so calls read as too quiet even on the
 * loudspeaker. 3.0 is a clear, comfortable lift; the voice-processing unit's
 * own limiter still sits after this stage, so it cannot distort or feed back
 * into the mic. */
const REMOTE_AUDIO_GAIN = 2.5;

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
  { onEvent, visible, peerVideoVisible, callActive },
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
  // Drives keepAudioAlive — see its comment. Generation invalidates a
  // running loop; the timer handle lets teardown stop it immediately.
  const audioWatchGenerationRef = useRef(0);
  const audioWatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Drives periodicallyRefreshStats — same invalidation pattern as
   * mediaWatchGenerationRef, kept separate because this loop outlives the
   * one-shot media-flowing check that starts it. */
  const statsRefreshGenerationRef = useRef(0);
  /** One route repair per call — see keepAudioAlive. */
  const audioRouteRepairedRef = useRef(false);
  /** Mirrors the callActive prop for the unmount cleanup, which closes over
   * the first render's value and would otherwise always read false. */
  const callActiveRef = useRef(false);
  /** Mirrors `visible` (this call carries video) for the audio watchdog.
   *
   * keepAudioAlive's tick re-arms itself with setTimeout and closes over the
   * render in which the watchdog STARTED, so reading the prop directly froze
   * whatever value was current at that instant for the rest of the call. */
  const isVideoCallRef = useRef(false);
  isVideoCallRef.current = visible;
  /** The peer's incoming stream, so gain can be re-asserted after a
   * renegotiation replaces the decoded track object. */
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
      // Re-run the audio session setup even when the STREAM is reused.
      //
      // acquireMedia's own early return (`if (localStreamRef.current) return
      // localStreamRef.current;`) skips setAudioModeAsync,
      // configureForVoiceCall, enableWebRtcAudio(true) and the local-ready
      // event — every one of those lives AFTER that early return. That is
      // correct for the same-call case this exists for (create-offer
      // reusing what start-local already opened) since the session was just
      // configured a moment earlier in the same call.
      //
      // It is wrong across two DIFFERENT calls. If releaseMedia's teardown
      // from a previous call hasn't finished by the time the next call's
      // getMedia runs — a real race on two calls placed back to back — the
      // new call silently inherits whatever audio session state the old one
      // left behind, with none of its own setup ever running. Measured
      // 2026-09-21: a caller who placed two calls 18s apart got audioPkts=2
      // on the first and 21 on the second (vs. 69-71 on the callee's side of
      // the SAME calls), and neither trace shows "local media open" at all
      // — the exact signature of this branch being taken with a stream that
      // predates the current call.
      //
      // enableWebRtcAudio/setAudioModeAsync/configureForVoiceCall are all
      // idempotent, so re-running them costs nothing when the stream really
      // is fresh from this same call.
      // Explicit marker — makes the reused-stream path a DIRECT fact in the
      // trace instead of something inferred from "local media open" being
      // missing. Names which cross-call race this was (see the long
      // comment above) rather than requiring it be re-diagnosed each time.
      post({
        type: "log",
        message: "getMedia: reusing stream from a previous call — re-applying audio session",
      });
      reapplyAudioSessionForReusedStream();
      return Promise.resolve(localStreamRef.current);
    }
    if (mediaPromiseRef.current) return mediaPromiseRef.current;
    const pending = acquireMedia(video).finally(() => {
      mediaPromiseRef.current = null;
    });
    mediaPromiseRef.current = pending;
    return pending;
  }

  /** Repeats the SESSION half of acquireMedia's setup — not getUserMedia,
   * since the stream is reused — for the cross-call race getMedia's comment
   * explains. Idempotent, so this is safe even on a call where the stream
   * genuinely IS still current and this ends up being a harmless repeat. */
  function reapplyAudioSessionForReusedStream() {
    void setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
      shouldRouteThroughEarpiece: false,
    }).catch(() => {
      // Non-fatal on its own; the call may still route audio correctly.
    });
    configureForVoiceCall();
    enableWebRtcAudio(true);
    if (localStreamRef.current) {
      setLocalUrl(localStreamRef.current.toURL());
    }
    post({ type: "local-ready" });
  }

  async function acquireMedia(video: boolean) {
    if (localStreamRef.current) return localStreamRef.current;

    // REVERTED 2026-09-20 along with useManualAudio.
    //
    // This used to branch on "did CallKit already activate the session for
    // this call" (callKitOwnsSession) and SKIP setAudioModeAsync/
    // configureForVoiceCall when it had, on the theory that CallKit's own
    // manual handover (CallKitDelegate.didActivate) had already set up the
    // route and re-configuring here would tear it down.
    //
    // That theory no longer applies: CallKitDelegate.didActivate no longer
    // does a manual RTCAudioSession handover (see its own comment). With
    // useManualAudio = false, RTCAudioSession activates itself the moment a
    // track needs it, and CallKit's didActivate is now just bookkeeping.
    // Nothing external configures the category/route on this device's
    // behalf anymore, so skipping the configuration here — for EVERY call,
    // not just CallKit-answered ones — would leave a real gap. Both calls
    // now always run.
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
        shouldPlayInBackground: true,
        interruptionMode: "doNotMix",
        shouldRouteThroughEarpiece: false,
      });
    } catch {
      // Non-fatal on its own; the call may still route audio correctly.
    }
    configureForVoiceCall();

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
      // accept video fields (see its Constraints.d.ts), so echoCancellation
      // / noiseSuppression / autoGainControl cannot be requested here — they
      // come from the AVAudioSession mode instead, which
      // configureForVoiceCall and setSpeakerphoneOn set to .voiceChat or
      // .videoChat. Both engage iOS's voice-processing I/O unit, which is
      // what actually provides echo cancellation and automatic gain.
      audio: true,
      // Ranges, not fixed values. Without constraints react-native-webrtc
      // negotiates something very conservative (often 320x240) that looks
      // soft on a phone screen — but pinning 720p/30 is the opposite
      // mistake: the capture device is then locked to that size regardless
      // of the network, and congestion control can only throw frames away.
      // Giving min/ideal/max lets the encoder actually scale down outdoors
      // on mobile data and back up on wifi.
      // 960x540/30fps, revised 2026-09-20 after measurement.
      //
      // This was briefly dropped to 640x480/24 while call reliability was
      // still unproven. It since was: real calls now connect in ~540ms and
      // carry 15-34KB of inbound media over both direct and relay paths
      // (call_diagnostics, 09:40-09:42 UTC that day), so the bandwidth
      // headroom that reduction bought is no longer needed and only costs
      // picture quality. 540p keeps a visibly sharper image than 480p while
      // still asking far less of the link than the original 720p/30, whose
      // ~900kbit/s demand at the first frame was genuinely too much on weak
      // mobile signal. min/ideal/max still lets the encoder scale down
      // outdoors and up on wifi — this only sets where negotiation starts.
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

    localStreamRef.current = stream as MediaStream;

    // WebRTC runs with useManualAudio = true so it can never seize the
    // session CallKit hands over. For a CallKit call, CallKit's didActivate
    // enables audio natively. For every OTHER call — outgoing, or answered
    // inside the app — nothing else will, so it has to happen here or the
    // call connects silent.
    // UNCONDITIONAL, deliberately — this is the one that must never be
    // skipped.
    //
    // Before 2026-09-18 (aae427d, "rewrite CallKit") WebRTC ran with
    // useManualAudio = NO: its own audio device module activated the
    // session whenever a track started, so a call was audible no matter
    // what the rest of the app did. Calls from that period ran 128-153
    // seconds on average (calls table, 09-12/09-13) — real conversations.
    // After the rewrite, useManualAudio = YES means WebRTC NEVER enables
    // audio by itself, and this call became the only thing that does it for
    // outgoing and in-app-answered calls — gated behind callKitOwnsSession.
    //
    // Every way that gate can be wrong produces a silent call: a leftover
    // arm from a previous answer, a CallKit didActivate that never arrives
    // for a call CallKit was not told about, or a stale native
    // audioSessionActive flag. Average call length fell to 13-21 seconds.
    //
    // Enabling unconditionally costs nothing when CallKit genuinely owns
    // the session: enableWebRtcAudio is idempotent (it sets isAudioEnabled
    // and calls setActive(true), both no-ops on an already-active session),
    // and the two calls this used to guard — setAudioModeAsync and
    // configureForVoiceCall — are the ones that actually rebuild the audio
    // ROUTE and must still be skipped for CallKit. Those stay guarded
    // above. This one only turns the unit on.
    enableWebRtcAudio(true);

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
    // Stop the audio watchdog, or it re-enables the audio unit after the
    // call is over and holds the recording indicator on.
    audioWatchGenerationRef.current += 1;
    statsRefreshGenerationRef.current += 1;
    audioRouteRepairedRef.current = false;
    answeredSdpRef.current = null;
    remoteStreamRef.current = null;
    offerCreatedRef.current = false;
    if (audioWatchTimerRef.current) {
      clearTimeout(audioWatchTimerRef.current);
      audioWatchTimerRef.current = null;
    }
    // Leaving WebRTC's audio unit enabled keeps the session live after the
    // call, which holds the recording indicator on and wedges the unit for
    // the next call. CallKit calls also pass through here; its didDeactivate
    // disables audio too, and doing it twice is harmless.
    enableWebRtcAudio(false);
    // Every call ends up here regardless of how it started, so this is the
    // one place guaranteed to run before the NEXT call's getMedia — without
    // it, a CallKit-answered call would leave callKitOwnsSession stuck true
    // and silently suppress a later, ordinary outgoing call's own speaker
    // route changes.
    setCallKitOwnsSession(false);
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

    // Stopping tracks alone doesn't drop iOS's playAndRecord session, and the
    // OS keeps the recording indicator lit while that session is active.
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
    // 2s rather than a flat 5s: measured 2026-09-21, several real calls
    // lasted only 11-14s total — media-flowing fired around the 7-10s mark,
    // and the user hung up 2-4s later. A 5s interval never got a second
    // sample in before the call ended, so the "how did audio behave for the
    // REST of the call" question this exists to answer went right back to
    // being unanswerable for exactly the short calls where it matters most
    // (a call someone hangs up quickly because they can't hear anything IS
    // the symptom). Cheap enough to run this often — getStats() is a local
    // read, not a network call.
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (statsRefreshGenerationRef.current !== generation) return;
      if (pcRef.current !== pc) return;
      const state = pc.connectionState;
      if (state === "closed" || state === "failed") return;
      try {
        post(await collectCallStats(pc, null));
      } catch {
        return;
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
      let jitter: number | null = null;
      let audioBytes = 0;
      let audioPackets = 0;
      let outboundAudioBytes = 0;
      let outboundAudioPackets = 0;
      byId.forEach((stat) => {
        if (stat.type === "inbound-rtp") {
          if (typeof stat.bytesReceived === "number") bytes += stat.bytesReceived;
          if (typeof stat.packetsLost === "number") lost += stat.packetsLost;
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
        // Only a relay candidate carries a meaningful server address.
        const relay = localType === "relay" ? local : remoteType === "relay" ? remote : undefined;
        if (relay) {
          const address = relay.address ?? relay.ip ?? null;
          const port = relay.port ?? null;
          if (address) result.turnServer = port ? `${address}:${port}` : String(address);
        }
      }
    } catch {
      // Stats are diagnostics, never a reason to disturb a live call.
    }
    return result;
  }

  /**
   * Keeps audio ON for the whole call, repairing it automatically.
   *
   * Enabling audio once is not enough. With useManualAudio = true (added
   * 2026-09-18 alongside CallKit) WebRTC never enables its own audio unit,
   * so anything that switches it off mid-call is permanent: an interruption
   * from a real phone call, a Bluetooth device connecting, a CallKit
   * didDeactivate for a session it hands back while the call is still up,
   * or an enableWebRtcAudio(true) whose setActive() threw because another
   * call held the session at that instant.
   *
   * Every one of those leaves a call that is fully connected — video
   * visible, RTP flowing, getStats healthy — and completely silent, which
   * is the failure the calls table shows as average duration collapsing
   * from 128-153s (09-12/09-13) to 13-21s (09-18/09-19).
   *
   * Rather than add another place that must get the decision right, this
   * polls the ACTUAL native state twice a second and re-asserts audio the
   * moment it reads false. enableWebRtcAudio is idempotent, so a healthy
   * call pays one cheap native read per tick and nothing else.
   *
   * Generation-guarded like watchForInboundMedia, and stops on teardown or
   * when the connection is replaced.
   */
  /** Disabled 2026-09-20 along with useManualAudio.
   *
   * This polled the native module and re-asserted the audio unit / route /
   * gain on a timer. It only existed because useManualAudio = true made
   * WebRTC refuse to manage its own audio, so something had to notice when
   * the unit was off. With manual audio reverted, WebRTC activates the
   * session itself and there is nothing for a watchdog to repair — polling
   * native every tick was pure overhead (and a source of stutter) on every
   * call.
   *
   * Kept as a no-op rather than deleted so the single call site and the
   * generation/timer refs stay intact; re-enabling is a matter of restoring
   * this body if manual audio is ever tried again. */
  function keepAudioAlive(_pc: RTCPeerConnectionType) {
    return;
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
          // Safety net: real RTP is arriving, so this call is unambiguously
          // live — make sure WebRTC's audio unit is actually on, whatever
          // the earlier callKitOwnsSession decision concluded. With
          // useManualAudio = true, a wrong guess there (CallKit's
          // audioSessionActive flag left stale by a hangup that never
          // produced a didDeactivate — see CallKitStore.forgetInMemory)
          // means nobody ever enables audio and the call is silent despite
          // a perfect connection. enableWebRtcAudio(true) is idempotent, so
          // re-asserting it on the one event that proves media is flowing
          // costs nothing and closes that whole class of failure.
          enableWebRtcAudio(true);
          // From here the call is proven live — keep audio on for its
          // whole duration, not just this instant.
          keepAudioAlive(pc);
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
            encoding.maxBitrate = 900_000;
            // Prefers dropping RESOLUTION over frame rate when the link
            // tightens — was "maintain-resolution" (drop frame rate
            // instead), which is backwards for a long/international relay
            // path: a blurrier but smooth, unfrozen picture reads as "call
            // is working" where a sharp-but-choppy one reads as "call is
            // breaking up," and smoothness is also what keeps audio (bundled
            // on the same transport) from getting starved by video retries.
            encoding.degradationPreference = "maintain-resolution";
          }
        }

        await sender.setParameters(params);
      }
    } catch {
      // Any failure here leaves WebRTC's own defaults in place; the call
      // still works, just without the audio-first bias.
    }
  }

  releaseMediaRef.current = releaseMedia;

  /** The peer's stream, kept so the audio watchdog can re-assert gain. */
  const remoteStreamRefLocal = remoteStreamRef;

  /** Re-applies the incoming-voice gain.
   *
   * Called from ontrack AND from the audio watchdog every 500ms. Once was
   * not enough: _setVolume lives on the decoded track object, and that
   * object is replaced whenever the transceiver re-negotiates (an ICE
   * restart, a route change, iOS rebuilding the audio unit). The new track
   * arrives at the library default of 1.0, so a call that started at the
   * boosted level silently dropped back to the quiet one partway through —
   * matching the report of audio that is audible for the first seconds and
   * then effectively inaudible.
   *
   * Idempotent and cheap: setting the same value on an unchanged track is a
   * no-op in react-native-webrtc. */
  function applyRemoteGain() {
    try {
      const stream = remoteStreamRefLocal.current as unknown as {
        getAudioTracks?: () => { _setVolume?: (v: number) => void }[];
      } | null;
      stream?.getAudioTracks?.().forEach((track) => track._setVolume?.(REMOTE_AUDIO_GAIN));
    } catch {
      // Older react-native-webrtc without _setVolume — the call still works
      // at the default level.
    }
  }

  function createPeer(iceServers: RTCIceServer[]) {
    const webrtc = getWebRtc();
    if (!webrtc) throw new Error("Calls need a development build.");
    // Close any previous connection first. Without this, a renegotiation or a
    // duplicated answer leaves the old peer connection alive and holding the
    // mic, while candidates for the new one are applied to a connection
    // nobody reads.
    pcRef.current?.close();
    const pc = new webrtc.RTCPeerConnection({
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
      iceTransportPolicy: "all",
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
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

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

      // Amplify the incoming voice. Routing and session mode alone left
      // calls noticeably quiet: iOS levels a voice-processing session
      // conservatively, and there is no route setting that raises the far
      // end's actual signal. _setVolume is react-native-webrtc's own gain
      // control on the decoded track (1.0 = unchanged, up to 10).
      //
      // 2.5 roughly doubles perceived loudness while staying well below the
      // point where a loud speaker clips — the voice-processing unit's
      // limiter still sits after this, so it can't distort into the mic.
      applyRemoteGain();
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

        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        post({ type: "offer", sdp: offer.sdp ?? "" });
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

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        post({ type: "answer", sdp: answer.sdp ?? "" });
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
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        post({ type: "answer", sdp: answer.sdp ?? "" });
        // Same reasoning as the caller's restart-ice branch: arm the
        // watchdog here so the callee also observes whether the restarted
        // connection actually carries media. Generation-guarded, so this
        // supersedes rather than races any loop already running.
        void watchForInboundMedia(pc);
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
        const offer = await pc.createOffer({ iceRestart: true });
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
  return (
    <View
      style={visible ? styles.visible : styles.audioOnly}
      pointerEvents="none"
    >
      {RTCView && remoteUrl ? (
        <RTCView
          streamURL={remoteUrl}
          style={visible ? styles.remote : styles.remoteAudioOnly}
          objectFit="cover"
        />
      ) : null}
      {RTCView && localUrl && visible ? (
        <RTCView
          streamURL={localUrl}
          // Full screen while waiting, corner thumbnail once the peer's
          // video is up. Animating between the two is handled by the
          // overlay; this just picks the target geometry.
          style={peerVideoVisible ? styles.local : styles.localFull}
          objectFit="cover"
          zOrder={1}
          // Only the front camera is mirrored. Mirroring is what makes a
          // self-view feel like a mirror, but applying it to the REAR camera
          // flips the world horizontally — text reads backwards and anything
          // pointed at appears on the wrong side.
          mirror={usingFrontCamera}
        />
      ) : null}
    </View>
  );
});

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
});
