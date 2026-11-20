import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  SectionList,
  Share,
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
import { usePhoneContacts, type PhoneContact } from "../../src/hooks/usePhoneContacts";
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

  // The phone book: people on Televo get a chat button, everyone else an
  // Invite button. Read only after the person allows contacts access.
  const phone = usePhoneContacts(user?.id);
  type Row =
    | { kind: "televo"; key: string; contact: Contact; title: string; subtitle: string }
    | { kind: "invite"; key: string; person: PhoneContact };
  const sections = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = (text: string) => !term || text.toLowerCase().includes(term);
    const seen = new Set<string>();
    const televo: Row[] = [];
    for (const c of results) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      televo.push({ kind: "televo", key: c.id, contact: c, title: c.displayName, subtitle: `@${c.username}` });
    }
    for (const person of phone.contacts) {
      const t = person.televo;
      if (!t || seen.has(t.id) || !(matches(person.name) || matches(t.username) || matches(t.displayName))) continue;
      seen.add(t.id);
      televo.push({
        kind: "televo",
        key: t.id,
        contact: { id: t.id, displayName: t.displayName, username: t.username, avatarUrl: t.avatarUrl, bio: null },
        title: person.name,
        subtitle: `@${t.username}`,
      });
    }
    const invite: Row[] = phone.contacts
      .filter((p) => !p.televo && (matches(p.name) || matches(p.phone)))
      .map((p) => ({ kind: "invite", key: `invite-${p.key}`, person: p }));
    return [
      { key: "televo", title: "On Televo", data: televo },
      ...(invite.length ? [{ key: "invite", title: "Invite to Televo", data: invite }] : []),
    ];
  }, [results, phone.contacts, query]);

  function invite(person: PhoneContact) {
    const message = "Join me on Televo, a free private messenger: https://gettelevo.space/get";
    const url = `sms:${person.phone}${Platform.OS === "ios" ? "&" : "?"}body=${encodeURIComponent(message)}`;
    Linking.openURL(url).catch(() => void Share.share({ message }));
  }

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
        {phone.supported && phone.permission !== "granted" && phone.permission !== "unknown" ? (
          <View style={[styles.permissionCard, { backgroundColor: theme.surfaceElevated }]}>
            <Ionicons name="people" size={22} color={theme.accent} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.permissionTitle, { color: theme.text }]}>See who's on Televo</Text>
              <Text style={[styles.permissionBody, { color: theme.textSecondary }]}>
                {phone.permission === "denied"
                  ? "Contacts access is off. Turn it on in Settings to find friends and invite the rest."
                  : "Allow contacts access to find friends already here and invite the rest. Only scrambled numbers are checked."}
              </Text>
            </View>
            <Pressable
              onPress={() => (phone.permission === "denied" ? Linking.openSettings() : phone.requestAccess())}
              accessibilityRole="button"
              style={[styles.permissionButton, { backgroundColor: theme.accent }]}
            >
              <Text style={styles.permissionButtonText}>{phone.permission === "denied" ? "Settings" : "Allow"}</Text>
            </Pressable>
          </View>
        ) : null}
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
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.key}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) =>
            section.data.length ? (
              <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>{section.title}</Text>
            ) : null
          }
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
                    : "People you've messaged show up here, along with friends from your phone's contacts."}
              </Text>
            </View>
          }
          ListFooterComponent={phone.loading ? <ActivityIndicator style={{ margin: spacing.lg }} color={theme.accent} /> : null}
          renderItem={({ item }) =>
            item.kind === "televo" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Message ${item.title}`}
                onPress={() => handleStartChat(item.contact)}
                style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.surfaceElevated : "transparent" }]}
              >
                <Avatar name={item.contact.displayName} uri={item.contact.avatarUrl} size={46} />
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>{item.title}</Text>
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>{item.subtitle}</Text>
                </View>
                {startingWith === item.contact.id ? (
                  <ActivityIndicator color={theme.accent} />
                ) : (
                  <Ionicons name="chatbubble-outline" size={20} color={theme.accent} />
                )}
              </Pressable>
            ) : (
              <View style={styles.row}>
                <Avatar name={item.person.name} uri={null} size={46} />
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>{item.person.name}</Text>
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>{item.person.phone}</Text>
                </View>
                <Pressable
                  onPress={() => invite(item.person)}
                  accessibilityRole="button"
                  accessibilityLabel={`Invite ${item.person.name} to Televo`}
                  style={[styles.inviteButton, { backgroundColor: theme.online }]}
                >
                  <Text style={styles.inviteText}>Invite</Text>
                </Pressable>
              </View>
            )
          }
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
  permissionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  permissionTitle: { fontSize: 15, fontWeight: "600" },
  permissionBody: { fontSize: 13, lineHeight: 18 },
  permissionButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  permissionButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },
  sectionHeader: { fontSize: 13, fontWeight: "600", paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs, textTransform: "uppercase", letterSpacing: 0.5 },
  inviteButton: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 999 },
  inviteText: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },
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
