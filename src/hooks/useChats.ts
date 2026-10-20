import { useCallback, useEffect, useRef, useState } from "react";

import { ASSISTANT_USER_ID } from "../lib/assistant";
import { parseEnvelope } from "../lib/e2e";
import { describeGroupEvent } from "../lib/groupEvents";
import { readChatListCache, writeChatListCache } from "../lib/localMessages";
import { restoreOutbox } from "../lib/outbox";
import { supabase } from "../lib/supabase";
import { onUserChannelResync, subscribeUserEvents } from "../lib/userChannel";
import type { Database } from "../types/database";
import { useE2ee } from "./useE2ee";
import { getCurrentConversationId } from "../lib/currentChat";

type ConversationKind = Database["public"]["Enums"]["conversation_kind"];
type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

export type ChatSummary = {
  id: string;
  kind: ConversationKind;
  /** Group title, or the other person's name for a direct chat. */
  title: string;
  avatarUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  /** True when the last message was sent by the signed-in user — only then
   * is a read receipt meaningful to show. */
  lastMessageIsOwn: boolean;
  /** Whether the other participant has read the last message. Direct chats
   * only — "read" has no single answer in a group. */
  lastMessageRead: boolean | null;
  /** Whether this is a Secret Chat (end-to-end encrypted). Shown as a lock
   * next to the chat name in the list — without this, the ONLY place a
   * Secret Chat was visually distinguishable from a regular one was the 🔒
   * that appears inside a message bubble, and only ever when decryption had
   * ALREADY failed. That reads as an error indicator, not "this conversation
   * type is different", which is why a user could look at their own chat
   * list and not be able to tell which chats were even encrypted in the
   * first place. */
  isEncrypted: boolean;
};

/**
 * Loads the signed-in user's conversations with their last message and unread
 * count, and keeps the list live as new messages arrive.
 */
