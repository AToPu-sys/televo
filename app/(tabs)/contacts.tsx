import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../../src/components/Avatar";
import { useAuth } from "../../src/hooks/useAuth";
import { findOrCreateDirectChat, useContacts, type Contact } from "../../src/hooks/useContacts";
import { useTheme } from "../../src/hooks/useTheme";
import { radius, spacing } from "../../src/theme";

export default function ContactsScreen() {
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const { contacts, loading, error } = useContacts(user?.id);
  const [query, setQuery] = useState("");
  const [startingWith, setStartingWith] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return contacts;
    return contacts.filter(
      (contact) =>
        contact.displayName.toLowerCase().includes(term) ||
        contact.username.toLowerCase().includes(term)
    );
  }, [contacts, query]);

  async function handleStartChat(contact: Contact) {
    if (!user?.id || startingWith) return;
    setStartingWith(contact.id);
    try {
      const conversationId = await findOrCreateDirectChat(user.id, contact.id);
      router.push(`/chat/${conversationId}`);
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
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Contacts</Text>
      </View>

      <View style={styles.searchWrapper}>
        <View style={[styles.search, { backgroundColor: theme.surfaceElevated }]}>
          <Ionicons name="search" size={18} color={theme.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name or @username"
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            accessibilityLabel="Search contacts"
            autoCapitalize="none"
          />
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Couldn&apos;t load contacts</Text>
          <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="people-outline" size={56} color={theme.textSecondary} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                {query ? "No matches" : "No other users yet"}
              </Text>
              <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
                {query
                  ? "Try a different name or username."
                  : "Once someone else signs up they'll appear here."}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Message ${item.displayName}`}
              onPress={() => handleStartChat(item)}
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
                  @{item.username}
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
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 24, fontWeight: "700" },
  searchWrapper: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    height: 38,
  },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0 },
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
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 74 },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: 18, fontWeight: "600", marginTop: spacing.sm },
  emptyBody: { fontSize: 14, textAlign: "center" },
});
