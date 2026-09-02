import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
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
import { blockUser, isUserBlocked } from "../../src/hooks/useBlockedUsers";
import { useCallManager } from "../../src/hooks/useCallManager";
import { useConversation } from "../../src/hooks/useConversation";
import { useE2ee } from "../../src/hooks/useE2ee";
import { useLastSeen } from "../../src/hooks/useLastSeen";
import { useMessages, type ChatMessage } from "../../src/hooks/useMessages";
import { useParticipantNames } from "../../src/hooks/useParticipantNames";
import { supabase } from "../../src/lib/supabase";
import { useTheme } from "../../src/hooks/useTheme";
import { useTyping } from "../../src/hooks/useTyping";
import { radius, spacing } from "../../src/theme";

const ASSISTANT_USER_ID = "00000000-0000-0000-0000-000000000001";

const SELF_DESTRUCT_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: "Off", seconds: null },
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 604800 },
];

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();

  const { conversation, loading: loadingConversation, refresh: refreshConversation } =
    useConversation(id, user?.id);
  const isEncrypted = conversation?.isEncrypted ?? false;
  const { messages, loading, sendMessage, editMessage, sendImage, sendDocument, deleteMessage, markRead } =
    useMessages(id, user?.id, isEncrypted, conversation?.selfDestructSeconds ?? null);
  const participantNames = useParticipantNames(id, user?.id);
  const { label: presenceLabel } = useLastSeen(user?.id, conversation?.otherUserId);
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
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [isBlocked, setIsBlocked] = useState(false);
  const [editTarget, setEditTarget] = useState<ChatMessage | null>(null);
  const isAssistantChat = conversation?.otherUserId === ASSISTANT_USER_ID;

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

  useEffect(() => {
    if (!user?.id || conversation?.kind !== "direct" || !conversation.otherUserId) return;
    isUserBlocked(user.id, conversation.otherUserId).then(setIsBlocked);
  }, [user?.id, conversation?.kind, conversation?.otherUserId]);

  function handleBlockToggle() {
    if (!user?.id || !conversation?.otherUserId) return;
    const name = conversation.title;

    if (isBlocked) {
      Alert.alert(`Unblock ${name}?`, undefined, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unblock",
          onPress: async () => {
            await supabase
              .from("blocked_users")
              .delete()
              .eq("blocker_id", user.id)
              .eq("blocked_id", conversation.otherUserId!);
            setIsBlocked(false);
          },
        },
      ]);
    } else {
      Alert.alert(
        `Block ${name}?`,
        "They won't be able to send you messages or call you.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Block",
            style: "destructive",
            onPress: async () => {
              try {
                await blockUser(user.id, conversation.otherUserId!);
                setIsBlocked(true);
              } catch (caught) {
                Alert.alert(
                  "Couldn't block",
                  caught instanceof Error ? caught.message : "Please try again."
                );
              }
            },
          },
        ]
      );
    }
  }

  function handleOpenSelfDestructMenu() {
    if (!id) return;

    const options: { text: string; style?: "cancel"; onPress?: () => void }[] =
      SELF_DESTRUCT_OPTIONS.map((option) => ({
        text: option.label,
        onPress: () => {
          void supabase
            .from("conversations")
            .update({ self_destruct_seconds: option.seconds })
            .eq("id", id)
            .then(() => refreshConversation());
        },
      }));
    options.push({ text: "Cancel", style: "cancel" });

    Alert.alert(
      "Self-Destruct Timer",
      "Messages you send will disappear for both people after this long.",
      options
    );
  }

  function handleHeaderMenu() {
    const options: { text: string; style?: "destructive" | "cancel"; onPress?: () => void }[] = [];

    if (isEncrypted) {
      options.push({ text: "Self-Destruct Timer", onPress: handleOpenSelfDestructMenu });
    }
    if (conversation?.kind === "direct") {
      options.push({
        text: isBlocked ? "Unblock" : "Block",
        style: isBlocked ? undefined : "destructive",
        onPress: handleBlockToggle,
      });
    }
    options.push({ text: "Cancel", style: "cancel" });

    Alert.alert(conversation?.title ?? "Chat", undefined, options);
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setDraft("");
    setSending(true);
    try {
      if (editTarget) {
        await editMessage(editTarget.id, body);
        setEditTarget(null);
      } else {
        await sendMessage(body, replyTarget?.id ?? null);
        setReplyTarget(null);
      }
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

  async function handleAttachDocument() {
    if (attaching) return;

    const picked = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets?.[0]) return;

    const asset = picked.assets[0];
    setAttaching(true);
    try {
      await sendDocument(asset.uri, asset.name, asset.size ?? 0);
    } catch (caught) {
      Alert.alert("Upload failed", caught instanceof Error ? caught.message : "Please try again.");
    } finally {
      setAttaching(false);
    }
  }

  function handleMessageLongPress(message: ChatMessage) {
    const isOwn = message.sender_id === user?.id;
    const canEdit = isOwn && message.kind === "text";

    const options: { text: string; style?: "destructive" | "cancel"; onPress?: () => void }[] = [
      {
        text: "Reply",
        onPress: () => {
          setEditTarget(null);
          setReplyTarget(message);
        },
      },
      {
        text: "Forward",
        onPress: () => {
          // Cast: Expo Router's typed-routes generation doesn't pick up
          // this route (see forward-message.tsx) — file exists, exports
          // correctly, and bundles/navigates fine at runtime; only the
          // static type inference misses it.
          router.push({
            pathname: "/forward-message" as never,
            params: { messageId: message.id },
          });
        },
      },
    ];

    if (canEdit) {
      options.push({
        text: "Edit",
        onPress: () => {
          setReplyTarget(null);
          setEditTarget(message);
          setDraft(message.decryptedBody ?? message.body ?? "");
        },
      });
    }

    // Deleting is only offered for your own messages — the RLS policy allows
    // exactly that, so showing it for others' would just produce an error.
    if (isOwn) {
      options.push({
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
      });
    }

    options.push({ text: "Cancel", style: "cancel" });

    Alert.alert("Message", undefined, options);
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
          ) : presenceLabel ? (
            <Text
              style={[
                styles.headerSubtitle,
                { color: presenceLabel === "online" ? theme.online : theme.textSecondary },
              ]}
              numberOfLines={1}
            >
              {presenceLabel}
            </Text>
          ) : conversation?.subtitle ? (
            <Text style={[styles.headerSubtitle, { color: theme.textSecondary }]} numberOfLines={1}>
              {conversation.subtitle}
            </Text>
          ) : null}
        </View>
        {conversation?.kind === "direct" && !isEncrypted && !isAssistantChat ? (
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
        {/* A bot has no voice/video, nothing to block, and no self-destruct
            menu worth showing — only calling/block/encryption are hidden. */}
        {!isAssistantChat ? (
          <>
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
            <Pressable
              onPress={handleHeaderMenu}
              accessibilityRole="button"
              accessibilityLabel="Chat options"
              hitSlop={10}
              style={styles.headerAction}
            >
              <Ionicons name="ellipsis-vertical" size={20} color={theme.accent} />
            </Pressable>
          </>
        ) : null}
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
            renderItem={({ item }) => {
              const repliedTo = item.reply_to_id
                ? messages.find((candidate) => candidate.id === item.reply_to_id)
                : null;
              const replyPreview = repliedTo
                ? {
                    senderName: participantNames[repliedTo.sender_id] ?? "Someone",
                    text:
                      repliedTo.decryptedBody ??
                      repliedTo.body ??
                      (repliedTo.kind === "image"
                        ? "Photo"
                        : repliedTo.kind === "document"
                          ? (repliedTo.document_name ?? "Document")
                          : "Message"),
                  }
                : null;

              const forwardedFrom = item.forwarded_from_sender_id
                ? { senderName: participantNames[item.forwarded_from_sender_id] ?? "Someone" }
                : null;

              return (
                <MessageBubble
                  message={item}
                  isOwn={item.sender_id === user?.id}
                  onLongPress={handleMessageLongPress}
                  replyPreview={replyPreview}
                  forwardedFrom={forwardedFrom}
                />
              );
            }}
          />
        )}

        {replyTarget || editTarget ? (
          <View style={[styles.replyBar, { backgroundColor: theme.surfaceElevated, borderTopColor: theme.border }]}>
            <View style={[styles.replyAccent, { backgroundColor: theme.accent }]} />
            <View style={styles.replyTextBlock}>
              <Text style={[styles.replyLabel, { color: theme.accent }]}>
                {editTarget ? "Editing message" : "Reply"}
              </Text>
              <Text style={[styles.replyPreview, { color: theme.textSecondary }]} numberOfLines={1}>
                {(editTarget ?? replyTarget)?.decryptedBody ??
                  (editTarget ?? replyTarget)?.body ??
                  (((editTarget ?? replyTarget)?.kind === "image" && "Photo") ||
                    ((editTarget ?? replyTarget)?.kind === "document" &&
                      (editTarget ?? replyTarget)?.document_name) ||
                    "Message")}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                setReplyTarget(null);
                setEditTarget(null);
                if (editTarget) setDraft("");
              }}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              hitSlop={10}
            >
              <Ionicons name="close" size={20} color={theme.textSecondary} />
            </Pressable>
          </View>
        ) : null}

        <View
          style={[
            styles.composer,
            { backgroundColor: theme.surface, borderTopColor: theme.border },
          ]}
        >
          <Pressable
            onPress={() =>
              Alert.alert("Attach", undefined, [
                { text: "Photo", onPress: () => void handleAttachImage() },
                { text: "Document", onPress: () => void handleAttachDocument() },
                { text: "Cancel", style: "cancel" },
              ])
            }
            disabled={attaching}
            accessibilityRole="button"
            accessibilityLabel="Attach"
            accessibilityState={{ disabled: attaching }}
            hitSlop={8}
            style={styles.attach}
          >
            {attaching ? (
              <ActivityIndicator color={theme.accent} />
            ) : (
              <Ionicons name="add-circle-outline" size={26} color={theme.accent} />
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
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyAccent: { width: 3, alignSelf: "stretch", borderRadius: 2 },
  replyTextBlock: { flex: 1 },
  replyLabel: { fontSize: 13, fontWeight: "600" },
  replyPreview: { fontSize: 13 },
});
