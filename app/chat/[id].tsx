import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../../src/components/Avatar";
import { MessageBubble } from "../../src/components/MessageBubble";
import { useAuth } from "../../src/hooks/useAuth";
import { useCallManager } from "../../src/hooks/useCallManager";
import { useConversation } from "../../src/hooks/useConversation";
import { useE2ee } from "../../src/hooks/useE2ee";
import { useMessages, type ChatMessage } from "../../src/hooks/useMessages";
import { useTheme } from "../../src/hooks/useTheme";
import { useTyping } from "../../src/hooks/useTyping";
import { radius, spacing } from "../../src/theme";

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();

  const { conversation, loading: loadingConversation, refresh: refreshConversation } =
    useConversation(id, user?.id);
  const isEncrypted = conversation?.isEncrypted ?? false;
  const { messages, loading, sendMessage, sendImage, deleteMessage, markRead } = useMessages(
    id,
    user?.id,
    isEncrypted
  );
  const { typingLabel, notifyTyping } = useTyping(
    id,
    user?.id,
    user?.user_metadata?.display_name as string | undefined
  );
  const { placeCall, state: callState } = useCallManager();
  const { startEncryptedChat } = useE2ee();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [enablingEncryption, setEnablingEncryption] = useState(false);

  async function handleEnableEncryption() {
    if (!id || !conversation || conversation.kind !== "direct" || !conversation.otherUserId) return;
    setEnablingEncryption(true);
    try {
      await startEncryptedChat(id, conversation.otherUserId);
      await refreshConversation();
    } catch (caught) {
      Alert.alert(
        "Couldn't start Secret Chat",
        caught instanceof Error ? caught.message : "Please try again."
      );
    } finally {
      setEnablingEncryption(false);
    }
  }

  function handleCall(kind: "audio" | "video") {
    if (!id || callState.phase !== "idle") return;
    void placeCall(id, kind);
  }

  // Clear the unread badge once the thread is on screen.
  useEffect(() => {
    if (!loading) {
      void markRead();
    }
  }, [loading, markRead, messages.length]);

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setDraft("");
    setSending(true);
    try {
      await sendMessage(body);
    } catch {
      // useMessages marks the bubble as failed; restore the text so the user
      // can retry without retyping.
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  async function handleAttachImage() {
    if (attaching) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo access needed",
        "Allow photo library access to send images, or enable it in Settings."
      );
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.7,
    });
    if (picked.canceled || !picked.assets?.[0]) return;

    setAttaching(true);
    try {
      await sendImage(picked.assets[0].uri);
    } catch (caught) {
      Alert.alert("Upload failed", caught instanceof Error ? caught.message : "Please try again.");
    } finally {
      setAttaching(false);
    }
  }

  function handleMessageLongPress(message: ChatMessage) {
    // Deleting is only offered for your own messages — the RLS policy allows
    // exactly that, so showing it for others' would just produce an error.
    if (message.sender_id !== user?.id) return;

    Alert.alert("Delete message", "This removes it for everyone in the chat.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteMessage(message.id).catch((caught: unknown) => {
            Alert.alert(
              "Couldn't delete",
              caught instanceof Error ? caught.message : "Please try again."
            );
          });
        },
      },
    ]);
  }

  const title = conversation?.title ?? "Chat";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.chatBackground }]}>
      <View
        style={[
          styles.header,
          { backgroundColor: theme.surface, borderBottomColor: theme.border },
        ]}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={28} color={theme.accent} />
        </Pressable>
        <Avatar name={title} uri={conversation?.avatarUrl ?? null} size={38} />
        <View style={styles.headerText}>
          <View style={styles.headerTitleRow}>
            {isEncrypted ? (
              <Ionicons name="lock-closed" size={13} color={theme.online} style={styles.lockIcon} />
            ) : null}
            <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>
              {loadingConversation ? "…" : title}
            </Text>
          </View>
          {typingLabel ? (
            <Text style={[styles.headerSubtitle, { color: theme.accent }]} numberOfLines={1}>
              {typingLabel}
            </Text>
          ) : conversation?.subtitle ? (
            <Text style={[styles.headerSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>
              {conversation.subtitle}
            </Text>
          ) : null}
        </View>
        {conversation?.kind === "direct" && !isEncrypted ? (
          <Pressable
            onPress={handleEnableEncryption}
            disabled={enablingEncryption}
            accessibilityRole="button"
            accessibilityLabel="Start Secret Chat (end-to-end encrypted)"
            hitSlop={10}
            style={styles.headerAction}
          >
            {enablingEncryption ? (
              <ActivityIndicator color={theme.accent} />
            ) : (
              <Ionicons name="lock-open-outline" size={22} color={theme.accent} />
            )}
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => handleCall("audio")}
          accessibilityRole="button"
          accessibilityLabel="Voice call"
          hitSlop={10}
          style={styles.headerAction}
        >
          <Ionicons name="call-outline" size={23} color={theme.accent} />
        </Pressable>
        <Pressable
          onPress={() => handleCall("video")}
          accessibilityRole="button"
          accessibilityLabel="Video call"
          hitSlop={10}
          style={styles.headerAction}
        >
          <Ionicons name="videocam-outline" size={25} color={theme.accent} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
          </View>
        ) : (
          <FlatList
            // Newest-first data rendered bottom-up, so new messages appear at
            // the bottom without manual scrolling.
            inverted
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={[styles.center, styles.emptyInverted]}>
                <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                  No messages yet. Say hello.
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <MessageBubble
                message={item}
                isOwn={item.sender_id === user?.id}
                onLongPress={handleMessageLongPress}
              />
            )}
          />
        )}

        <View
          style={[
            styles.composer,
            { backgroundColor: theme.surface, borderTopColor: theme.border },
          ]}
        >
          <Pressable
            onPress={handleAttachImage}
            disabled={attaching}
            accessibilityRole="button"
            accessibilityLabel="Attach a photo"
            accessibilityState={{ disabled: attaching }}
            hitSlop={8}
            style={styles.attach}
          >
            {attaching ? (
              <ActivityIndicator color={theme.accent} />
            ) : (
              <Ionicons name="image-outline" size={24} color={theme.accent} />
            )}
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              notifyTyping();
            }}
            placeholder="Message"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.input,
              { backgroundColor: theme.surfaceElevated, color: theme.text },
            ]}
            multiline
            accessibilityLabel="Message text"
          />
          <Pressable
            onPress={handleSend}
            disabled={!draft.trim() || sending}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !draft.trim() || sending }}
            style={({ pressed }) => [
              styles.send,
              {
                backgroundColor: draft.trim() ? theme.accent : theme.surfaceElevated,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Ionicons
              name="send"
              size={18}
              color={draft.trim() ? "#FFFFFF" : theme.textSecondary}
            />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: { flex: 1 },
  headerTitleRow: { flexDirection: "row", alignItems: "center" },
  headerTitle: { fontSize: 17, fontWeight: "600" },
  lockIcon: { marginRight: 4 },
  headerSubtitle: { fontSize: 12 },
  list: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyInverted: { transform: [{ scaleY: -1 }] },
  emptyText: { fontSize: 15 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  attach: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerAction: { marginLeft: spacing.md },
});
