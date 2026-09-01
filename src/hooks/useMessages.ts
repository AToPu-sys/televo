import { useCallback, useEffect, useRef, useState } from "react";

import { uploadChatMedia } from "../lib/media";
import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

export type ChatMessage = MessageRow & {
  /** Set while an optimistic message is still in flight. */
  pending?: boolean;
  failed?: boolean;
};

const PAGE_SIZE = 50;

export function useMessages(conversationId: string | undefined, userId: string | undefined) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tracks optimistic ids so the realtime INSERT can replace them instead of
  // appending a duplicate when our own message echoes back.
  const optimisticIds = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (!conversationId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    const { data, error: queryError } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (queryError) {
      setError(queryError.message);
    } else {
      setMessages(data ?? []);
    }
    setLoading(false);
  }, [conversationId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!conversationId) return;

    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const incoming = payload.new as MessageRow;
          setMessages((current) => {
            // Our own optimistic copy is already on screen — swap it for the
            // server row rather than showing the message twice.
            const withoutOptimistic = current.filter((message) => {
              if (!message.pending) return true;
              const isOurEcho =
                message.sender_id === incoming.sender_id && message.body === incoming.body;
              if (isOurEcho) {
                optimisticIds.current.delete(message.id);
                return false;
              }
              return true;
            });

            if (withoutOptimistic.some((message) => message.id === incoming.id)) {
              return withoutOptimistic;
            }
            return [incoming, ...withoutOptimistic];
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const removed = payload.old as Partial<MessageRow>;
          setMessages((current) => current.filter((message) => message.id !== removed.id));
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId]);

  const sendMessage = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || !conversationId || !userId) return;

      const optimisticId = `optimistic-${Date.now()}`;
      optimisticIds.current.add(optimisticId);

      const optimistic: ChatMessage = {
        id: optimisticId,
        conversation_id: conversationId,
        sender_id: userId,
        kind: "text",
        body: trimmed,
        media_url: null,
        shared_activity_id: null,
        shared_profile_id: null,
        created_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      const { error: insertError } = await supabase.from("messages").insert({
        conversation_id: conversationId,
        sender_id: userId,
        kind: "text",
        body: trimmed,
      });

      if (insertError) {
        // Leave the bubble in place but mark it failed, so the text isn't lost.
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? { ...message, pending: false, failed: true } : message
          )
        );
        optimisticIds.current.delete(optimisticId);
        throw insertError;
      }
    },
    [conversationId, userId]
  );

  const sendImage = useCallback(
    async (localUri: string) => {
      if (!conversationId || !userId) return;

      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        conversation_id: conversationId,
        sender_id: userId,
        kind: "image",
        body: null,
        // Show the local file while the upload is in flight.
        media_url: localUri,
        shared_activity_id: null,
        shared_profile_id: null,
        created_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      try {
        const path = await uploadChatMedia(conversationId, localUri);
        const { error: insertError } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          sender_id: userId,
          kind: "image",
          media_url: path,
        });
        if (insertError) throw insertError;
      } catch (error) {
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? { ...message, pending: false, failed: true } : message
          )
        );
        throw error;
      }
    },
    [conversationId, userId]
  );

  const deleteMessage = useCallback(async (messageId: string) => {
    // Optimistically remove; the realtime DELETE event is a no-op afterwards.
    setMessages((current) => current.filter((message) => message.id !== messageId));
    const { error } = await supabase.from("messages").delete().eq("id", messageId);
    if (error) throw error;
  }, []);

  const markRead = useCallback(async () => {
    if (!conversationId || !userId) return;
    await supabase
      .from("conversation_participants")
      .update({ last_read_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("user_id", userId);
  }, [conversationId, userId]);

  return {
    messages,
    loading,
    error,
    sendMessage,
    sendImage,
    deleteMessage,
    markRead,
    refresh: load,
  };
}
