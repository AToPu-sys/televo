import { useCallback, useEffect, useRef, useState } from "react";

import { uploadChatMedia } from "../lib/media";
import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";
import { useE2ee } from "./useE2ee";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

export type ChatMessage = MessageRow & {
  /** Set while an optimistic message is still in flight. */
  pending?: boolean;
  failed?: boolean;
  /** Set for encrypted conversations once the body has been decrypted client-side.
   * `body` itself stays as the raw ciphertext envelope; render this instead. */
  decryptedBody?: string | null;
};

const PAGE_SIZE = 50;

export function useMessages(
  conversationId: string | undefined,
  userId: string | undefined,
  isEncrypted: boolean = false
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tracks optimistic ids so the realtime INSERT can replace them instead of
  // appending a duplicate when our own message echoes back.
  const optimisticIds = useRef(new Set<string>());
  const { encryptForConversation, decryptForConversation } = useE2ee();

  const decorateWithDecryption = useCallback(
    async (rows: ChatMessage[]): Promise<ChatMessage[]> => {
      if (!isEncrypted || !conversationId) return rows;

      return Promise.all(
        rows.map(async (row) => {
          if (row.kind !== "text" || !row.body) return row;
          const decrypted = await decryptForConversation(conversationId, row.body);
          return { ...row, decryptedBody: decrypted };
        })
      );
    },
    [isEncrypted, conversationId, decryptForConversation]
  );

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
      setMessages(await decorateWithDecryption(data ?? []));
    }
    setLoading(false);
  }, [conversationId, decorateWithDecryption]);

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

          void (async () => {
            const [decorated] = await decorateWithDecryption([incoming]);

            setMessages((current) => {
              // Our own optimistic copy is already on screen — swap it for the
              // server row rather than showing the message twice. Compare by
              // the ciphertext body when encrypted (plaintext bodies differ
              // by nonce each time, so they'd never match).
              const withoutOptimistic = current.filter((message) => {
                if (!message.pending) return true;
                const isOurEcho =
                  message.sender_id === incoming.sender_id &&
                  (isEncrypted || message.body === incoming.body);
                if (isOurEcho) {
                  optimisticIds.current.delete(message.id);
                  return false;
                }
                return true;
              });

              if (withoutOptimistic.some((message) => message.id === decorated.id)) {
                return withoutOptimistic;
              }
              return [decorated, ...withoutOptimistic];
            });
          })();
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
  }, [conversationId, isEncrypted, decorateWithDecryption]);

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
        body: isEncrypted ? null : trimmed,
        decryptedBody: isEncrypted ? trimmed : undefined,
        media_url: null,
        shared_activity_id: null,
        shared_profile_id: null,
        created_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      try {
        const storedBody = isEncrypted
          ? await encryptForConversation(conversationId, trimmed)
          : trimmed;

        const { error: insertError } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          sender_id: userId,
          kind: "text",
          body: storedBody,
        });
        if (insertError) throw insertError;
      } catch (error) {
        // Leave the bubble in place but mark it failed, so the text isn't lost.
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? { ...message, pending: false, failed: true } : message
          )
        );
        optimisticIds.current.delete(optimisticId);
        throw error;
      }
    },
    [conversationId, userId, isEncrypted, encryptForConversation]
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
