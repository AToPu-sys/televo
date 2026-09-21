import { useCallback, useEffect, useRef, useState } from "react";

import { ASSISTANT_USER_ID } from "../lib/assistant";
import { parseEnvelope } from "../lib/e2e";
import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";
import { useE2ee } from "./useE2ee";

type ConversationKind = Database["public"]["Enums"]["conversation_kind"];

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
  const [loading, setLoading] = useState(true);
  // useChats is mounted by BOTH the chats tab and the forward-message modal.
  // A fixed channel name meant the modal's cleanup tore down the topic the
  // chats screen was still using, silently killing its live updates.
  const channelIdRef = useRef(Math.random().toString(36).slice(2));
  // Distinguishes the first join from a reconnect — see the subscribe handler.
  const hasSubscribedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { decryptForConversation, ready: e2eeReady, repairAllSessionKeys } = useE2ee();

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
      // list. A NEW message arriving un-hides it again (see the realtime
      // handler below, which clears deleted_at on receipt), so this filter
      // alone would otherwise permanently hide a chat someone messages you
      // in again after you'd deleted it.
      .is("deleted_at", null);

    if (queryError) {
      setError(queryError.message);
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
        setError(summaryError.message);
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

    summaries.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });

    setChats(summaries);
    setLoading(false);
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

  // Any new message anywhere can change ordering, previews, or unread counts,
  // so refresh the summary list when one lands. Also listen for
  // conversation_participants updates: that's how last_read_at changes, which
  // is what lets a chat marked read on one device clear its badge live on
  // another device signed into the same account.
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`chats-list:${channelIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          // RLS already limits which rows reach this socket, but EVERY one of
          // them used to trigger a full reload — several round trips plus
          // per-chat decryption. In a busy group that is a continuous refetch
          // loop. Coalesce instead: collapse a burst into one reload.
          const conversationId = (payload.new as { conversation_id?: string } | null)
            ?.conversation_id;
          if (!conversationId) return;
          // A new message in a chat this device had "deleted for me" (048_
          // delete_chat.sql) un-hides it, same as Telegram/WhatsApp — a
          // deleted chat isn't a standing preference to never see this
          // person again, it's "I'm done with the history up to now."
          // Best-effort: RLS already scopes this to rows this user can
          // update, and a failure here just leaves the chat hidden (the
          // same state it was already correctly in) rather than breaking
          // anything, so no error handling beyond letting it fail silently.
          void supabase
            .from("conversation_participants")
            .update({ deleted_at: null })
            .eq("conversation_id", conversationId)
            .eq("user_id", userId)
            .not("deleted_at", "is", null);
          scheduleReload();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversation_participants",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          scheduleReload();
        }
      )
      .subscribe((status) => {
        // Refetch on every re-SUBSCRIBE. Realtime has no replay, so any
        // message that landed while the socket was down (handover, tunnel,
        // backgrounding) would otherwise never reach this list: the chat
        // would sit with a stale preview and a stale unread badge until the
        // user pulled to refresh.
        if (status === "SUBSCRIBED") {
          if (hasSubscribedRef.current) void load();
          hasSubscribedRef.current = true;
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, load, scheduleReload]);

  return { chats, loading, error, refresh: load };
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
    case "activity_share":
      return "Shared an activity";
    case "contact_share":
      return "Shared a contact";
    default:
      // Reached only for unencrypted conversations (encrypted ones are
      // decrypted above, before this runs) — but guard anyway so a raw
      // ciphertext envelope can never render as if it were plaintext, e.g.
      // a message sent in the instant before startEncryptedChat's
      // is_encrypted flag propagates to this list.
      return body && parseEnvelope(body) ? "🔒 Encrypted message" : body;
  }
}