export function useChats(userId: string | undefined) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // Latest list for callbacks (cache paint, live updates) without making
  // them depend on it.
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { decryptForConversation, ready: e2eeReady, repairAllSessionKeys } = useE2ee();

  // Messages still queued when the app was last closed go out from launch,
  // not only once their chat is opened again (src/lib/outbox.ts).
  useEffect(() => {
    if (userId) void restoreOutbox(userId);
  }, [userId]);

  // Top up any peer who is missing their wrapped copy of a session key, in
  // every encrypted chat this device holds a key for.
  //
  // A participant with no key row cannot repair it themselves — repair
  // starts from loadSessionKey, which is exactly what fails for them, so
  // only a peer who still holds the key can re-deposit it. Until now the
  // only trigger was opening that specific chat (app/chat/[id].tsx), which
  // meant a conversation could stay unreadable for one side indefinitely
  // while looking completely normal to the other. Running it here means
  // simply opening the app repairs everything this device can reach.
  //
  // Once per mount, after the keypair is loaded. See repairAllSessionKeys
  // for the cost argument (a no-op RPC per conversation in steady state).
  const sweptRef = useRef(false);
  useEffect(() => {
    if (!userId || !e2eeReady || sweptRef.current) return;
    sweptRef.current = true;
    void repairAllSessionKeys().catch((caught) => {
      // eslint-disable-next-line no-console
      console.error("[useChats] session key sweep failed:", caught);
    });
  }, [userId, e2eeReady, repairAllSessionKeys]);

  const load = useCallback(async () => {
    if (!userId) {
      setChats([]);
      setLoading(false);
      return;
    }

    setError(null);

    // First load: paint the list as it was last time, straight from disk —
    // instant on launch, and the only list there is with no connection.
    if (chatsRef.current.length === 0) {
      try {
        const cachedList = await readChatListCache(userId);
        if (cachedList && chatsRef.current.length === 0) {
          const parsed = JSON.parse(cachedList) as ChatSummary[];
          if (parsed.length > 0) {
            setChats(parsed);
            setLoading(false);
          }
        }
      } catch {
        // no cache yet — the server load below fills it
      }
    }

    // Conversations the user participates in. Note: conversation_participants
    // .user_id references auth.users, not public.profiles, so PostgREST can't
    // embed profiles here — they're fetched separately below.
    const { data, error: queryError } = await supabase
      .from("conversation_participants")
      .select(
        `
        conversation_id,
        last_read_at,
        conversations!inner (
          id,
          kind,
          title,
          updated_at,
          is_encrypted,
          conversation_participants ( user_id, last_read_at )
        )
      `
      )
      .eq("user_id", userId)
      // "Delete for me" (048_delete_chat.sql) sets this on the caller's own
      // participant row only — the other participant's row, and every
      // message, is untouched. Excluding it here is the entire client-side
      // effect of that delete: the chat simply stops appearing in this
      // list. A NEW message arriving un-hides it again — the database
      // clears deleted_at as the message is stored
      // (077_realtime_user_channels.sql) — so a chat someone messages you
      // in again after you'd deleted it comes back.
      .is("deleted_at", null);

    if (queryError) {
      // Offline with the cached list on screen: keep it, no error.
      if (chatsRef.current.length === 0) setError(queryError.message);
      setLoading(false);
      return;
    }

    const rows = data ?? [];
    const conversationIds = rows.map((row) => row.conversation_id);

    // Resolve the other participants' profiles in one query.
    const otherUserIds = Array.from(
      new Set(
        rows.flatMap((row) =>
          (row.conversations.conversation_participants ?? [])
            .map((participant) => participant.user_id)
            .filter((id) => id !== userId)
        )
      )
    );

    const profilesById = new Map<
      string,
      { display_name: string; username: string; avatar_url: string | null }
    >();

    if (otherUserIds.length > 0) {
      const { data: profileRows } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", otherUserIds);

      for (const profile of profileRows ?? []) {
        profilesById.set(profile.id, {
          display_name: profile.display_name,
          username: String(profile.username),
          avatar_url: profile.avatar_url,
        });
      }
    }

    // Fetch recent messages for these conversations in one round trip, then
    // reduce to "latest per conversation" and count unread on the client.
    let messagesByConversation = new Map<
      string,
      {
        body: string | null;
        kind: Database["public"]["Enums"]["message_kind"];
        created_at: string;
        sender_id: string;
      }[]
    >();

    // Exact unread counts and one latest message per conversation, computed
    // server-side (see 031_chat_list_summary.sql). This replaced fetching the
    // 500 newest messages across every conversation and reducing here: that
    // budget was global, so a few busy chats consumed all of it and quieter
    // ones came back empty — rendering "No messages yet" and a zero unread
    // badge on chats that had neither.
    const unreadByConversation = new Map<string, number>();

    if (conversationIds.length > 0) {
      const { data: summaryRows, error: summaryError } = await supabase.rpc("chat_list_summary");

      // Reported, not thrown. load() runs from realtime callbacks and effects
      // that don't catch, so throwing here left `loading` stuck true forever —
      // a permanently spinning chat list with no way back. Previews and unread
      // badges simply stay empty for this pass; the next refresh recovers.
      if (summaryError) {
        if (chatsRef.current.length === 0) setError(summaryError.message);
        setLoading(false);
        return;
      }

      for (const summary of summaryRows ?? []) {
        unreadByConversation.set(summary.conversation_id, summary.unread_count);
        if (!summary.last_message_at) continue;
        messagesByConversation.set(summary.conversation_id, [
          {
            body: summary.last_message_body,
            kind: summary.last_message_kind,
            created_at: summary.last_message_at,
            sender_id: summary.last_message_sender_id,
          },
        ]);
      }
    }

    // Decrypting is only worth doing for the one message actually shown per
    // chat (the latest), not all 500 fetched for the unread count — and only
    // for chats that are encrypted at all. loadSessionKey/decryptForConversation
    // cache the key after the first call, so re-opening the list is cheap.
    const encryptedConversationIds = new Set(
      rows.filter((row) => row.conversations.is_encrypted).map((row) => row.conversation_id)
    );
    const previewByConversation = new Map<string, string | null>();
    await Promise.all(
      Array.from(encryptedConversationIds).map(async (conversationId) => {
        const latest = messagesByConversation.get(conversationId)?.[0];
        if (!latest || latest.kind !== "text" || !latest.body) return;
        const envelope = parseEnvelope(latest.body);
        if (!envelope) return; // pre-encryption plaintext history — leave as is
        const decrypted = await decryptForConversation(conversationId, latest.body);
        // Only claim a message is undecryptable once the device key is
        // actually loaded. This list renders on app start, before
        // E2eeProvider has finished reading the keypair out of secure
        // storage, so an early failure here means "not ready yet", not
        // "broken" — labelling it as broken is what made every preview read
        // "Unable to decrypt" until the chat was opened once.
        previewByConversation.set(
          conversationId,
          decrypted ?? (e2eeReady ? "🔒 Unable to decrypt" : "🔒 Message")
        );
      })
    );

    const summaries: ChatSummary[] = rows
      .filter((row) => {
        const participants = row.conversations.conversation_participants ?? [];
        const others = participants.filter((participant) => participant.user_id !== userId);
        // A direct conversation whose other participant's account no longer
        // exists (deleted, or a row that never landed) rendered as a dead
        // "Unknown" entry with nothing to open — hide it instead of showing
        // it as if it were a real, message-able contact.
        if (row.conversations.kind === "direct" && others.length === 0) return false;
        // The Televo Assistant's Anthropic org is on hold, so it's hidden
        // from the chat list until that's resolved (see src/lib/assistant.ts).
        return !(
          row.conversations.kind === "direct" &&
          others.length === 1 &&
          others[0].user_id === ASSISTANT_USER_ID
        );
      })
      .map((row) => {
      const conversation = row.conversations;
      const participants = conversation.conversation_participants ?? [];
      const others = participants.filter((participant) => participant.user_id !== userId);
      const otherProfile = others[0] ? profilesById.get(others[0].user_id) ?? null : null;

      const messages = messagesByConversation.get(row.conversation_id) ?? [];
      const latest = messages[0] ?? null;

      const unreadCount = unreadByConversation.get(row.conversation_id) ?? 0;

      const lastMessage = latest
        ? (previewByConversation.get(row.conversation_id) ?? previewFor(latest.body, latest.kind))
        : null;

      const lastMessageIsOwn = latest?.sender_id === userId;
      const otherParticipant = others[0]
        ? participants.find((participant) => participant.user_id === others[0].user_id)
        : null;
      const lastMessageRead =
        conversation.kind === "direct" && lastMessageIsOwn && latest && otherParticipant
          ? !!otherParticipant.last_read_at &&
            new Date(otherParticipant.last_read_at).getTime() >=
              new Date(latest.created_at).getTime()
          : null;

      return {
        id: conversation.id,
        kind: conversation.kind,
        title:
          conversation.kind === "group"
            ? conversation.title ?? "Group"
            : otherProfile?.display_name ?? "Unknown",
        avatarUrl: conversation.kind === "group" ? null : otherProfile?.avatar_url ?? null,
        lastMessage,
        lastMessageAt: latest?.created_at ?? conversation.updated_at,
        unreadCount,
        lastMessageIsOwn,
        lastMessageRead,
        isEncrypted: conversation.is_encrypted,
      };
    });

    const sorted = sortByLatest(summaries);
    setChats(sorted);
    setLoading(false);
    // Secret Chat previews are decrypted text: only a placeholder goes to
    // disk, the same rule as the message cache (src/lib/localMessages.ts).
    const forDisk = sorted.map((chat) =>
      chat.isEncrypted && chat.lastMessage ? { ...chat, lastMessage: "🔒 Message" } : chat
    );
    void writeChatListCache(userId, JSON.stringify(forDisk)).catch(() => {});
  }, [userId, decryptForConversation, e2eeReady]);

  // Collapses a burst of realtime events into a single reload. Ten messages
  // arriving at once (a group waking up, or a reconnect replaying) used to
  // mean ten full reloads racing each other; this makes it one, ~250ms later.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      void load();
    }, 250);
  }, [load]);

  useEffect(
    () => () => {
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    },
    []
  );

  // Reloads when e2eeReady flips: the first load happens before the device
  // keypair is available, so its encrypted previews come back blank. This is
  // what fills them in, rather than leaving them empty until the user opens
  // each chat.
  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Live updates on the user's channel (src/lib/userChannel.ts). A new
  // message updates its own row in place — preview, time, unread badge,
  // order — instead of reloading the whole list (three queries plus
  // decrypting every Secret Chat preview) for each message, which in a busy
  // group was a continuous refetch loop. Rarer changes still reload.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!userId) return;

    const applyNewMessage = async (message: MessageRow) => {
      const chat = chatsRef.current.find((item) => item.id === message.conversation_id);
      // A chat not in the list (brand new, or one this user had deleted —
      // the server un-hides it on a new message): reload to pick it up.
      if (!chat) {
        scheduleReload();
        return;
      }
      let preview = previewFor(message.body, message.kind);
      if (chat.isEncrypted && message.kind === "text" && message.body && parseEnvelope(message.body)) {
        const decrypted = await decryptForConversation(message.conversation_id, message.body);
        preview = decrypted ?? (e2eeReady ? "🔒 Unable to decrypt" : "🔒 Message");
      }
      const own = message.sender_id === userId;
      setChats((current) =>
        sortByLatest(
          current.map((item) =>
            item.id !== message.conversation_id || (item.lastMessageAt && item.lastMessageAt > message.created_at)
              ? item
              : {
                  ...item,
                  lastMessage: preview,
                  lastMessageAt: message.created_at,
                  // Same rule as chat_list_summary: others' messages after
                  // my last read. Opening the chat marks it read, which
                  // comes back below as my own participant_update.
                  // Not for the chat on screen: it is being read as it
                  // arrives, and counting it only to have markRead's echo
                  // (or, with a phone clock behind the server, a full
                  // reload) take it back cost three requests per message.
                  unreadCount: own || getCurrentConversationId() === item.id ? item.unreadCount : item.unreadCount + 1,
                  lastMessageIsOwn: own,
                  lastMessageRead: item.kind === "direct" && own ? false : null,
                }
          )
        )
      );
    };

    const applyReadPosition = (conversationId: string, readerId: string, lastReadAt: string | null) => {
      const chat = chatsRef.current.find((item) => item.id === conversationId);
      if (!chat || !lastReadAt) return;
      const readsLatest = !chat.lastMessageAt || lastReadAt >= chat.lastMessageAt;
      if (readerId === userId) {
        // Read up to the newest message (here or on another device): the
        // badge is simply zero. A partial read needs the exact count.
        // The chat on screen counts as read whatever the clocks say (a phone
        // behind the server stamps last_read_at before the newest message).
        if (readsLatest || getCurrentConversationId() === conversationId) {
          setChats((current) => current.map((item) => (item.id === conversationId ? { ...item, unreadCount: 0 } : item)));
        } else {
          scheduleReload();
        }
        return;
      }
      if (chat.kind === "direct" && chat.lastMessageIsOwn) {
        setChats((current) =>
          current.map((item) => (item.id === conversationId ? { ...item, lastMessageRead: readsLatest } : item))
        );
      }
    };

    const offEvents = subscribeUserEvents(userId, (event) => {
      switch (event.type) {
        case "message_insert":
          void applyNewMessage(event.message);
          return;
        case "message_update":
        case "message_delete":
        case "membership":
          scheduleReload();
          return;
        case "participant_update":
          applyReadPosition(event.conversation_id, event.user_id, event.last_read_at);
          return;
      }
    });
    // Realtime has no replay: after a drop, refetch the whole list.
    const offResync = onUserChannelResync(userId, () => void loadRef.current());

    return () => {
      offEvents();
      offResync();
    };
  }, [userId, scheduleReload, decryptForConversation, e2eeReady]);

  return { chats, loading, error, refresh: load };
}

function sortByLatest(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });
}

function previewFor(
  body: string | null,
  kind: Database["public"]["Enums"]["message_kind"]
): string | null {
  switch (kind) {
    case "image":
      return "📷 Photo";
    case "video":
      return "🎬 Video";
    case "document":
      return "📄 Document";
    case "voice":
      return "🎤 Voice message";
    case "activity_share":
      return "Shared an activity";
    case "contact_share":
      return "Shared a contact";
    case "system":
      return describeGroupEvent(body);
    default:
      // Reached only for unencrypted conversations (encrypted ones are
      // decrypted above, before this runs) — but guard anyway so a raw
      // ciphertext envelope can never render as if it were plaintext, e.g.
      // a message sent in the instant before startEncryptedChat's
      // is_encrypted flag propagates to this list.
      return body && parseEnvelope(body) ? "🔒 Encrypted message" : body;
  }
}
