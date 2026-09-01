import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { type MediaStream, RTCView } from "react-native-webrtc";
import { SafeAreaView } from "react-native-safe-area-context";

import type { CallState } from "../hooks/useCall";
import { useTheme } from "../hooks/useTheme";
import { spacing } from "../theme";
import { Avatar } from "./Avatar";
import { CallButton } from "./CallButton";

type CallOverlayProps = {
  state: CallState;
  peerName: string;
  peerAvatarUrl?: string | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  isVideo: boolean;
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
  localStream,
  remoteStream,
  muted,
  cameraOff,
  isVideo,
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

  const showVideo = isVideo && remoteStream && state.phase === "active";

  return (
    <View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: theme.background }]}>
      {showVideo ? (
        <RTCView
          streamURL={remoteStream!.toURL()}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
        />
      ) : null}

      {isVideo && localStream && state.phase === "active" && !cameraOff ? (
        <View style={styles.selfPreview}>
          <RTCView
            streamURL={localStream.toURL()}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            zOrder={1}
            mirror
          />
        </View>
      ) : null}

      <SafeAreaView style={styles.content}>
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
  selfPreview: {
    position: "absolute",
    top: 60,
    right: spacing.lg,
    width: 100,
    height: 140,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  controls: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  incomingRow: { flexDirection: "row", justifyContent: "space-around" },
  activeRow: { flexDirection: "row", justifyContent: "center", gap: spacing.xl },
});
