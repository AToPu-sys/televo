import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { Alert, Animated, Easing, Modal, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { BridgeEvent, WebRtcBridgeHandle } from "./WebRtcBridge";
import { WebRtcBridge } from "./WebRtcBridge";
import type { CallState } from "../hooks/useCall";
import { useConnectingTone } from "../hooks/useConnectingTone";
import { useRinger } from "../hooks/useRinger";
import { useTheme } from "../hooks/useTheme";
import { spacing } from "../theme";
import { Avatar } from "./Avatar";
import { CallButton } from "./CallButton";

type CallOverlayProps = {
  state: CallState;
  /** True once WebRtcBridge's getStats() poll has confirmed bytes are
   * actually arriving from the peer — see watchForInboundMedia. `state.phase
   * === "active"` alone only means SDP/ICE/DTLS finished, which a dead TURN
   * relay that accepts the handshake but never forwards RTP satisfies just
   * as well as a real connection. Drives the "Connected" label so it isn't
   * shown while the call is actually silent. */
  mediaConfirmed: boolean;
  peerName: string;
  peerAvatarUrl?: string | null;
  muted: boolean;
  cameraOff: boolean;
  speakerOn: boolean;
  isVideo: boolean;
  onBridgeReady: (handle: WebRtcBridgeHandle | null) => void;
  onBridgeEvent: (event: BridgeEvent) => void;
  onAccept: () => void;
  onDecline: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onToggleSpeaker: () => void;
  onDismissEnded: () => void;
  /** Returns a readable, timestamped trace of this call's handshake so far.
   * There's no way to attach a debugger to a call on a real, unplugged
   * phone, so this is the way to see exactly which step it stalled on. */
  getDiagnosticsReport?: () => string;
};

export function CallOverlay({
  state,
  mediaConfirmed,
  peerName,
  peerAvatarUrl,
  muted,
  cameraOff,
  speakerOn,
  isVideo,
  onBridgeReady,
  onBridgeEvent,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
  onToggleCamera,
  onSwitchCamera,
  onToggleSpeaker,
  onDismissEnded,
  getDiagnosticsReport,
}: CallOverlayProps) {
  const { theme } = useTheme();

  // Silence the ringtone the moment Accept is tapped, rather than waiting for
  // the phase to change. Answering needs a round trip (the offer has to be
  // there, then an answer SDP is generated), and during that gap the phone
  // was still ringing at the user — while the bridge simultaneously switched
  // the iOS audio session to playAndRecord for the mic, which made the
  // still-looping ringtone jump in volume at exactly the wrong moment.
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    if (state.phase !== "incoming") setAnswering(false);
  }, [state.phase]);

  // Duration shown next to "Connected" — starts counting the instant the
  // call actually connects, not when it was answered/dialed, so it reads
  // the same as every other call UI (Phone.app, WhatsApp, Telegram). Reset
  // to null on every phase change so a second call in the same overlay
  // mount doesn't inherit the previous one's elapsed time.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    // Gated on mediaConfirmed too, not just phase — "active" alone can mean
    // a dead TURN relay accepted the handshake with no media flowing, and
    // counting up against that would show a running timer on a call nobody
    // can actually hear.
    if (state.phase !== "active" || !mediaConfirmed) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [state.phase, mediaConfirmed]);

  // Without this, iOS's normal auto-lock timer fires mid-call and dims then
  // locks the screen — reported specifically for video calls, where the
  // screen is the whole point (a voice call still works fine locked, since
  // CallKit/the audio route are unaffected either way, but a video call
  // goes dark on both the local preview and the remote feed). Scoped to
  // exactly "a call is in progress" (not idle/ended) rather than the whole
  // component's lifetime, so it never holds the screen awake outside an
  // actual call.
  useEffect(() => {
    if (state.phase === "idle" || state.phase === "ended") return;
    const tag = "televo-active-call";
    void activateKeepAwakeAsync(tag);
    return () => {
      void deactivateKeepAwake(tag);
    };
  }, [state.phase]);

  // A slow pulse on the avatar while the call is still ringing — the screen
  // was completely static, which reads as frozen rather than "waiting".
  const pulse = useRef(new Animated.Value(0)).current;
  const ringing = state.phase === "incoming" || state.phase === "outgoing";

  useEffect(() => {
    if (!ringing) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1100,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [ringing, pulse]);

  // Controls fade in rather than snapping into place when the call connects.
  const controlsFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(controlsFade, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [state.phase, controlsFade]);

  // Ring (vibrate) while the call is pending — the app was previously
  // completely silent on an incoming call.
  useRinger(
    !answering && (state.phase === "incoming" || state.phase === "outgoing"),
    state.phase === "incoming" ? "incoming" : "outgoing"
  );

  // Soft ticking during the handshake — mirrors statusLabel's own
  // "Connecting…" gate: signaling can finish (phase "active") while a dead
  // TURN relay never actually carries media, and this stays running through
  // that whole window instead of going silent the instant SDP exchange ends.
  useConnectingTone(state.phase === "connecting" || (state.phase === "active" && !mediaConfirmed));

  // Auto-dismiss "ended" after a beat so the reason is visible, then let the
  // caller reset back to idle. Must be an effect, not a call in the render
  // body — otherwise every re-render while phase is "ended" schedules a new
  // competing timer, and a stale one can fire during a subsequent call.
  useEffect(() => {
    if (state.phase !== "ended") return;
    const timer = setTimeout(onDismissEnded, 1500);
    return () => clearTimeout(timer);
  }, [state.phase, onDismissEnded]);

  if (state.phase === "idle") return null;

  const showVideo = isVideo && state.phase === "active";
  // Own camera preview runs from the moment a video call starts, not only
  // once it connects — you should see yourself while it rings, the way every
  // other video caller does. Before the peer's stream arrives the preview
  // fills the screen; when they appear it animates down into the corner.
  const showSelfPreview =
    isVideo && (state.phase === "outgoing" || state.phase === "connecting" || state.phase === "active");

  // The WebView IS the media engine — getUserMedia and RTCPeerConnection run
  // inside it. It therefore has to be mounted and loaded during "incoming"
  // too: previously it only mounted from "connecting" onward, so on the
  // receiving side the mic and camera were never opened at all, and tapping
  // Accept tried to answer with an engine that hadn't loaded yet.
  //
  // It was excluded from "incoming" to dodge an Android issue where a
  // WebView swallows touches meant for views above it despite
  // pointerEvents="none". That's handled instead by keeping it off-screen
  // (1x1, far outside the viewport) until the call is actually connected,
  // so it can load and request permissions without covering the
  // Accept/Decline buttons.

  // A plain View, however high its zIndex, can never render above the iOS
  // software keyboard — the keyboard is a native UIKit layer outside React
  // Native's own view hierarchy. That left an incoming call unanswerable
  // whenever the keyboard was open: it visually sat on top of (or ate the
  // touches meant for) the Accept/Decline buttons. A native Modal renders in
  // its own window above the keyboard, so it always gets touches.
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent>
      <View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: theme.background }]}>
        {/* Mounted for every non-idle phase, INCLUDING "ended". Unmounting
            the instant a call ends looks like it should free the camera, but
            it raced the explicit "hangup" command useCall sends a moment
            later: that arrived at an already-null ref and was queued for a
            bridge that no longer existed, so the camera kept capturing until
            the OS reclaimed it on backgrounding — exactly the "green light
            stays on after the call, goes out when I leave the app" symptom.
            The bridge now outlives the call, releases the devices on hangup,
            and is unmounted only when useCall's auto-reset returns the phase
            to "idle" (the early return above). */}
        <WebRtcBridge
          ref={onBridgeReady}
          onEvent={onBridgeEvent}
          visible={showSelfPreview}
          peerVideoVisible={!!showVideo}
          callActive={state.phase !== "ended"}
        />

        <SafeAreaView style={styles.content} pointerEvents="box-none">
          <View style={styles.header}>
            {!showVideo ? (
              <Animated.View
                style={{
                  transform: [
                    { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
                  ],
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] }),
                }}
              >
                <Avatar name={peerName} uri={peerAvatarUrl} size={120} />
              </Animated.View>
            ) : null}
            <Text style={[styles.name, { color: showVideo ? "#FFFFFF" : theme.text }]}>
              {peerName}
            </Text>
            <Pressable
              onLongPress={() => {
                if (!getDiagnosticsReport) return;
                const report = getDiagnosticsReport();
                Alert.alert("Call diagnostics", report, [
                  { text: "Close", style: "cancel" },
                  { text: "Share", onPress: () => void Share.share({ message: report }) },
                ]);
              }}
              accessibilityRole="button"
              accessibilityLabel="Show call diagnostics"
              hitSlop={12}
            >
              <Text style={[styles.status, { color: showVideo ? "#FFFFFF" : theme.textSecondary }]}>
                {statusLabel(state, elapsedSeconds, mediaConfirmed)}
              </Text>
            </Pressable>
          </View>

          <Animated.View style={[styles.controls, { opacity: controlsFade }]}>
            {state.phase === "incoming" ? (
              <View style={styles.incomingRow}>
                <CallButton icon="close" color={theme.danger} onPress={onDecline} label="Decline" />
                <CallButton
                  icon="call"
                  color={theme.online}
                  onPress={() => {
                    setAnswering(true);
                    onAccept();
                  }}
                  label="Accept"
                />
              </View>
            ) : state.phase === "outgoing" || state.phase === "connecting" || state.phase === "active" ? (
              <View style={styles.activeRow}>
                <CallButton
                  icon={muted ? "mic-off" : "mic"}
                  color={theme.surfaceElevated}
                  iconColor={showVideo ? "#FFFFFF" : theme.text}
                  onPress={onToggleMute}
                  label={muted ? "Unmute" : "Mute"}
                  small
                />
                {isVideo ? (
                  <CallButton
                    icon={cameraOff ? "videocam-off" : "videocam"}
                    color={theme.surfaceElevated}
                    iconColor={showVideo ? "#FFFFFF" : theme.text}
                    onPress={onToggleCamera}
                    label={cameraOff ? "Camera on" : "Camera off"}
                    small
                  />
                ) : null}
                {isVideo && !cameraOff ? (
                  <CallButton
                    icon="camera-reverse"
                    color={theme.surfaceElevated}
                    iconColor={showVideo ? "#FFFFFF" : theme.text}
                    onPress={onSwitchCamera}
                    label="Flip"
                    small
                  />
                ) : null}
                <CallButton
                  icon={speakerOn ? "volume-high" : "volume-medium-outline"}
                  color={speakerOn ? theme.accent : theme.surfaceElevated}
                  iconColor={speakerOn ? "#FFFFFF" : showVideo ? "#FFFFFF" : theme.text}
                  onPress={onToggleSpeaker}
                  label={speakerOn ? "Speaker on" : "Speaker off"}
                  small
                />
                <CallButton icon="call" color={theme.danger} onPress={onHangup} label="End" rotate />
              </View>
            ) : null}
          </Animated.View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** Formats seconds as call-app-standard duration: M:SS under an hour,
 * H:MM:SS from an hour on — matches Phone.app/WhatsApp/Telegram. */
