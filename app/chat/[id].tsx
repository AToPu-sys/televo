import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import { ActionSheet, type ActionSheetOption } from "../../src/components/ActionSheet";
import { Avatar } from "../../src/components/Avatar";
import { MediaViewer, type MediaViewerItem } from "../../src/components/MediaViewer";
import { MessageBubble } from "../../src/components/MessageBubble";
import { useAuth } from "../../src/hooks/useAuth";
import { blockUser, isUserBlocked } from "../../src/hooks/useBlockedUsers";
import { useCallManager } from "../../src/hooks/useCallManager";
import { useConversation } from "../../src/hooks/useConversation";
import { MissingSessionKeyError, useE2ee } from "../../src/hooks/useE2ee";
import { useLastSeen } from "../../src/hooks/useLastSeen";
import { useMessages, type ChatMessage } from "../../src/hooks/useMessages";
import { useParticipantNames } from "../../src/hooks/useParticipantNames";
import { ASSISTANT_USER_ID } from "../../src/lib/assistant";
import { setCurrentConversationId } from "../../src/lib/currentChat";
import { isPeerKeyVerified } from "../../src/lib/e2e";
import { supabase } from "../../src/lib/supabase";
import { useTheme } from "../../src/hooks/useTheme";
import { useToast } from "../../src/hooks/useToast";
import { useTyping } from "../../src/hooks/useTyping";
import { useVoiceRecorder, VOICE_MAX_MS } from "../../src/hooks/useVoiceRecorder";
import { radius, spacing } from "../../src/theme";

const SELF_DESTRUCT_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: "Off", seconds: null },
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 604800 },
];

type ChatRow = { type: "message"; message: ChatMessage } | { type: "separator"; dateKey: string; label: string };

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dateSeparatorLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** Interleaves a date-separator row wherever two adjacent messages (in this
 * newest-first array) fall on different calendar days. `messages` is
 * newest-first because the FlatList that consumes this is `inverted`, so a
 * separator placed right after (in array order) the OLDEST message of a day
 * ends up rendered visually ABOVE that message — exactly where a "September
 * 14" divider belongs. */
