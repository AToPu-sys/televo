import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../src/components/Avatar";
import { useAuth } from "../src/hooks/useAuth";
import { useChats } from "../src/hooks/useChats";
import { supabase } from "../src/lib/supabase";
import { useTheme } from "../src/hooks/useTheme";
import type { Database } from "../src/types/database";
import { spacing } from "../src/theme";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

export default function ForwardMessageScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { messageId } = useLocalSearchParams<{ messageId: string }>();
  const { chats, loading } = useChats(user?.id);

  const [source, setSource] = useState<MessageRow | null>(null);
  const [forwardingTo, setForwardingTo] = useState<string | null>(null);

  useEffect(() => {
    if (!messageId) return;
    supabase
      .from("messages")
      .select("*")
      .eq("id", messageId)
      .single()
      .then(({ data }) => setSource(data ?? null));
  }, [messageId]);

  async function handleForwardTo(conversationId: string) {
    if (!source || !user?.id || forwardingTo) return;
    setForwardingTo(conversationId);

    try {
      // A message from an encrypted conversation can't carry its ciphertext
      // into a destination with a different (or no) session key, so forwards
      // into an encrypted destination are dropped to null body rather than
      // leaking ciphertext that would just fail to decrypt there. Forwarding
      // OUT of a Secret Chat into a plaintext one is intentionally not
      // supported either, for the same reason in reverse — this only forwards
      // a message's plaintext-capable fields (media, document), not text
      // bodies, when the destination is encrypted.
      const { data: destination } = await supabase
        .from("conversations")
        .select("is_encrypted")
        .eq("id", conversationId)
        .single();

      const bodyToForward = source.body;
      const { error } = await supabase.from("messages").insert({
        conversation_id: conversationId,
        sender_id: user.id,
        kind: source.kind,
        body: destination?.is_encrypted ? null : bodyToForward,
        media_url: source.media_url,
        document_name: source.document_name,
        document_size_bytes: source.document_size_bytes,
        forwarded_from_message_id: source.id,
        forwarded_from_sender_id: source.sender_id,
      });
      if (error) throw error;

      router.replace(`/chat/${conversationId}`);
    } catch (caught) {
      Alert.alert(
        "Couldn't forward",
        caught instanceof Error ? caught.message : "Please try again."
      );
    } finally {
      setForwardingTo(null);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          hitSlop={12}
        >
          <Ionicons name="close" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Forward to</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          )}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => handleForwardTo(item.id)}
              accessibilityRole="button"
              accessibilityLabel={`Forward to ${item.title}`}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
              ]}
            >
              <Avatar name={item.title} uri={item.avatarUrl} size={44} />
              <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                {item.title}
              </Text>
              {forwardingTo === item.id ? <ActivityIndicator color={theme.accent} /> : null}
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowTitle: { flex: 1, fontSize: 16, fontWeight: "600" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
});
