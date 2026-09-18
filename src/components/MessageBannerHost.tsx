import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { MessageBannerData } from "../hooks/useMessageNotifications"; // type-only: no runtime import, so this doesn't form a real module cycle with useMessageNotifications.tsx importing this component
import { useTheme } from "../hooks/useTheme";
import { radius, spacing } from "../theme";
import { Avatar } from "./Avatar";

const AUTO_DISMISS_MS = 4000;

/** Telegram-style in-app banner for a message that arrived in a DIFFERENT
 * chat than the one currently open (see useMessageNotifications, which
 * decides when to show this vs. just playing a sound). The whole banner is
 * tappable — unlike ToastHost's generic toast, which only makes its trailing
 * action/dismiss icon interactive — since "go to this chat" is the one thing
 * a user does with a message banner, not a secondary action alongside it. */
export function MessageBannerHost({
  banner,
  onPress,
  onDismiss,
}: {
  banner: MessageBannerData | null;
  onPress: () => void;
  onDismiss: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!banner) return;
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banner?.conversationId, banner?.body]);

  if (!banner) return null;

  return (
    <View style={[styles.host, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
      <Pressable
        onPress={onPress}
        style={[styles.banner, { backgroundColor: theme.surfaceElevated, borderColor: theme.border }]}
        accessibilityRole="button"
        accessibilityLabel={`New message: ${banner.title}`}
      >
        <Avatar name={banner.title} size={40} />
        <View style={styles.body}>
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
            {banner.title}
          </Text>
          <Text style={[styles.message, { color: theme.textSecondary }]} numberOfLines={2}>
            {banner.body}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 1000,
    elevation: 1000,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    maxWidth: 520,
    width: "92%",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: "700" },
  message: { fontSize: 14 },
});
