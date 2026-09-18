import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../hooks/useTheme";
import { useToast, type ToastKind } from "../hooks/useToast";
import { radius, spacing } from "../theme";

const ICON: Record<ToastKind, keyof typeof Ionicons.glyphMap> = {
  success: "checkmark-circle",
  error: "alert-circle",
  info: "information-circle",
};

/** Renders the current toast above every screen. Mounted once, at the root.
 *
 * Static on purpose: it appears and disappears without a transition, so it
 * costs nothing to render and cannot stutter when it shows up during the
 * busy moment that produced it (a send failing, decryption running). */
export function ToastHost() {
  const { toast, dismiss } = useToast();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  if (!toast) return null;

  const tint =
    toast.kind === "error" ? theme.danger : toast.kind === "success" ? theme.online : theme.accent;

  return (
    // pointerEvents box-none so the toast never swallows taps meant for the
    // screen behind it — only the banner itself is interactive.
    <View style={[styles.host, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
      <View
        style={[
          styles.toast,
          { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
        ]}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
      >
        <View style={[styles.iconWrap, { backgroundColor: `${tint}22` }]}>
          <Ionicons name={ICON[toast.kind]} size={20} color={tint} />
        </View>

        <View style={styles.body}>
          <Text style={[styles.message, { color: theme.text }]} numberOfLines={2}>
            {toast.message}
          </Text>
          {toast.detail ? (
            <Text style={[styles.detail, { color: theme.textSecondary }]} numberOfLines={2}>
              {toast.detail}
            </Text>
          ) : null}
        </View>

        {toast.actionLabel && toast.onAction ? (
          <Pressable
            onPress={() => {
              toast.onAction?.();
              dismiss(toast.id);
            }}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={[styles.action, { color: theme.accent }]}>{toast.actionLabel}</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => dismiss(toast.id)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Ionicons name="close" size={18} color={theme.textSecondary} />
          </Pressable>
        )}
      </View>
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
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    maxWidth: 520,
    width: "92%",
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 1 },
  message: { fontSize: 15, fontWeight: "600" },
  detail: { fontSize: 13 },
  action: { fontSize: 15, fontWeight: "700" },
});
