import { isCallKitAudioSessionActive, onCallKitAudioSessionActivated } from "expo-callkit";
import { setAudioModeAsync } from "expo-audio";
import {
  configureForVoiceCall,
  enableWebRtcAudio,
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
let awaitingCallKitAudioSession = false;
export function markNextCallAsAnsweredViaCallKit(): void {
  awaitingCallKitAudioSession = true;
}

/** Clears the flag without waiting on it. Every path that ends a call calls
 * this, because the flag can be armed more than once for a single answer —
 * the onAnswerCall event and the consumeAnsweredCall check both set it, and
 * only one getMedia consumes it. The survivor then applied to the NEXT call:
 * an ordinary outgoing audio call would stall 1.5s waiting for a CallKit
 * audio-session activation that was never coming for it, and open the mic
 * only after WebRTC had already begun negotiating. */
export function clearCallKitAudioSessionWait(): void {
  awaitingCallKitAudioSession = false;
}

/** Resolves once CallKit has activated the audio session, or after a short
 * timeout — a call not actually reported to CallKit (this build predates
 * the module, or CallKit itself never fires the callback) must not hang the
 * mic open forever waiting for an event that will never come. */
function waitForCallKitAudioSession(): Promise<boolean> {
  if (!awaitingCallKitAudioSession) return Promise.resolve(false);
  awaitingCallKitAudioSession = false;

  // Check STATE first, not just the event. onAudioSessionActivated fires
  // exactly once, at the moment CallKit's didActivate runs natively — which
  // happens independently of, and often BEFORE, JS getting around to
  // subscribing here (onAnswerCall has to reach JS, flow through React
  // state, and reach acquireMedia first). When didActivate had already fired
  // by the time this function's subscription below was set up, the event was
  // gone for good and this fell through to the 1500ms timeout believing
  // CallKit was never involved — the intermittent "answer from CallKit,
  // connects, total silence" bug. isCallKitAudioSessionActive() reads a
  // flag set directly in didActivate/cleared in didDeactivate, so it reports
  // the CURRENT state rather than "was there an event I happened to catch".
  if (isCallKitAudioSessionActive()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    // The two outcomes are NOT the same and must not both resolve true.
    // Resolving true on the timeout told the caller "CallKit owns the audio
    // session", so it skipped setAudioModeAsync, skipped configureForVoiceCall
    // AND skipped enableWebRtcAudio(true) — and with useManualAudio=true
    // nothing else ever enables the audio unit. The call then connected with
    // no audio in either direction, which is exactly the case this timeout
    // exists to rescue.
    const settle = (activated: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.remove();
      resolve(activated);
    };
    const subscription = onCallKitAudioSessionActivated(() => settle(true));
    const timer = setTimeout(() => settle(false), 1500);
  });
}

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
  | { type: "start-local"; video?: boolean }
  | { type: "create-offer"; iceServers: RTCIceServer[]; video?: boolean }
  | { type: "create-answer"; iceServers: RTCIceServer[]; sdp: string; video?: boolean }
  | { type: "accept-answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }
  | { type: "set-mic"; enabled: boolean }
  | { type: "set-camera"; enabled: boolean }
  | { type: "switch-camera" }
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
    return () => {
      releaseMediaRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    send(command: object) {
      void handleCommand(command as Command);
    },
  }));

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
    if (localStreamRef.current) return Promise.resolve(localStreamRef.current);
    if (mediaPromiseRef.current) return mediaPromiseRef.current;
    const pending = acquireMedia(video).finally(() => {
      mediaPromiseRef.current = null;
    });
    mediaPromiseRef.current = pending;
    return pending;
  }

  async function acquireMedia(video: boolean) {
    if (localStreamRef.current) return localStreamRef.current;

    // If this call was answered from CallKit's UI, let CallKit finish
    // activating the shared session first — see waitForCallKitAudioSession.
    // The return value says whether this actually IS a CallKit-answered
    // call, which changes who owns the session below.
    const callKitOwnsSession = await waitForCallKitAudioSession();
    // Tell the native speaker module too — setSpeakerphoneOn (called from
    // useCall's local-ready handler, right after this resolves) needs this
    // to avoid the exact same mistake configureForVoiceCall was just guarded
    // against below: an unconditional setCategory call rebuilds the route
    // CallKit just finished activating, even when the desired speaker state
    // already matches what CallKit set. Cleared in releaseMedia once the
    // call ends, so it never leaks into the next call.
    setCallKitOwnsSession(callKitOwnsSession);

    // Put iOS into a two-way call audio session BEFORE opening the mic.
    // Nothing did this before: the only audio-mode call in the app was the
    // ringtone's (playsInSilentMode), which leaves the session in a
    // playback-only category. A WebRTC call then negotiates fine and shows
    // "Connected" while neither side can hear anything. allowsRecording is
    // what switches the category to playAndRecord.
    //
    // Skipped entirely for a CallKit-answered call. CallKit has already
    // configured AND activated the shared session by this point, and
    // expo-audio's setAudioModeAsync re-sets the category — which tears down
    // and rebuilds the audio route underneath the session CallKit just
    // handed over. That is the "Connected, own video showing, no peer audio"
    // symptom: the route the call's audio unit was about to attach to no
    // longer exists.
    if (!callKitOwnsSession) {
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
    }

    // Declare the voiceChat session BEFORE opening the mic — but ONLY when
    // this device, not CallKit, owns the session. configureForVoiceCall
    // calls AVAudioSession.setCategory natively, and a category change tears
    // down and rebuilds the current audio route. For a call answered from
    // CallKit's own UI, CallKit has ALREADY set the category and activated
    // the route (in its CXAnswerCallAction handler, before this JS was even
    // running) — calling this again immediately after rebuilds that route
    // out from under it. That is exactly the reported symptom: CallKit
    // answers, negotiation succeeds, and neither side hears anything,
    // because the route WebRTC is about to attach to no longer exists by
    // the time it opens the mic. Skipping this here is the missing half of
    // what callKitOwnsSession was already computed for — the expo-audio call
    // below was guarded the same way, but this native call was not.
    if (!callKitOwnsSession) {
      configureForVoiceCall();
    }

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
    if (!callKitOwnsSession) {
      enableWebRtcAudio(true);
    }

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
  async function watchForInboundMedia(pc: RTCPeerConnectionType) {
    const deadline = Date.now() + 8000;
    let lastBytes = -1;
    while (Date.now() < deadline) {
      if (mediaCancelledRef.current || pcRef.current !== pc) return;
      try {
        const report = await pc.getStats();
        let bytes = 0;
        report.forEach((stat: { type: string; kind?: string; bytesReceived?: number }) => {
          if (stat.type === "inbound-rtp" && typeof stat.bytesReceived === "number") {
            bytes += stat.bytesReceived;
          }
        });
        if (lastBytes >= 0 && bytes > lastBytes) {
          post({ type: "media-flowing" });
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
    if (!mediaCancelledRef.current && pcRef.current === pc) {
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
            // 600 kbit/s, not the 1.2 Mbit/s this started at. A typical
            // mobile UPLINK outdoors is well under 2 Mbit/s and fluctuates;
            // letting video reach for more than a third of that means the
            // encoder repeatedly overshoots, the link saturates, and audio
            // — sharing the same path — breaks up. Capping low keeps the
            // picture honest and the speech intact, which is the right
            // trade for a call.
            encoding.priority = "low";
            encoding.networkPriority = "low";
            encoding.maxBitrate = 600_000;
            // Prefers dropping frame rate over resolution when the link
            // tightens — a sharp, slightly choppy picture reads better than
            // a smooth blurry one for a talking head.
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
      // Gathers a few candidates before the offer is even created, so the
      // first ICE exchange already has routes to try instead of trickling
      // them in afterwards — noticeably faster pickup on mobile networks.
      iceCandidatePoolSize: 4,
      // Lets ICE re-pick a working route mid-call (e.g. Wi-Fi to cellular
      // handover) rather than dropping the call when the current path dies.
      iceTransportPolicy: "all",
    });

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
      if (!stream) return;
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
      try {
        (stream as unknown as { getAudioTracks?: () => { _setVolume?: (v: number) => void }[] })
          .getAudioTracks?.()
          .forEach((track) => track._setVolume?.(2.5));
      } catch {
        // Older react-native-webrtc without _setVolume — call still works at
        // the default level.
      }
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
        void tuneForMobileNetwork(pc);
        void watchForInboundMedia(pc);
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
    if (mediaCancelledRef.current && command.type !== "hangup") return;
    try {
      if (command.type === "start-local") {
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
        const pc = createPeer(command.iceServers);
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        post({ type: "offer", sdp: offer.sdp ?? "" });
        return;
      }

      if (command.type === "create-answer") {
        const stream = await getMedia(!!command.video);
        // Same guard as create-offer above, and for the same reason.
        if (mediaCancelledRef.current) {
          (stream.getTracks() as MediaTrackHandle[]).forEach(releaseTrack);
          return;
        }
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