function dateSeparatedRows(messages: ChatMessage[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    rows.push({ type: "message", message });
    const next = messages[i + 1];
    if (!next || dayKey(next.created_at) !== dayKey(message.created_at)) {
      rows.push({ type: "separator", dateKey: dayKey(message.created_at), label: dateSeparatorLabel(message.created_at) });
    }
  }
  return rows;
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const { show: showToast } = useToast();

  // Lets useMessageNotifications (app/_layout.tsx) tell "a message arrived
  // for the chat you're already looking at" apart from "a message arrived
  // somewhere else" — the former should just play a sound, the latter should
  // show a mini banner. Updated on every render (not just mount) so
  // navigating from one chat straight to another (id changes, component
  // stays mounted) still points at the right conversation; cleared on
  // unmount so leaving chat screens entirely doesn't leave a stale "current
  // chat" that suppresses every future banner.
  useEffect(() => {
    setCurrentConversationId(id ?? null);
    return () => setCurrentConversationId(null);
  }, [id]);

  const { conversation, loading: loadingConversation, refresh: refreshConversation } =
    useConversation(id, user?.id);
  // Coming back from group info: the name, photo or member count may have
  // just been changed there.
  const isGroupRef = useRef(false);
  isGroupRef.current = conversation?.kind === "group";
  useFocusEffect(
    useCallback(() => {
      if (isGroupRef.current) void refreshConversation();
    }, [refreshConversation])
  );
  // Stays undefined (rather than defaulting to false) until the conversation
  // row has actually loaded. useMessages will not fetch on an undefined
  // value, since guessing "false" for what turns out to be an encrypted chat
  // would flash the raw {"ciphertext":...} envelope for a frame before
  // re-fetching with the real value.
  const isEncrypted = loadingConversation ? undefined : (conversation?.isEncrypted ?? false);
  const {
    messages,
    loading: loadingMessages,
    peerLastReadAt,
    hasMore,
    loadOlder,
    sendMessage,
    editMessage,
    sendImage,
    sendDocument,
    sendVoice,
    deleteMessage,
    markRead,
    retryDecryption,
    retrySend,
  } = useMessages(id, user?.id, isEncrypted, conversation?.selfDestructSeconds ?? null);
  const loading = loadingConversation || loadingMessages;
  // renderItem looked up `messages.find(...)` per row to resolve a reply
  // quote, making it O(n) per row and effectively O(n²) over the list —
  // visibly janky scrolling once a chat has a few hundred messages.
  const messagesById = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const message of messages) map.set(message.id, message);
    return map;
  }, [messages]);
  // One synthetic row per calendar day boundary, interleaved with the
  // messages so the inverted list renders a "September 14" divider above the
  // first message of each day (visually — since the list is inverted, that
  // divider actually sits right AFTER that day's oldest message in `messages`,
  // which is itself newest-first).
  const rows = useMemo(() => dateSeparatedRows(messages), [messages]);
  // The inline separators in `rows` mark day boundaries in the scrollback,
  // but on a chat spanning only one day (the common case) that leaves
  // exactly one separator, sitting above the very oldest message — nothing
  // shows without scrolling all the way up. This mirrors it as a floating
  // header pinned to the top of the viewport, always showing the date of
  // whatever message is currently topmost on screen (the newest-of-the-
  // visible-set in this inverted list, i.e. the FIRST entry FlatList reports
  // as viewable), same as Telegram/WhatsApp.
  const [pinnedDateLabel, setPinnedDateLabel] = useState<string | null>(null);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: { item: ChatRow }[] }) => {
      const topMessage = viewableItems.find((v) => v.item.type === "message")?.item;
      if (topMessage?.type === "message") {
        setPinnedDateLabel(dateSeparatorLabel(topMessage.message.created_at));
      }
    }
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 0 }).current;
  const messageSenderIds = useMemo(
    () => messages.flatMap((m) => [m.sender_id, m.forwarded_from_sender_id ?? ""]).filter(Boolean),
    [messages]
  );
  const participantNames = useParticipantNames(id, user?.id, messageSenderIds);
  const { label: presenceLabel } = useLastSeen(user?.id, conversation?.otherUserId);
  const { typingLabel, notifyTyping, notifyStoppedTyping } = useTyping(
    id,
    user?.id,
    user?.user_metadata?.display_name as string | undefined
  );
  const { placeCall, state: callState } = useCallManager();
  const callInProgress = callState.phase !== "idle" && callState.phase !== "ended";
  const voice = useVoiceRecorder(callInProgress);
  const cancelVoice = voice.cancel;
  const [voiceSending, setVoiceSending] = useState(false);

  async function startVoice() {
    if (callInProgress) {
      showToast({ kind: "error", message: "Voice messages can't be recorded during a call." });
      return;
    }
    const started = await voice.start();
    if (!started) {
      showToast({
        kind: "error",
        message: "Microphone access is needed for voice messages. Allow it in iOS Settings → Televo.",
      });
    }
  }

  const finishVoice = useCallback(async () => {
    if (voiceSending) return;
    setVoiceSending(true);
    try {
      const recording = await voice.finish();
      if (recording) await sendVoice(recording.uri, recording.durationMs, recording.waveform);
    } catch {
      showToast({ kind: "error", message: "Voice message couldn't be sent. Tap it to see details." });
    } finally {
      setVoiceSending(false);
    }
  }, [voice, voiceSending, sendVoice, showToast]);

  useEffect(() => {
    if (voice.isRecording && voice.durationMs >= VOICE_MAX_MS) void finishVoice();
  }, [voice.isRecording, voice.durationMs, finishVoice]);

  // A call starting mid-recording discards the recording (without touching
  // the audio mode — see useVoiceRecorder) so it can't fight the call's audio.
  useEffect(() => {
    if (callInProgress && voice.isRecording) void cancelVoice();
  }, [callInProgress, voice.isRecording, cancelVoice]);
  const {
    startEncryptedChat,
    peerKeyChanged,
    acknowledgeKeyChange,
    repairMissingSessionKeys,
    anySessionKeyExists,
    ready: e2eeReady,
  } = useE2ee();
  const keyChanged = isEncrypted && peerKeyChanged.has(id);
  // Two encryption tiers, deliberately not both shown the same way: every
  // chat is end-to-end encrypted the moment it can be (see the auto-encrypt
  // effect below) with no icon at all, because it's the invisible baseline
  // now, not a feature to advertise. A shield only appears once the safety
  // number has been explicitly compared and confirmed out of band — that's
  // the tier that actually rules out a man-in-the-middle, so it's the one
  // worth signaling.
  const [maxSecure, setMaxSecure] = useState(false);
  useEffect(() => {
    if (!isEncrypted || !conversation?.otherUserId) {
      setMaxSecure(false);
      return;
    }
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("e2e_public_key")
        .eq("id", conversation.otherUserId!)
        .single();
      if (!active) return;
      if (!data?.e2e_public_key) {
        setMaxSecure(false);
        return;
      }
      setMaxSecure(await isPeerKeyVerified(id, data.e2e_public_key));
    })();
    return () => {
      active = false;
    };
    // keyChanged forces a re-check: acknowledging a key change should drop
    // the shield until the NEW key is verified, not silently keep it lit.
  }, [isEncrypted, conversation?.otherUserId, id, keyChanged]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [isBlocked, setIsBlocked] = useState(false);
  const [editTarget, setEditTarget] = useState<ChatMessage | null>(null);
  const [messageSheetTarget, setMessageSheetTarget] = useState<ChatMessage | null>(null);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  // Set synchronously the instant a picker is requested, so a rapid second
  // tap can't open a second picker before the first one resolves.
  const pickerBusyRef = useRef(false);
  const [headerSheetOpen, setHeaderSheetOpen] = useState(false);
  const [selfDestructSheetOpen, setSelfDestructSheetOpen] = useState(false);
  const isAssistantChat = conversation?.otherUserId === ASSISTANT_USER_ID;
  // Group calls ring every member but only the first to answer connects and
  // the rest keep ringing, so the call buttons are hidden for groups until
  // that's fixed properly.
  const canCall =
    !isAssistantChat && conversation?.kind !== "group" && !conversation?.otherIsDeleted;

  // Secret Chat is opt-in, turned on only by an explicit user action (the
  // lock toggle in the chat header), never automatically. This used to
  // auto-encrypt every chat silently the moment it opened — no button to
  // press — which meant nobody actually knew which of their chats were
  // Secret Chats versus regular ones, since the answer was "eventually all
  // of them, silently." Removed 2026-09-19: regular chats are still
  // protected in transit and at rest (TLS + Supabase RLS), same as before —
  // this only removes the automatic, invisible upgrade to CLIENT-SIDE E2EE.
  // See handleEnableEncryption below for the explicit path that replaces it.

  // Companion to the (removed) auto-encrypt effect above: if the chat is
  // ALREADY encrypted (because the user explicitly turned it on) and this
  // device can decrypt in it, opportunistically top up any participant who's
  // missing their wrapped copy of the key (see repairMissingSessionKeys —
  // it only ever adds a row for someone who has none, never touches an
  // existing one, so it can't create the key mismatch a naive "just
  // re-encrypt" fix would). This is what actually recovers a chat where a
  // send previously failed with "No encryption key available": the NEXT
  // device to open it (whichever one still holds the real key) fixes it for
  // whoever is missing a copy.
  //
  useEffect(() => {
    if (!id || !isEncrypted || !e2eeReady) return;
    void repairMissingSessionKeys(id).catch((caught) => {
      // eslint-disable-next-line no-console
      console.error("[repairMissingSessionKeys] unexpected failure:", caught);
    });
  }, [id, isEncrypted, e2eeReady, repairMissingSessionKeys]);

  // If NO PARTICIPANT holds a working key at all — is_encrypted=true but
  // every encrypted_session_keys row for this conversation is gone (e.g.
  // every participant's local keypair changed since the rows were wrapped),
  // repairMissingSessionKeys can't help either: it also starts from
  // loadSessionKey, which fails the same way for everyone. That state can
  // only be recovered by starting encryption over from zero.
  //
  // Real incident (2026-09-19): this used to gate on hasWorkingSessionKey,
  // which only answers "can THIS device decrypt" — not "does anyone have a
  // working key." A device that lost its own keypair (a reinstall) but
  // whose PEER still had a perfectly good session key would see
  // hasWorkingSessionKey resolve false, conclude (per this effect's own,
  // now-corrected-below assumption) that no key existed anywhere, and mint
  // a brand new one via startEncryptedChat. The peer's existing row is never
  // touched by that (deposit only ever ADDS a missing row), so the two
  // devices ended up on two different, mutually undecryptable keys —
  // exactly the "Unable to decrypt for everyone, not just me" report, and it
  // reproduced identically after a manual database repair, because this
  // effect re-triggered the same mistake the next time the affected device
  // opened the chat. anySessionKeyExists checks the table directly — does
  // ANY row exist for this conversation, from ANY participant — which is
  // the question that's actually safe to act on: only truly zero rows
  // anywhere justifies minting a replacement.
  const reinitAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !conversation || isAssistantChat || !isEncrypted || !e2eeReady) return;
    if (reinitAttempted.current === id) return;

    void anySessionKeyExists(id).then((exists) => {
      if (exists || reinitAttempted.current === id) return;
      reinitAttempted.current = id;
      void startEncryptedChat(id, conversation.otherUserId ?? undefined).catch(() => {
        // Same as the not-yet-encrypted path: expected if a participant
        // hasn't published a key, not a user-facing failure.
      });
    });
  }, [id, conversation, isAssistantChat, isEncrypted, e2eeReady, anySessionKeyExists, startEncryptedChat]);

  const [enablingEncryption, setEnablingEncryption] = useState(false);

  // The explicit, user-initiated replacement for the auto-encrypt effect
  // removed above. Only reachable from buildHeaderSheetOptions, and only
  // shown for a direct chat that isn't encrypted yet — so this is always a
  // deliberate "turn this chat into a Secret Chat" decision, never a side
  // effect of merely opening the chat.
  async function handleEnableEncryption() {
    if (!id || !conversation || enablingEncryption) return;
    setEnablingEncryption(true);
    try {
      await startEncryptedChat(id, conversation.otherUserId ?? undefined);
      await refreshConversation();
      showToast({ kind: "success", message: "Secret Chat turned on for this conversation." });
    } catch (caught) {
      // Most commonly: the other person hasn't opened a version of the app
      // that publishes an encryption key yet. Named plainly rather than
      // swallowed, since this is now a direct response to a button tap, not
      // a background retry loop that gets another chance next time.
      showToast({
        kind: "error",
        message:
          caught instanceof Error
            ? caught.message
            : "Couldn't turn on Secret Chat. Try again in a moment.",
      });
    } finally {
      setEnablingEncryption(false);
    }
  }

  function handleDisableEncryptionBlocked() {
    // A Secret Chat is deliberately one-way (scripts/sql/016_harden_encryption
    // _and_edit.sql, "AUDIT FIX 1"): a server trigger rejects flipping
    // is_encrypted back to false. That fix exists because without it, a peer
    // could silently downgrade the OTHER person's chat to plaintext — the
    // victim's next message would go out unencrypted with no warning beyond
    // a lock icon quietly disappearing. Turning that off on request would
    // reopen exactly that hole, so this explains the trade-off instead of
    // trying (and failing at the database) to disable it.
    Alert.alert(
      "Secret Chats can't be turned off",
      "Once end-to-end encryption is on for a chat, it stays on — for both of you. This is intentional: without it, either person could silently downgrade the other's chat back to plaintext with no warning. To go back to a regular chat, start a new conversation instead."
    );
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
    isUserBlocked(user.id, conversation.otherUserId).then(setIsBlocked).catch(() => setIsBlocked(false));
  }, [user?.id, conversation?.kind, conversation?.otherUserId]);

  // Blocking is bidirectional server-side, so once either side blocks, every
  // send fails at RLS. Previously the composer stayed fully enabled and the
  // message just turned into a red "failed" bubble with no explanation.
  // A deleted account (conversation.otherIsDeleted — 063_soft_delete_account.sql)
  // is the same shape of dead end, enforced server-side by
  // enforce_ban_on_message: the old conversation history stays visible, new
  // messages just fail, so this disables the composer the same way blocking
  // does rather than letting the user hit that error.
  const composerDisabled = isBlocked || !!conversation?.otherIsDeleted;

  function handleBlockToggle() {
    if (!user?.id || !conversation?.otherUserId) return;
    const name = conversation.title || "this person";

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

  // "Delete for me": hides the chat from THIS account's list only (sets
  // deleted_at on this device's own conversation_participants row — see
  // 048_delete_chat.sql). Every message and the other participant's own
  // view of the chat are untouched; it un-hides itself the next time either
  // side sends a message (useChats.ts's realtime handler clears deleted_at
  // on receipt).
  function handleDeleteForMe() {
    if (!id || !user?.id) return;
    Alert.alert(
      "Delete this chat?",
      "It will be removed from your chat list. The other person keeps their copy, and it comes back if either of you sends a new message.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete for me",
          style: "destructive",
          onPress: async () => {
            const { error } = await supabase
              .from("conversation_participants")
              .update({ deleted_at: new Date().toISOString() })
              .eq("conversation_id", id)
              .eq("user_id", user.id);
            if (error) {
              Alert.alert("Couldn't delete chat", error.message);
              return;
            }
            router.back();
          },
        },
      ]
    );
  }

  // "Delete for both": permanently removes the conversation row, which
  // cascades (existing FKs, not new) to every message, session key, and
  // call record tied to it — for EVERY participant, not just this device.
  // Irreversible, unlike delete-for-me, so the confirmation says so plainly
  // rather than using the same wording as the softer option above.
  function handleDeleteForBoth() {
    if (!id || !conversation) return;
    const name = conversation.title || "this person";
    Alert.alert(
      "Delete for everyone?",
      `This permanently deletes the entire conversation with ${name} — every message, for both of you. This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete for everyone",
          style: "destructive",
          onPress: async () => {
            const { error } = await supabase.from("conversations").delete().eq("id", id);
            if (error) {
              Alert.alert("Couldn't delete chat", error.message);
              return;
            }
            router.back();
          },
        },
      ]
    );
  }

  function handleOpenSelfDestructMenu() {
    setSelfDestructSheetOpen(true);
  }

  function buildSelfDestructOptions(): ActionSheetOption[] {
    if (!id) return [];
    return SELF_DESTRUCT_OPTIONS.map((option) => ({
      key: option.label,
      label: option.label,
      icon: option.seconds === null ? "close-circle-outline" : "timer-outline",
      onPress: () => {
        void supabase
          .from("conversations")
          .update({ self_destruct_seconds: option.seconds })
          .eq("id", id)
          .then(() => refreshConversation());
      },
    }));
  }

  function handleHeaderMenu() {
    setHeaderSheetOpen(true);
  }

  function buildHeaderSheetOptions(): ActionSheetOption[] {
    const options: ActionSheetOption[] = [];

    if (isEncrypted && conversation?.otherUserId) {
      options.push({
        key: "verify",
        label: "Verify encryption",
        icon: "shield-checkmark-outline",
        onPress: () => {
          router.push({
            pathname: "/verify-safety-number" as never,
            params: {
              peerId: conversation.otherUserId!,
              peerName: conversation.title || "this person",
              conversationId: id,
            },
          });
        },
      });
    }

    if (isEncrypted) {
      options.push({
        key: "self-destruct",
        label: "Self-Destruct Timer",
        icon: "timer-outline",
        onPress: handleOpenSelfDestructMenu,
      });
      options.push({
        key: "disable-encryption",
        label: "Turn off Secret Chat",
        icon: "lock-open-outline",
        onPress: handleDisableEncryptionBlocked,
      });
    } else if (conversation?.kind === "direct" && !isAssistantChat) {
      // The explicit opt-in that replaces the old silent auto-encrypt
      // effect — Secret Chat only ever turns on because someone tapped
      // this. Not offered for groups: startEncryptedChat supports it, but
      // there's no group management UI yet for what happens when a member
      // without a published key joins later.
      options.push({
        key: "enable-encryption",
        label: enablingEncryption ? "Turning on Secret Chat…" : "Enable Secret Chat",
        icon: "lock-closed-outline",
        onPress: handleEnableEncryption,
      });
    }
    if (conversation?.kind === "direct") {
      options.push({
        key: "block",
        label: isBlocked ? "Unblock" : "Block",
        icon: isBlocked ? "checkmark-circle-outline" : "ban-outline",
        destructive: !isBlocked,
        onPress: handleBlockToggle,
      });
    }
    if (!isAssistantChat) {
      options.push({
        key: "delete-for-me",
        label: "Delete for me",
        icon: "trash-outline",
        destructive: true,
        onPress: handleDeleteForMe,
      });
      if (conversation?.kind === "direct") {
        options.push({
          key: "delete-for-both",
          label: "Delete for everyone",
          icon: "trash-outline",
          destructive: true,
          onPress: handleDeleteForBoth,
        });
      }
    }
    return options;
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
        try {
          await sendMessage(body, replyTarget?.id ?? null);
        } catch (caught) {
          // This device has no wrapped copy of the conversation's session
          // key, so it cannot encrypt (some other device holds the real
          // key). Minting a NEW key here would desync everyone who already
          // has the real one — the repairMissingSessionKeys effect above is
          // the actual fix, and it runs the moment any device that DOES hold
          // the key opens this chat. Nothing safe to retry from this side
          // right now, so surface a specific reason instead of a generic
          // failed bubble with no explanation.
          if (caught instanceof MissingSessionKeyError) {
            showToast({
              kind: "error",
              message: "Can't send yet",
              detail:
                "This device is still catching up on this chat's encryption. Ask the other person to open this chat once.",
            });
          }
          throw caught;
        }
        setReplyTarget(null);
        notifyStoppedTyping();
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
    // pickerBusyRef, not `attaching`: `attaching` is only set once the
    // picker RESOLVES, so a second tap in the meantime slipped through and
    // launched a second picker ("Different document picking in progress").
    if (pickerBusyRef.current) return;
    pickerBusyRef.current = true;
    try {

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo access needed",
        "Allow photo library access to send images, or enable it in Settings."
      );
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        quality: 0.7,
      });
    if (picked.canceled || !picked.assets?.[0]) return;

      const asset = picked.assets[0];
      setAttaching(true);
      try {
        await sendImage(asset.uri, asset.type === "video" ? "video" : "image");
      } catch (caught) {
        // Toast rather than Alert: an upload failure is transient and
        // recoverable, and a modal here blocks the conversation to deliver
        // news the user can act on without leaving the screen.
        if (caught instanceof MissingSessionKeyError) {
          showToast({
            kind: "error",
            message: "Can't send yet",
            detail:
              "This device is still catching up on this chat's encryption. Ask the other person to open this chat once.",
          });
        } else {
          showToast({
            kind: "error",
            message: "Upload failed",
            detail: caught instanceof Error ? caught.message : "Please try again.",
          });
        }
      } finally {
        setAttaching(false);
      }
    } finally {
      pickerBusyRef.current = false;
    }
  }

  async function handleAttachDocument() {
    if (pickerBusyRef.current) return;
    pickerBusyRef.current = true;
    try {

    const picked = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets?.[0]) return;

      const asset = picked.assets[0];
      setAttaching(true);
      try {
        await sendDocument(asset.uri, asset.name, asset.size ?? 0);
      } catch (caught) {
        // Toast rather than Alert: an upload failure is transient and
        // recoverable, and a modal here blocks the conversation to deliver
        // news the user can act on without leaving the screen.
        if (caught instanceof MissingSessionKeyError) {
          showToast({
            kind: "error",
            message: "Can't send yet",
            detail:
              "This device is still catching up on this chat's encryption. Ask the other person to open this chat once.",
          });
        } else {
          showToast({
            kind: "error",
            message: "Upload failed",
            detail: caught instanceof Error ? caught.message : "Please try again.",
          });
        }
      } finally {
        setAttaching(false);
      }
    } finally {
      pickerBusyRef.current = false;
    }
  }

  // useCallback, not a plain function: this is passed to every MessageBubble,
  // and a new identity each render defeats the bubble's memo comparator —
  // which would re-render the whole visible list on every keystroke.
  const handleMessageLongPress = useCallback((message: ChatMessage) => {
    setMessageSheetTarget(message);
  }, []);

  // Chat-wide list of photos/videos, newest-first (matches `messages`),
  // so the full-screen viewer can page between every visual message in
  // this conversation, not just the one that was tapped.
  const mediaItems = useMemo<MediaViewerItem[]>(
    () =>
      messages
        .filter(
          (m): m is ChatMessage & { media_url: string } =>
          (m.kind === "image" || m.kind === "video") && !!m.media_url
        )
        .map((m) => ({ id: m.id, path: m.media_url, kind: m.kind as "image" | "video" })),
    [messages]
  );
  const [viewerMessageId, setViewerMessageId] = useState<string | null>(null);
  const handleOpenMedia = useCallback((messageId: string) => {
    setViewerMessageId(messageId);
  }, []);

  // App Store Guideline 1.2 requires a way to report offensive content in
  // any app with user-generated content. Snapshots the body because the
  // message may be deleted before the report is reviewed.
  function handleReportMessage(message: ChatMessage) {
    if (!user?.id) return;
    const reasons: { key: string; label: string }[] = [
      { key: "spam", label: "Spam" },
      { key: "harassment", label: "Harassment or bullying" },
      { key: "inappropriate", label: "Inappropriate content" },
      { key: "violence", label: "Violence or threats" },
      { key: "other", label: "Something else" },
    ];

    Alert.alert(
      "Report message",
      "Tell us what's wrong. We review every report and act on it.",
      [
        ...reasons.map((reason) => ({
          text: reason.label,
          onPress: () => {
            void supabase
              .from("content_reports")
              .insert({
                reporter_id: user.id,
                reported_user_id: message.sender_id,
                message_id: message.id,
                conversation_id: message.conversation_id,
                reason: reason.key,
                // Only ever the PLAINTEXT the reporter actually saw. Gating on
                // `isEncrypted` (the conversation), not on
                // `decryptedBody === undefined`: undefined also means "this
                // IS an encrypted chat, but the async decorateWithDecryption
                // pass over a just-arrived realtime row hasn't resolved yet"
                // — a narrow but real window where `body` is still the raw
                // ciphertext envelope. Falling through to it there reintroduced
                // the exact leak this fallback exists to prevent. See the
                // identical reply-quote / edit-target rule elsewhere in this
                // file for the same distinction.
                reported_content: isEncrypted ? (message.decryptedBody ?? null) : message.body,
              })
              .then(({ error }) => {
                Alert.alert(
                  error ? "Couldn't send report" : "Report sent",
                  error
                    ? error.message
                    : "Thanks — this has been sent to us for review. You can also block this person."
                );
              });
          },
        })),
        { text: "Cancel", style: "cancel" as const },
      ]
    );
  }

  function buildMessageSheetOptions(message: ChatMessage): ActionSheetOption[] {
    const isOwn = message.sender_id === user?.id;
    const canEdit = isOwn && message.kind === "text";

    const options: ActionSheetOption[] = [
      {
        key: "reply",
        label: "Reply",
        icon: "arrow-undo-outline",
        onPress: () => {
          setEditTarget(null);
          setReplyTarget(message);
        },
      },
      {
        key: "forward",
        label: "Forward",
        icon: "arrow-redo-outline",
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

    if (!isOwn) {
      options.push({
        key: "report",
        label: "Report",
        icon: "flag-outline",
        destructive: true,
        onPress: () => handleReportMessage(message),
      });
    }

    if (canEdit) {
      options.push({
        key: "edit",
        label: "Edit",
        icon: "pencil-outline",
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
        key: "delete",
        label: "Delete",
        icon: "trash-outline",
        destructive: true,
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

    return options;
  }

  // || not ??: useConversation briefly publishes an empty-string title for a
  // direct chat (profile name/avatar arrive in a later, non-blocking
  // follow-up — see its own comment) — an empty string is falsy but not
  // nullish, so `?? "Chat"` would have let it straight through blank instead
  // of falling back for that one render.
  const title = conversation?.title || "Chat";

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
        <Pressable
          style={styles.headerIdentity}
          disabled={(conversation?.kind !== "group" && !conversation?.otherUserId) || isAssistantChat}
          onPress={() => {
            if (conversation?.kind === "group") {
              router.push({ pathname: "/group-info" as never, params: { conversationId: id } });
            } else if (conversation?.otherUserId) {
              router.push({
                pathname: "/user-profile" as never,
                params: { userId: conversation.otherUserId, conversationId: id },
              });
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={conversation?.kind === "group" ? `${title} group info` : `View ${title}'s profile`}
        >
          <Avatar name={title} uri={conversation?.avatarUrl ?? null} size={38} />
          <View style={styles.headerText}>
            <View style={styles.headerTitleRow}>
              {maxSecure ? (
                <Ionicons
                  name="shield-checkmark"
                  size={13}
                  color={theme.online}
                  style={styles.lockIcon}
                />
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
        </Pressable>
        {/* A bot has no voice/video, nothing to block, and no self-destruct
            menu worth showing — only calling/block/encryption are hidden.
            Group calls are hidden too (see canCall above). */}
        {canCall ? (
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
          </>
        ) : null}
        {!isAssistantChat ? (
          <Pressable
            onPress={handleHeaderMenu}
            accessibilityRole="button"
            accessibilityLabel="Chat options"
            hitSlop={10}
            style={styles.headerAction}
          >
            <Ionicons name="ellipsis-vertical" size={20} color={theme.accent} />
          </Pressable>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        {keyChanged ? (
          <View style={[styles.keyChangedBanner, { backgroundColor: theme.danger }]}>
            <Ionicons name="warning-outline" size={16} color="#FFFFFF" />
            <Text style={styles.keyChangedText}>
              {title}'s encryption key changed. This can happen after a reinstall — or it can mean
              someone intercepted this chat.
            </Text>
            <Pressable
              onPress={() => {
                if (conversation?.otherUserId) {
                  router.push({
                    pathname: "/verify-safety-number" as never,
                    params: { peerId: conversation.otherUserId, peerName: title, conversationId: id },
                  });
                }
              }}
              hitSlop={8}
            >
              <Text style={styles.keyChangedAction}>Verify</Text>
            </Pressable>
            <Pressable onPress={() => acknowledgeKeyChange(id)} hitSlop={8}>
              <Ionicons name="close" size={18} color="#FFFFFF" />
            </Pressable>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
          </View>
        ) : (
          <View style={styles.flex}>
            {pinnedDateLabel ? (
              <View style={styles.pinnedDateWrap} pointerEvents="none">
                <View style={[styles.dateSeparatorPill, { backgroundColor: theme.surfaceElevated }]}>
                  <Text style={[styles.dateSeparatorText, { color: theme.textSecondary }]}>
                    {pinnedDateLabel}
                  </Text>
                </View>
              </View>
            ) : null}
            <FlatList
            // Newest-first data rendered bottom-up, so new messages appear at
            // the bottom without manual scrolling.
            inverted
            data={rows}
            keyExtractor={(row) => (row.type === "separator" ? `sep-${row.dateKey}` : row.message.id)}
            contentContainerStyle={styles.list}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            // The list is inverted, so "end" is the OLDEST message — this is
            // what loads older history instead of hitting a wall at 50.
            onEndReached={() => void loadOlder()}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              hasMore ? (
                <ActivityIndicator color={theme.accent} style={styles.olderLoader} />
              ) : null
            }
            ListEmptyComponent={
              <View style={[styles.center, styles.emptyInverted]}>
                <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                  No messages yet. Say hello.
                </Text>
              </View>
            }
            // Virtualization tuning. The defaults render a large window and
            // never release offscreen rows, which on a long history means
            // hundreds of live bubbles — each holding image/video state.
            windowSize={9}
            maxToRenderPerBatch={10}
            initialNumToRender={14}
            updateCellsBatchingPeriod={40}
            removeClippedSubviews
            renderItem={({ item: row, index }) => {
              if (row.type === "separator") {
                return (
                  <View style={styles.dateSeparator} pointerEvents="none">
                    <View style={[styles.dateSeparatorPill, { backgroundColor: theme.surfaceElevated }]}>
                      <Text style={[styles.dateSeparatorText, { color: theme.textSecondary }]}>
                        {row.label}
                      </Text>
                    </View>
                  </View>
                );
              }
              const item = row.message;
              const repliedTo = item.reply_to_id ? messagesById.get(item.reply_to_id) : null;
              const replyPreview = repliedTo
                ? {
                    senderName: participantNames[repliedTo.sender_id] ?? "Someone",
                    text:
                      // decryptedBody is undefined for a plaintext message (use
                      // body), null when this device couldn't decrypt it — in
                      // that case `body` is still the raw ciphertext envelope,
                      // so it must never be shown as if it were text.
                      repliedTo.decryptedBody !== undefined
                        ? (repliedTo.decryptedBody ?? "🔒 Unable to decrypt")
                        : (repliedTo.body ??
                          (repliedTo.kind === "image"
                            ? "Photo"
                            : repliedTo.kind === "document"
                              ? (repliedTo.document_name ?? "Document")
                              : "Message")),
                  }
                : null;

              const forwardedFrom = item.forwarded_from_sender_id
                ? { senderName: participantNames[item.forwarded_from_sender_id] ?? "Someone" }
                : null;

              // The list is inverted, so rows[index + 1] is the message just
              // above this one. Name the sender on the first message of each
              // run, the way Telegram does, rather than on every bubble.
              const isOwn = item.sender_id === user?.id;
              const above = rows[index + 1];
              const startsRun =
                !above ||
                above.type !== "message" ||
                above.message.kind === "system" ||
                above.message.sender_id !== item.sender_id;
              const senderName =
                conversation?.kind === "group" && !isOwn && item.kind !== "system" && startsRun
                  ? (participantNames[item.sender_id] ?? "Former member")
                  : null;

              return (
                <MessageBubble
                  message={item}
                  isOwn={isOwn}
                  senderName={senderName}
                  onLongPress={item.kind === "system" ? undefined : handleMessageLongPress}
                  replyPreview={replyPreview}
                  forwardedFrom={forwardedFrom}
                  peerLastReadAt={peerLastReadAt}
                  onRetryDecryption={retryDecryption}
                  onRetrySend={retrySend}
                  onOpenMedia={handleOpenMedia}
                />
              );
            }}
            />
          </View>
        )}

        {replyTarget || editTarget ? (
          <View style={[styles.replyBar, { backgroundColor: theme.surfaceElevated, borderTopColor: theme.border }]}>
            <View style={[styles.replyAccent, { backgroundColor: theme.accent }]} />
            <View style={styles.replyTextBlock}>
              <Text style={[styles.replyLabel, { color: theme.accent }]}>
                {editTarget ? "Editing message" : "Reply"}
              </Text>
              <Text style={[styles.replyPreview, { color: theme.textSecondary }]} numberOfLines={1}>
                {(() => {
                  const target = editTarget ?? replyTarget;
                  // Same rule as the reply-quote above: never fall through to
                  // the raw ciphertext envelope in `body` for an encrypted
                  // message that failed to decrypt.
                  if (target?.decryptedBody !== undefined) {
                    return target?.decryptedBody ?? "🔒 Unable to decrypt";
                  }
                  return (
                    target?.body ??
                    ((target?.kind === "image" && "Photo") ||
                      (target?.kind === "document" && target?.document_name) ||
                      "Message")
                  );
                })()}
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
          {voice.isRecording || voiceSending ? (
            <>
              <Pressable
                onPress={() => void voice.cancel()}
                disabled={voiceSending}
                accessibilityRole="button"
                accessibilityLabel="Discard voice message"
                hitSlop={8}
                style={styles.attach}
              >
                <Ionicons name="trash-outline" size={24} color={theme.danger} />
              </Pressable>
              <View style={[styles.recordingBar, { backgroundColor: theme.surfaceElevated }]}>
                <View style={[styles.recordingDot, { backgroundColor: theme.danger }]} />
                <Text style={[styles.recordingTime, { color: theme.text }]}>
                  {`${Math.floor(voice.durationMs / 60000)}:${String(Math.floor(voice.durationMs / 1000) % 60).padStart(2, "0")}`}
                </Text>
                <View style={[styles.recordingTrack, { backgroundColor: theme.border }]}>
                  <View
                    style={[
                      styles.recordingLevel,
                      { width: `${Math.round(8 + voice.level * 92)}%`, backgroundColor: theme.accent },
                    ]}
                  />
                </View>
              </View>
              <Pressable
                onPress={() => void finishVoice()}
                disabled={voiceSending}
                accessibilityRole="button"
                accessibilityLabel="Send voice message"
                style={({ pressed }) => [styles.send, { backgroundColor: theme.accent, opacity: pressed ? 0.8 : 1 }]}
              >
                {voiceSending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
                )}
              </Pressable>
            </>
          ) : (
            <>
          <Pressable
            onPress={() => setAttachSheetOpen(true)}
            disabled={attaching || composerDisabled}
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
            editable={!composerDisabled}
            onChangeText={(text) => {
              setDraft(text);
              notifyTyping();
            }}
            placeholder={
              conversation?.otherIsDeleted
                ? "This account has been deleted"
                : composerDisabled
                  ? "You blocked this person"
                  : "Message"
            }
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.input,
              { backgroundColor: theme.surfaceElevated, color: theme.text },
            ]}
            multiline
            accessibilityLabel="Message text"
          />
          {!draft.trim() && !composerDisabled && !isAssistantChat ? (
            <Pressable
              onPress={() => void startVoice()}
              accessibilityRole="button"
              accessibilityLabel="Record voice message"
              style={({ pressed }) => [
                styles.send,
                { backgroundColor: theme.surfaceElevated, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Ionicons name="mic-outline" size={22} color={theme.accent} />
            </Pressable>
          ) : (
          <Pressable
            onPress={handleSend}
            disabled={!draft.trim() || sending || composerDisabled}
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
              name="arrow-up"
              size={20}
              color={draft.trim() ? "#FFFFFF" : theme.textSecondary}
            />
          </Pressable>
          )}
            </>
          )}
        </View>
      </KeyboardAvoidingView>

      {viewerMessageId ? (
        <MediaViewer
          items={mediaItems}
          initialIndex={Math.max(
            0,
            mediaItems.findIndex((m) => m.id === viewerMessageId)
          )}
          conversationId={id ?? ""}
          onClose={() => setViewerMessageId(null)}
        />
      ) : null}

      <ActionSheet
        visible={!!messageSheetTarget}
        onClose={() => setMessageSheetTarget(null)}
        options={messageSheetTarget ? buildMessageSheetOptions(messageSheetTarget) : []}
      />

      <ActionSheet
        visible={attachSheetOpen}
        onClose={() => setAttachSheetOpen(false)}
        options={[
          {
            key: "photo",
            label: "Photo or video",
            icon: "image-outline",
            onPress: () => void handleAttachImage(),
          },
          {
            key: "document",
            label: "Document",
            icon: "document-text-outline",
            onPress: () => void handleAttachDocument(),
          },
        ]}
      />

      <ActionSheet
        visible={headerSheetOpen}
        onClose={() => setHeaderSheetOpen(false)}
        title={conversation?.title}
        options={buildHeaderSheetOptions()}
      />

      <ActionSheet
        visible={selfDestructSheetOpen}
        onClose={() => setSelfDestructSheetOpen(false)}
        title="Messages you send will disappear for both people after this long"
        options={buildSelfDestructOptions()}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  keyChangedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  keyChangedText: { flex: 1, color: "#FFFFFF", fontSize: 12.5, lineHeight: 16 },
  keyChangedAction: { color: "#FFFFFF", fontWeight: "700", fontSize: 13 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerIdentity: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
  recordingBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 40,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
  },
  recordingDot: { width: 10, height: 10, borderRadius: 5 },
  recordingTime: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"], minWidth: 42 },
  recordingTrack: { flex: 1, height: 4, borderRadius: 2, overflow: "hidden" },
  recordingLevel: { height: 4, borderRadius: 2 },
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
  olderLoader: { paddingVertical: spacing.md },
  dateSeparator: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  dateSeparatorPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  dateSeparatorText: {
    fontSize: 12,
    fontWeight: "600",
  },
  pinnedDateWrap: {
    position: "absolute",
    top: spacing.sm,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 1,
  },
});
