import { useCallback, useEffect, useState } from "react";

import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";

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
};

/**
 * Loads the signed-in user's conversations with their last message and unread
 * count, and keeps the list live as new messages arrive.
 */
export function useChats(userId: string | undefined) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          conversation_participants ( user_id )
        )
      `
      )
      .eq("user_id", userId);

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
      { body: string | null; created_at: string; sender_id: string }[]
    >();

    if (conversationIds.length > 0) {
      const { data: messageRows } = await supabase
        .from("messages")
        .select("conversation_id, body, created_at, sender_id, kind")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .limit(500);

      for (const message of messageRows ?? []) {
        const list = messagesByConversation.get(message.conversation_id) ?? [];
        list.push({
          body: previewFor(message.body, message.kind),
          created_at: message.created_at,
          sender_id: message.sender_id,
        });
        messagesByConversation.set(message.conversation_id, list);
      }
    }

    const summaries: ChatSummary[] = rows.map((row) => {
      const conversation = row.conversations;
      const participants = conversation.conversation_participants ?? [];
      const others = participants.filter((participant) => participant.user_id !== userId);
      const otherProfile = others[0] ? profilesById.get(others[0].user_id) ?? null : null;

      const messages = messagesByConversation.get(row.conversation_id) ?? [];
      const latest = messages[0] ?? null;

      const lastReadAt = row.last_read_at ? new Date(row.last_read_at).getTime() : 0;
      const unreadCount = messages.filter(
        (message) =>
          message.sender_id !== userId && new Date(message.created_at).getTime() > lastReadAt
      ).length;

      return {
        id: conversation.id,
        kind: conversation.kind,
        title:
          conversation.kind === "group"
            ? conversation.title ?? "Group"
            : otherProfile?.display_name ?? "Unknown",
        avatarUrl: conversation.kind === "group" ? null : otherProfile?.avatar_url ?? null,
        lastMessage: latest?.body ?? null,
        lastMessageAt: latest?.created_at ?? conversation.updated_at,
        unreadCount,
      };
    });

    summaries.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });

    setChats(summaries);
    setLoading(false);
  }, [userId]);

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
      .channel("chats-list")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        () => {
          void load();
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
          void load();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, load]);

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
      return body;
  }
}
