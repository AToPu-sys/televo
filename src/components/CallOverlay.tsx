import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { BridgeEvent, WebRtcBridgeHandle } from "./WebRtcBridge";
import { WebRtcBridge } from "./WebRtcBridge";
import type { CallState } from "../hooks/useCall";
import { useTheme } from "../hooks/useTheme";
import { spacing } from "../theme";
import { Avatar } from "./Avatar";
import { CallButton } from "./CallButton";

type CallOverlayProps = {
  state: CallState;
  peerName: string;
  peerAvatarUrl?: string | null;
  muted: boolean;
  cameraOff: boolean;
  isVideo: boolean;
  onBridgeReady: (handle: WebRtcBridgeHandle | null) => void;
  onBridgeEvent: (event: BridgeEvent) => void;
  onAccept: () => void;
  onDecline: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onDismissEnded: () => void;
};

export function CallOverlay({
  state,
  peerName,
  peerAvatarUrl,
  muted,
  cameraOff,
  isVideo,
  onBridgeReady,
  onBridgeEvent,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
  onToggleCamera,
  onDismissEnded,
}: CallOverlayProps) {
  const { theme } = useTheme();

  if (state.phase === "idle") return null;

  // Auto-dismiss "ended" after a beat so the reason is visible, then let the
  // caller reset back to idle.
  if (state.phase === "ended") {
    setTimeout(onDismissEnded, 1500);
  }

  const showVideo = isVideo && state.phase === "active";

  return (
    <View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: theme.background }]}>
      {/* The WebView IS the WebRTC engine — real getUserMedia/RTCPeerConnection
          run inside its browser context, which Expo Go already supports. It's
          always mounted while a call is active so the peer connection and
          media tracks survive; `visible` only toggles whether its <video>
          surfaces render full-bleed (for video calls) or stay off-screen
          (audio-only). */}
      <WebRtcBridge ref={onBridgeReady} onEvent={onBridgeEvent} visible={!!showVideo} />

      <SafeAreaView style={styles.content} pointerEvents="box-none">
        <View style={styles.header}>
          {!showVideo ? <Avatar name={peerName} uri={peerAvatarUrl} size={120} /> : null}
          <Text style={[styles.name, { color: showVideo ? "#FFFFFF" : theme.text }]}>
            {peerName}
          </Text>
          <Text style={[styles.status, { color: showVideo ? "#FFFFFF" : theme.textSecondary }]}>
            {statusLabel(state)}
          </Text>
        </View>

        <View style={styles.controls}>
          {state.phase === "incoming" ? (
            <View style={styles.incomingRow}>
              <CallButton icon="close" color={theme.danger} onPress={onDecline} label="Decline" />
              <CallButton icon="call" color={theme.online} onPress={onAccept} label="Accept" />
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
              <CallButton icon="call" color={theme.danger} onPress={onHangup} label="End" rotate />
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

function statusLabel(state: CallState) {
  switch (state.phase) {
    case "outgoing":
      return "Ringing…";
    case "incoming":
      return "Incoming call…";
    case "connecting":
      return "Connecting…";
    case "active":
      return "Connected";
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
