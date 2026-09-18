import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
import { supabase } from "../../src/lib/supabase";
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

  // Searching only filtered the already-loaded list, i.e. people you had
  // already messaged — so a new contact could not be found at all unless
  // they happened to be in your phone's address book. find_user is an
  // EXACT-match server lookup by @username or phone number (prefix search
  // over profiles would be an enumeration hole), so anyone can be reached by
  // knowing their handle.
  const [remoteResults, setRemoteResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const term = query.trim();
    // Nothing to look up, or already present in the local list.
    if (term.length < 3 || filtered.length > 0) {
      setRemoteResults([]);
      return;
    }

    let cancelled = false;
    setSearching(true);
    // Debounced: this fires per keystroke otherwise, and each one is a round
    // trip on a mobile connection.
    const timer = setTimeout(() => {
      void supabase
        .rpc("find_user", { term })
        .then(({ data, error }) => {
          if (cancelled) return;
          setSearching(false);
          if (error || !data) {
            setRemoteResults([]);
            return;
          }
          setRemoteResults(
            data.map((row) => ({
              id: row.id,
              displayName: row.display_name,
              username: String(row.username),
              avatarUrl: row.avatar_url,
              bio: row.bio,
            }))
          );
        });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, filtered.length]);

  // Local matches first; server results only fill in when there are none.
  const results = filtered.length > 0 ? filtered : remoteResults;

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
            placeholder="Search @username or phone number"
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            accessibilityLabel="Search contacts"
            autoCapitalize="none"
          />
        </View>
        <Pressable
          onPress={() => router.push("/find-friends" as never)}
          accessibilityRole="button"
          style={styles.findFriendsRow}
        >
          <Ionicons name="person-add-outline" size={18} color={theme.accent} />
          <Text style={[styles.findFriendsText, { color: theme.accent }]}>
            Find friends from your phone contacts
          </Text>
        </Pressable>
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
          data={results}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="people-outline" size={56} color={theme.textSecondary} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                {query ? "No matches" : "No contacts yet"}
              </Text>
              <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
                {searching
                  ? "Searching…"
                  : query
                    ? "No one found. A username or phone number has to match exactly."
                    : "People you've messaged show up here. Use Find friends above to discover people from your phone's contacts."}
              </Text>
            </View>
          }
          windowSize={9}
          maxToRenderPerBatch={10}
          initialNumToRender={12}
          removeClippedSubviews
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
  findFriendsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.sm,
    marginHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
  },
  findFriendsText: { fontSize: 13, fontWeight: "600" },
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
