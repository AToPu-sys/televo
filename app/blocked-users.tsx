import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../src/components/Avatar";
import { useAuth } from "../src/hooks/useAuth";
import { useBlockedUsers } from "../src/hooks/useBlockedUsers";
import { useTheme } from "../src/hooks/useTheme";
import { spacing } from "../src/theme";

export default function BlockedUsersScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { blocked, loading, unblock } = useBlockedUsers(user?.id);

  function handleUnblock(id: string, name: string) {
    Alert.alert(`Unblock ${name}?`, "They'll be able to message and call you again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unblock",
        onPress: () => {
          unblock(id).catch((caught: unknown) => {
            Alert.alert(
              "Couldn't unblock",
              caught instanceof Error ? caught.message : "Please try again."
            );
          });
        },
      },
    ]);
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
        <Text style={[styles.headerTitle, { color: theme.text }]}>Blocked Users</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={blocked}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="ban-outline" size={48} color={theme.textSecondary} />
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                No blocked users.
              </Text>
            </View>
          }
          contentContainerStyle={blocked.length === 0 ? styles.flex : undefined}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Avatar name={item.displayName} uri={item.avatarUrl} size={44} />
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                  {item.displayName}
                </Text>
                <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>
                  @{item.username}
                </Text>
              </View>
              <Pressable
                onPress={() => handleUnblock(item.id, item.displayName)}
                accessibilityRole="button"
                accessibilityLabel={`Unblock ${item.displayName}`}
              >
                <Text style={[styles.unblockText, { color: theme.accent }]}>Unblock</Text>
              </Pressable>
            </View>
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
  loader: { marginTop: spacing.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  emptyText: { fontSize: 14 },
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
  unblockText: { fontSize: 14, fontWeight: "600" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
});
