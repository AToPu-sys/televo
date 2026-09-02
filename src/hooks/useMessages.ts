import { useCallback, useEffect, useRef, useState } from "react";

import { uploadChatDocument, uploadChatMedia } from "../lib/media";
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
  isEncrypted: boolean = false,
  selfDestructSeconds: number | null = null
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
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const updated = payload.new as MessageRow;
          void (async () => {
            const [decorated] = await decorateWithDecryption([updated]);
            setMessages((current) =>
              current.map((message) => (message.id === decorated.id ? decorated : message))
            );
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
    async (body: string, replyToId?: string | null) => {
      const trimmed = body.trim();
      if (!trimmed || !conversationId || !userId) return;

      const optimisticId = `optimistic-${Date.now()}`;
      optimisticIds.current.add(optimisticId);

      const expiresAt = selfDestructSeconds
        ? new Date(Date.now() + selfDestructSeconds * 1000).toISOString()
        : null;

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
        reply_to_id: replyToId ?? null,
        edited_at: null,
        forwarded_from_message_id: null,
        forwarded_from_sender_id: null,
        expires_at: expiresAt,
        document_name: null,
        document_size_bytes: null,
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
          reply_to_id: replyToId ?? null,
          expires_at: expiresAt,
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
    [conversationId, userId, isEncrypted, encryptForConversation, selfDestructSeconds]
  );

  const editMessage = useCallback(async (messageId: string, newBody: string) => {
    const trimmed = newBody.trim();
    if (!trimmed) return;

    // Optimistic edit.
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, body: trimmed, decryptedBody: trimmed, edited_at: new Date().toISOString() }
          : message
      )
    );

    const { error } = await supabase
      .from("messages")
      .update({ body: trimmed, edited_at: new Date().toISOString() })
      .eq("id", messageId);
    if (error) throw error;
  }, []);

  // Forwarding is handled by app/forward-message.tsx, which inserts directly
  // into the CHOSEN destination conversation (not necessarily this one) —
  // there's no per-conversation "forward" action that belongs on this hook.

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
        reply_to_id: null,
        edited_at: null,
        forwarded_from_message_id: null,
        forwarded_from_sender_id: null,
        expires_at: null,
        document_name: null,
        document_size_bytes: null,
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

  const sendDocument = useCallback(
    async (localUri: string, name: string, sizeBytes: number) => {
      if (!conversationId || !userId) return;

      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        conversation_id: conversationId,
        sender_id: userId,
        kind: "document",
        body: null,
        media_url: localUri,
        shared_activity_id: null,
        shared_profile_id: null,
        reply_to_id: null,
        edited_at: null,
        forwarded_from_message_id: null,
        forwarded_from_sender_id: null,
        expires_at: null,
        document_name: name,
        document_size_bytes: sizeBytes,
        created_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      try {
        const path = await uploadChatDocument(conversationId, localUri, name);
        const { error: insertError } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          sender_id: userId,
          kind: "document",
          media_url: path,
          document_name: name,
          document_size_bytes: sizeBytes,
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

  // Self-destruct sweep: while this chat is open, periodically hide (client)
  // and delete (server, via the "expired messages" DELETE policy — any
  // participant, not just the sender, may delete a message once it's past
  // its expires_at) any message whose timer has elapsed.
  useEffect(() => {
    if (!conversationId) return;

    const sweep = () => {
      const now = Date.now();
      setMessages((current) => {
        const expired = current.filter(
          (message) => message.expires_at && new Date(message.expires_at).getTime() <= now
        );
        if (expired.length === 0) return current;

        for (const message of expired) {
          if (!message.pending) {
            void supabase.from("messages").delete().eq("id", message.id);
          }
        }
        const expiredIds = new Set(expired.map((message) => message.id));
        return current.filter((message) => !expiredIds.has(message.id));
      });
    };

    const interval = setInterval(sweep, 1000);
    sweep();
    return () => clearInterval(interval);
  }, [conversationId]);

  return {
    messages,
    loading,
    error,
    sendMessage,
    editMessage,
    sendImage,
    sendDocument,
    deleteMessage,
    markRead,
    refresh: load,
  };
}
