import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../src/components/Avatar";
import { Button } from "../src/components/Button";
import { useAuth } from "../src/hooks/useAuth";
import { useContactDiscovery, type DiscoveredFriend } from "../src/hooks/useContactDiscovery";
import { findOrCreateDirectChat } from "../src/hooks/useContacts";
import { useTheme } from "../src/hooks/useTheme";
import { spacing } from "../src/theme";

export default function FindFriendsScreen() {
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const { status, matches, error, scan } = useContactDiscovery(user?.id);
  const [startingWith, setStartingWith] = useState<string | null>(null);

  useEffect(() => {
    void scan();
    // Runs once when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleMessage(friend: DiscoveredFriend) {
    if (!user?.id || startingWith) return;
    setStartingWith(friend.id);
    try {
      const conversationId = await findOrCreateDirectChat(user.id, friend.id);
      router.replace(`/chat/${conversationId}`);
    } catch (caught) {
      Alert.alert(
        "Couldn't open chat",
        caught instanceof Error ? caught.message : "Please try again."
      );
    } finally {
      setStartingWith(null);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Find friends</Text>
        <View style={styles.headerSpacer} />
      </View>

      {status === "loading" || status === "idle" ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.centerText, { color: theme.textSecondary }]}>
            Checking your contacts…
          </Text>
        </View>
      ) : status === "denied" ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={56} color={theme.textSecondary} />
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Contacts access needed</Text>
          <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
            Allow contacts access to find people you know who are already on Televo.
          </Text>
          <Button title="Try again" onPress={scan} style={styles.retryButton} />
        </View>
      ) : status === "error" ? (
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Something went wrong</Text>
          <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>{error}</Text>
          <Button title="Try again" onPress={scan} style={styles.retryButton} />
        </View>
      ) : (
        <FlatList
          data={matches}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="people-outline" size={56} color={theme.textSecondary} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>No matches yet</Text>
              <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
                None of your contacts have added a phone number to Televo yet. When they do,
                they'll show up here.
              </Text>
            </View>
          }
          contentContainerStyle={matches.length === 0 ? styles.flex : undefined}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Message ${item.displayName}`}
              onPress={() => handleMessage(item)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
              ]}
            >
              <Avatar name={item.displayName} uri={item.avatarUrl} size={46} />
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                  {item.displayName}
                </Text>
                <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>
                  In your contacts as "{item.contactName}"
                </Text>
              </View>
              {startingWith === item.id ? (
                <ActivityIndicator color={theme.accent} />
              ) : (
                <Ionicons name="chatbubble-outline" size={20} color={theme.accent} />
              )}
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
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
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxl,
    gap: spacing.sm,
  },
  centerText: { fontSize: 14 },
  emptyTitle: { fontSize: 18, fontWeight: "600", marginTop: spacing.sm },
  emptyBody: { fontSize: 14, textAlign: "center" },
  retryButton: { marginTop: spacing.md, minWidth: 160 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { fontSize: 13 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
});
