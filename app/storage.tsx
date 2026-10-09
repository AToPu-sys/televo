import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../src/hooks/useTheme";
import { clearMediaCache, mediaCacheSize } from "../src/lib/mediaCache";
import { radius, spacing } from "../src/theme";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function StorageScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    try {
      setSize(mediaCacheSize());
    } catch {
      setSize(0);
    }
  }, []);

  useEffect(refresh, [refresh]);

  function confirmClear() {
    Alert.alert(
      "Clear media cache?",
      "Photos, videos, files and voice messages saved on this iPhone will be removed. They stay in your chats and download again when you open them. Your messages are not affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            setClearing(true);
            try {
              clearMediaCache();
            } finally {
              setClearing(false);
              refresh();
            }
          },
        },
      ]
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Storage</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <View style={[styles.section, { backgroundColor: theme.surfaceElevated }]}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={[styles.rowLabel, { color: theme.text }]}>Media cache</Text>
              <Text style={[styles.rowHint, { color: theme.textSecondary }]}>
                Photos, videos, files and voice messages you've opened, kept on this iPhone so chats load instantly.
              </Text>
            </View>
            {size === null ? (
              <ActivityIndicator color={theme.accent} />
            ) : (
              <Text style={[styles.size, { color: theme.text }]}>{formatBytes(size)}</Text>
            )}
          </View>
        </View>

        <Pressable
          onPress={confirmClear}
          disabled={clearing || !size}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.clear,
            { backgroundColor: theme.surfaceElevated, opacity: clearing || !size ? 0.5 : pressed ? 0.7 : 1 },
          ]}
        >
          {clearing ? (
            <ActivityIndicator color={theme.danger} />
          ) : (
            <Text style={[styles.clearText, { color: theme.danger }]}>Clear Media Cache</Text>
          )}
        </Pressable>

        <Text style={[styles.note, { color: theme.textSecondary }]}>
          Messages are always kept. Clearing the cache only removes saved media from this device — it isn't deleted from your chats.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  headerSpacer: { width: 26 },
  content: { padding: spacing.lg, gap: spacing.lg },
  section: { borderRadius: radius.md, paddingHorizontal: spacing.lg },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.md },
  rowText: { flex: 1, gap: 2, marginRight: spacing.md },
  rowLabel: { fontSize: 16 },
  rowHint: { fontSize: 12, lineHeight: 16 },
  size: { fontSize: 16, fontWeight: "600", fontVariant: ["tabular-nums"] },
  clear: { borderRadius: radius.md, paddingVertical: spacing.md, alignItems: "center" },
  clearText: { fontSize: 16, fontWeight: "600" },
  note: { fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.xs },
});
