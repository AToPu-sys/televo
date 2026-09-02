import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../../src/components/Avatar";
import { useAuth } from "../../src/hooks/useAuth";
import { useCallLog, type CallLogEntry } from "../../src/hooks/useCallLog";
import { useCallManager } from "../../src/hooks/useCallManager";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";

export default function CallsScreen() {
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const { entries, loading } = useCallLog(user?.id);
  const { placeCall, state: callState } = useCallManager();

  function handleCallBack(entry: CallLogEntry) {
    if (callState.phase !== "idle" || !entry.peerId) return;
    void placeCall(entry.conversationId, entry.kind);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Calls</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="call-outline" size={56} color={theme.textSecondary} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>No calls yet</Text>
              <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
                Voice and video calls you make or receive show up here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/chat/${item.conversationId}`)}
              accessibilityRole="button"
              accessibilityLabel={`Chat with ${item.peerName}`}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
              ]}
            >
              <Avatar name={item.peerName} uri={item.peerAvatarUrl} size={46} />
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                  {item.peerName}
                </Text>
                <View style={styles.rowMeta}>
                  <Ionicons
                    name={item.direction === "outgoing" ? "arrow-up-outline" : "arrow-down-outline"}
                    size={13}
                    color={statusColor(item, theme)}
                  />
                  <Text style={[styles.rowSubtitle, { color: statusColor(item, theme) }]}>
                    {statusLabel(item)}
                  </Text>
                  <Text style={[styles.rowTime, { color: theme.textSecondary }]}>
                    {formatTimestamp(item.startedAt)}
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() => handleCallBack(item)}
                accessibilityRole="button"
                accessibilityLabel={`Call ${item.peerName} back`}
                hitSlop={10}
              >
                <Ionicons
                  name={item.kind === "video" ? "videocam" : "call"}
                  size={22}
                  color={theme.accent}
                />
              </Pressable>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function statusLabel(entry: CallLogEntry) {
  if (entry.status === "missed") return "Missed";
  if (entry.status === "declined") return "Declined";
  if (entry.durationSeconds !== null) {
    const minutes = Math.floor(entry.durationSeconds / 60);
    const seconds = entry.durationSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return entry.direction === "outgoing" ? "Outgoing" : "Incoming";
}

function statusColor(entry: CallLogEntry, theme: { danger: string; textSecondary: string }) {
  if (entry.status === "missed" || entry.status === "declined") return theme.danger;
  return theme.textSecondary;
}

function formatTimestamp(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 24, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: 18, fontWeight: "600", marginTop: spacing.sm },
  emptyBody: { fontSize: 14, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 4 },
  rowSubtitle: { fontSize: 13 },
  rowTime: { fontSize: 13, marginLeft: spacing.xs },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
});
