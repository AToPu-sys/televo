import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../../src/components/Avatar";
import { useAuth } from "../../src/hooks/useAuth";
import { useChats, type ChatSummary } from "../../src/hooks/useChats";
import { useTheme } from "../../src/hooks/useTheme";
import { radius, spacing } from "../../src/theme";

export default function ChatsScreen() {
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const { chats, loading, error, refresh } = useChats(user?.id);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // Stable identities: an inline arrow here is a new prop every render,
  // which makes FlatList re-render every row and defeats ChatRow's memo.
  const renderChatRow = useCallback(
    ({ item, index }: { item: ChatSummary; index: number }) => (
      <ChatRow chat={item} index={index} />
    ),
    []
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return chats;
    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(term) ||
        (chat.lastMessage ?? "").toLowerCase().includes(term)
    );
  }, [chats, query]);

  async function handleRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Chats</Text>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New group"
            onPress={() => router.push("/new-group")}
            hitSlop={10}
          >
            <Ionicons name="people-outline" size={25} color={theme.accent} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New chat"
            onPress={() => router.push("/(tabs)/contacts")}
            hitSlop={10}
          >
            <Ionicons name="create-outline" size={26} color={theme.accent} />
          </Pressable>
        </View>
      </View>

      <View style={styles.searchWrapper}>
        <View style={[styles.search, { backgroundColor: theme.surfaceElevated }]}>
          <Ionicons name="search" size={18} color={theme.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            accessibilityLabel="Search chats"
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <Pressable
              onPress={() => setQuery("")}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={10}
            >
              <Ionicons name="close-circle" size={18} color={theme.textSecondary} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Couldn&apos;t load chats</Text>
          <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.accent}
            />
          }
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="chatbubbles-outline" size={56} color={theme.textSecondary} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                {query ? "No matches" : "No chats yet"}
              </Text>
              <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
                {query
                  ? "Try a different search term."
                  : "Start a conversation from the Contacts tab."}
              </Text>
            </View>
          }
          renderItem={renderChatRow}
          // Same reasoning as the message list: default virtualization keeps
          // every row ever scrolled past mounted, and each row subscribes to
          // theme context and holds an avatar.
          windowSize={9}
          maxToRenderPerBatch={10}
          initialNumToRender={12}
          removeClippedSubviews
        />
      )}
    </SafeAreaView>
  );
}

function ChatRowComponent({ chat, index }: { chat: ChatSummary; index: number }) {
  const { theme } = useTheme();
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${chat.title}${
        chat.unreadCount > 0 ? `, ${chat.unreadCount} unread` : ""
      }`}
      onPress={() => router.push(`/chat/${chat.id}`)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
      ]}
    >
      <Avatar name={chat.title} uri={chat.avatarUrl} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <View style={styles.rowTitleWrap}>
            {chat.isEncrypted ? (
              // Secret Chat indicator, shown here rather than only inside a
              // failed-decrypt message bubble — that was the ONLY place a
              // Secret Chat was visually distinct from a regular one before,
              // and only when something had already gone wrong. This marks
              // the chat's TYPE at a glance in the list itself, matching
              // Telegram's own placement.
              <Ionicons
                name="lock-closed"
                size={13}
                color={theme.accent}
                style={styles.encryptedIcon}
              />
            ) : null}
            <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
              {chat.title}
            </Text>
          </View>
          {chat.lastMessageAt ? (
            <Text style={[styles.rowTime, { color: theme.textSecondary }]}>
              {formatTimestamp(chat.lastMessageAt)}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowBottom}>
          {chat.lastMessageIsOwn && chat.lastMessageRead !== null ? (
            <Ionicons
              name={chat.lastMessageRead ? "checkmark-done" : "checkmark"}
              size={16}
              color={chat.lastMessageRead ? theme.accent : theme.textSecondary}
              style={styles.readIcon}
            />
          ) : null}
          <Text style={[styles.rowPreview, { color: theme.textSecondary }]} numberOfLines={1}>
            {chat.lastMessage ?? "No messages yet"}
          </Text>
          {chat.unreadCount > 0 ? (
            <View style={[styles.badge, { backgroundColor: theme.unreadBadge }]}>
              <Text style={styles.badgeText}>
                {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Memoized: useChats replaces the whole array on every realtime event, so
 * an untouched row would otherwise re-render on every message in any chat.
 * Compared on the fields the row actually draws. */
const ChatRow = memo(
  ChatRowComponent,
  (prev, next) =>
    prev.index === next.index &&
    prev.chat.id === next.chat.id &&
    prev.chat.title === next.chat.title &&
    prev.chat.avatarUrl === next.chat.avatarUrl &&
    prev.chat.lastMessage === next.chat.lastMessage &&
    prev.chat.lastMessageAt === next.chat.lastMessageAt &&
    prev.chat.lastMessageIsOwn === next.chat.lastMessageIsOwn &&
    prev.chat.lastMessageRead === next.chat.lastMessageRead &&
    prev.chat.unreadCount === next.chat.unreadCount
);

function formatTimestamp(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (now.getTime() - date.getTime() < 7 * dayMs) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
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
  headerTitle: { fontSize: 24, fontWeight: "700" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
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
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  // flex: 1 moved here from rowTitle (below) — this wrapper now holds both
  // the optional lock icon and the title text, and needs to be the thing
  // that stretches to push the timestamp to the right edge, not the Text
  // alone, or a chat without the icon would size differently from one with
  // it.
  rowTitleWrap: { flex: 1, flexDirection: "row", alignItems: "center" },
  encryptedIcon: { marginRight: 4 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowTime: { fontSize: 12, marginLeft: spacing.sm },
  rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowPreview: { flex: 1, fontSize: 14 },
  readIcon: { marginRight: 4 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    marginLeft: spacing.sm,
  },
  badgeText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 80 },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: 18, fontWeight: "600", marginTop: spacing.sm },
  emptyBody: { fontSize: 14, textAlign: "center" },
});