function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function statusLabel(state: CallState, elapsedSeconds: number, mediaConfirmed: boolean) {
  switch (state.phase) {
    case "outgoing":
      return "Ringing…";
    case "incoming":
      return "Incoming call…";
    case "connecting":
      return "Connecting…";
    case "active":
      // "active" alone only means SDP/ICE/DTLS finished — a dead TURN relay
      // reports the same phase while carrying no actual media. Keep showing
      // "Connecting…" until getStats() confirms real packets are arriving
      // (mediaConfirmed), so the UI stops lying that a silent call is fine.
      if (!mediaConfirmed) return "Connecting…";
      // Shows "Connected" for the first second (elapsedSeconds is still 0
      // before the interval's first tick), then switches to the running
      // duration — this is what "должно быть время звонка... сначала
      // напишет connected потом время звонка" asked for.
      return elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : "Connected";
    case "ended":
      return state.reason === "declined"
        ? "Declined"
        : state.reason === "missed"
          ? "Missed"
          : state.reason === "failed"
            ? "Call failed"
            : "Call ended";
    default:
      return "";
  }
}

const styles = StyleSheet.create({
  container: { zIndex: 1000, elevation: 1000 },
  content: { flex: 1, justifyContent: "space-between", paddingVertical: spacing.xxl },
  header: { alignItems: "center", gap: spacing.sm, marginTop: spacing.xxl },
  name: { fontSize: 24, fontWeight: "700" },
  status: { fontSize: 15 },
  controls: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  incomingRow: { flexDirection: "row", justifyContent: "space-around" },
  activeRow: { flexDirection: "row", justifyContent: "center", gap: spacing.xl },
});
