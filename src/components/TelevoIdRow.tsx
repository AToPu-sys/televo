import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../hooks/useTheme";
import { radius, spacing } from "../theme";

/** An account's Televo ID with tap-to-copy. Support (hello@gettelevo.space)
 * requires this ID to act on a report or an appeal, so it has to be findable
 * before anyone is banned — not only on BanScreen. */
export function TelevoIdRow({ userId, label = "Televo ID" }: { userId: string; label?: string }) {
  const { theme } = useTheme();
  const [copied, setCopied] = useState(false);

  async function copy() {
    await Clipboard.setStringAsync(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Pressable
      onPress={copy}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${userId}. Tap to copy`}
      style={[styles.row, { backgroundColor: theme.surfaceElevated }]}
    >
      <View style={styles.text}>
        <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
        <Text style={[styles.value, { color: theme.text }]} numberOfLines={1} selectable>
          {userId}
        </Text>
      </View>
      <Ionicons name={copied ? "checkmark" : "copy-outline"} size={18} color={theme.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  text: { flex: 1 },
  label: { fontSize: 13, marginBottom: 2 },
  value: { fontSize: 13, fontFamily: "Menlo" },
});
