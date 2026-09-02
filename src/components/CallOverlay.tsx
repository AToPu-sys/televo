import { useEffect } from "react";
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
  // Only mount the WebView once the user has actually accepted/placed the
  // call (connecting/active/ended) — never during "incoming", where its
  // Accept/Decline buttons must be tappable. react-native-webview's
  // pointerEvents="none" is unreliable on Android (a documented upstream
  // issue: the WebView can still intercept touches meant for views layered
  // over it even when marked non-interactive), so the safest fix is to not
  // have a WebView on screen at all until there's nothing left to tap around
  // it. This also means the mic/camera prompt still only fires on consent,
  // matching the original intent.
  const shouldMountBridge =
    state.phase === "connecting" || state.phase === "active" || state.phase === "outgoing";

  return (
    <View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: theme.background }]}>
      {shouldMountBridge ? (
        <WebRtcBridge ref={onBridgeReady} onEvent={onBridgeEvent} visible={!!showVideo} />
      ) : null}

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
