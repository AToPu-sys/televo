import { useCallback, useEffect, useRef, useState } from "react";

import { uploadChatDocument, uploadChatMedia,
  parseMediaRef,
} from "../lib/media";
import {
  bindLocalMessagesToUser,
  deleteLocalMessages,
  readLocalMessages,
  reconcileLocalWindow,
  upsertLocalMessages,
} from "../lib/localMessages";
import { primeMediaCache } from "../lib/mediaCache";
import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";
import { randomUUID } from "../lib/uuid";
import { playMessageSentSound } from "./useMessageNotifications";
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

/** True only for a body that actually looks like our ciphertext envelope
 * ({"ciphertext":...,"nonce":...}), so plaintext history in a chat that was
 * later switched to a Secret Chat still renders normally. */
function isEncryptedEnvelope(body: string): boolean {
  if (!body.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.ciphertext === "string" && typeof parsed?.nonce === "string";
  } catch {
    return false;
  }
}

export function useMessages(
  conversationId: string | undefined,
  userId: string | undefined,
  // undefined means "not known yet" (the owning conversation row is still
  // loading) — load() is held off until this settles to a real boolean, so
  // messages are never fetched on a guessed encryption state. See the
  // loadRunIdRef comment below for why a wrong guess used to flash "🔒 …".
  //
  // Deliberately NO `= false` default here. app/chat/[id].tsx passes
  // `undefined` explicitly while the conversation row is still loading —
  // and a JS default parameter substitutes its default for ANY `undefined`
  // argument, including an explicit one. With `= false` on this parameter,
  // `isEncryptedInput` was silently coerced to `false` before this
  // function's body ever ran, so the `isEncryptedInput === undefined` guard
  // below could never be true — the "hold off until it's known" gate was
  // dead code. load() ran immediately on the first render with a guessed
  // `false`, decorateWithDecryption's early return left the raw ciphertext
  // envelope in `body`, and MessageBubble rendered its "🔒 …" fallback for
  // that one frame before the real value arrived and re-triggered load().
  // That flash-of-🔒 is the exact bug this parameter's own comment already
  // claimed was fixed. Leaving the parameter genuinely optional (no default)
  // means an explicit `undefined` argument stays `undefined` inside the
  // function, and only a caller that omits the argument entirely falls back
  // to the isEncrypted local below.
  isEncryptedInput: boolean | undefined,
  selfDestructSeconds: number | null = null
) {
  const isEncrypted = isEncryptedInput ?? false;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tracks optimistic ids so the realtime INSERT can replace them instead of
  // appending a duplicate when our own message echoes back.
  const optimisticIds = useRef(new Set<string>());
  const [hasMore, setHasMore] = useState(false);
  // The other participant's last_read_at, so a sent message can show whether
  // it was actually read. Previously every sent message showed a double
  // checkmark unconditionally, which simply lied to the user.
  const [peerLastReadAt, setPeerLastReadAt] = useState<string | null>(null);
  const loadingOlderRef = useRef(false);
  // False until the channel's first SUBSCRIBED; distinguishes the initial
  // join (no refetch needed) from a reconnect (refetch required).
  const hasSubscribedRef = useRef(false);
  // Incremented at the start of every load() call; each call captures its
  // own id and checks it's still current before writing state. `load`'s
  // identity changes whenever `isEncrypted` does (via decorateWithDecryption
  // below), and `isEncrypted` genuinely flips false -> true on every visit
  // to a Secret Chat (useConversation has no cache, so it always starts
  // `false` for one render before the real value loads) — which re-fires
  // the effect that calls load() a second time. The FIRST (isEncrypted:
  // false) call skips decryption entirely (see decorateWithDecryption's
  // early return) and is therefore structurally faster than the SECOND
  // (isEncrypted: true) call, which awaits real decryption per message.
  // With no ordering guarantee, the first call's setMessages/setLoading(
  // false) could land after the second call started but before it
  // finished — showing raw ciphertext envelopes with decryptedBody still
  // undefined for one frame, which MessageBubble renders as "🔒 …". This
  // guard makes only the LAST-STARTED call ever allowed to write state.
  const loadRunIdRef = useRef(0);
  const { encryptForConversation, decryptForConversation, encryptBytesForConversation } = useE2ee();

  const decorateWithDecryption = useCallback(
    async (rows: ChatMessage[]): Promise<ChatMessage[]> => {
      if (!isEncrypted || !conversationId) return rows;

      return Promise.all(
        rows.map(async (row) => {
          if (row.kind !== "text" || !row.body) return row;

          // Messages sent BEFORE this chat was switched to a Secret Chat are
          // plain text, not ciphertext envelopes. Treating them as encrypted
          // turned the entire prior history into "Unable to decrypt" the
          // moment encryption was enabled — leave genuine plaintext alone.
          if (!isEncryptedEnvelope(row.body)) return row;

          const decrypted = await decryptForConversation(conversationId, row.body);
          return { ...row, decryptedBody: decrypted };
        })
      );
    },
    [isEncrypted, conversationId, decryptForConversation]
  );

  const load = useCallback(async () => {
    const runId = ++loadRunIdRef.current;

    if (!conversationId) {
      if (runId === loadRunIdRef.current) {
        setMessages([]);
        setLoading(false);
      }
      return;
    }

    // Instant paint from the on-device copy (also what makes a chat readable
    // with no connection). Best-effort: any cache failure just falls through
    // to the server fetch below, exactly as before the cache existed.
    let paintedFromCache = false;
    try {
      if (userId) await bindLocalMessagesToUser(userId);
      const local = await readLocalMessages(conversationId, PAGE_SIZE);
      if (local.length > 0 && runId === loadRunIdRef.current) {
        const decoratedLocal = await decorateWithDecryption(local);
        if (runId === loadRunIdRef.current) {
          setMessages(decoratedLocal);
          setHasMore(local.length === PAGE_SIZE);
          setLoading(false);
          paintedFromCache = true;
        }
      }
    } catch {
      // ignore — server fetch below is authoritative
    }

    // messages_decrypted (not the raw messages table): scripts/sql/076_at_rest_message_encryption.sql
    // transparently decrypts the DB-level encryption layer for every row —
    // for a Secret Chat that still leaves the {ciphertext,nonce} E2E
    // envelope in body, which decorateWithDecryption below then decrypts
    // the rest of the way client-side, same as always.
    const { data, error: queryError } = await supabase
      .from("messages_decrypted")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (queryError) {
      // Offline with a cached copy on screen: keep showing it, no error.
      if (runId === loadRunIdRef.current && !paintedFromCache) setError(queryError.message);
    } else {
      const rows = data ?? [];
      void reconcileLocalWindow(
        conversationId,
        rows,
        rows.length === PAGE_SIZE ? rows[rows.length - 1].created_at : null,
        // Bounded by the newest row the server returned, so a message that
        // arrives via realtime while this fetch is in flight isn't treated as
        // "deleted on the server" and dropped from the cache.
        rows.length > 0 ? rows[0].created_at : null,
        true
      ).catch(() => {});
      const decorated = await decorateWithDecryption(rows);
      if (runId === loadRunIdRef.current) {
        setMessages(decorated);
        setHasMore(rows.length === PAGE_SIZE);
      }
    }
    if (runId === loadRunIdRef.current) setLoading(false);
  }, [conversationId, userId, decorateWithDecryption]);

  /** Loads the next page of older messages. Without this, anything past the
   * first 50 was permanently unreachable — scrolling up just hit a wall, and
   * replies to older messages rendered with no quote. */
  const loadOlder = useCallback(async () => {
    if (!conversationId || loadingOlderRef.current || !hasMore) return;

    const oldest = messages[messages.length - 1];
    if (!oldest) return;

    loadingOlderRef.current = true;
    try {
      const { data, error: olderError } = await supabase
        .from("messages_decrypted")
        .select("*")
        .eq("conversation_id", conversationId)
        .lt("created_at", oldest.created_at)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);

      let rows = data ?? [];
      if (olderError) {
        rows = await readLocalMessages(conversationId, PAGE_SIZE, oldest.created_at).catch(() => []);
      } else {
        void reconcileLocalWindow(
          conversationId,
          rows,
          rows.length === PAGE_SIZE ? rows[rows.length - 1].created_at : null,
          oldest.created_at
        ).catch(() => {});
      }
      setHasMore(rows.length === PAGE_SIZE);
      if (rows.length > 0) {
        const decorated = await decorateWithDecryption(rows);
        setMessages((current) => {
          const seen = new Set(current.map((m) => m.id));
          return [...current, ...decorated.filter((m) => !seen.has(m.id))];
        });
      }
    } finally {
      loadingOlderRef.current = false;
    }
  }, [conversationId, hasMore, messages, decorateWithDecryption]);

  useEffect(() => {
    if (isEncryptedInput === undefined) return;
    setLoading(true);
    void load();
  }, [load, isEncryptedInput]);

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
          // payload.new carries the RAW table row — since
          // 076_at_rest_message_encryption.sql, that's the DB-level
          // ciphertext, not real content. postgres_changes streams straight
          // off the table/WAL and has no way to run the decrypt function, so
          // this is now a signal ("a row with this id was inserted"), not
          // the content itself: re-fetch the one row through
          // messages_decrypted, which does. One extra round trip per
          // message, not per keystroke.
          const incomingRaw = payload.new as MessageRow;
          void (async () => {
            const { data: incoming } = await supabase
              .from("messages_decrypted")
              .select("*")
              .eq("id", incomingRaw.id)
              .maybeSingle();
            if (!incoming) return;
            void upsertLocalMessages([incoming as MessageRow]).catch(() => {});
            const [decorated] = await decorateWithDecryption([incoming as MessageRow]);

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
          // See the INSERT handler's comment: payload.new is ciphertext,
          // re-fetch the decrypted row by id instead of trusting it.
          const updatedRaw = payload.new as MessageRow;
          void (async () => {
            const { data: updated } = await supabase
              .from("messages_decrypted")
              .select("*")
              .eq("id", updatedRaw.id)
              .maybeSingle();
            if (!updated) return;
            void upsertLocalMessages([updated as MessageRow]).catch(() => {});
            const [decorated] = await decorateWithDecryption([updated as MessageRow]);
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
          if (removed.id) void deleteLocalMessages([removed.id]).catch(() => {});
          setMessages((current) => current.filter((message) => message.id !== removed.id));
        }
      )
      .subscribe((status) => {
        // Realtime is a WebSocket: a Wi-Fi→cellular handover, a tunnel or a
        // spell in the background drops it, and supabase-js silently
        // re-joins. Broadcast and postgres_changes have NO replay, so every
        // INSERT during that gap is lost forever — messages simply never
        // appeared until the chat was closed and reopened. Refetching on each
        // (re)subscribe closes that hole; the first SUBSCRIBED is skipped
        // because load() has just run.
        if (status === "SUBSCRIBED") {
          if (hasSubscribedRef.current) void load();
          hasSubscribedRef.current = true;
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId, isEncrypted, decorateWithDecryption]);

  const sendMessage = useCallback(
    async (body: string, replyToId?: string | null) => {
      const trimmed = body.trim();
      if (!trimmed || !conversationId || !userId) return;

      const optimisticId = `optimistic-${randomUUID()}`;
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
        media_duration_ms: null,
        waveform: null,
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
        playMessageSentSound();
      } catch (error) {
        // Every send failure used to look identical — a red bubble with no
        // trace of WHY (network error, RLS rejection, missing encryption
        // key). That made it impossible to tell a real bug from a network
        // blip from a race condition without adding logging after the fact.
        // eslint-disable-next-line no-console
        console.error(
          "[sendMessage] failed:",
          error instanceof Error ? error.message : error,
          { conversationId, isEncrypted }
        );
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

  const editMessage = useCallback(
    async (messageId: string, newBody: string) => {
      const trimmed = newBody.trim();
      if (!trimmed || !conversationId) return;

      // In a Secret Chat the stored body is a ciphertext envelope. Writing
      // the edit as plaintext (which this used to do) made the message
      // unreadable to the peer — parseEnvelope fails and they see
      // "Unable to decrypt" — as well as leaking the edited text server-side.
      const storedBody = isEncrypted
        ? await encryptForConversation(conversationId, trimmed)
        : trimmed;

      // Optimistic edit: `body` mirrors what's stored, `decryptedBody` is
      // what gets rendered. Kept so a failed server write can be rolled back
      // instead of leaving the bubble showing an edit that never actually
      // saved — previously a failure here left the wrong text on screen
      // indefinitely, until some unrelated realtime event or reload happened
      // to overwrite it with the true server state.
      let previous: ChatMessage | undefined;
      setMessages((current) =>
        current.map((message) => {
          if (message.id !== messageId) return message;
          previous = message;
          return {
            ...message,
            body: storedBody,
            decryptedBody: isEncrypted ? trimmed : undefined,
            edited_at: new Date().toISOString(),
          };
        })
      );

      const { error } = await supabase
        .from("messages")
        .update({ body: storedBody, edited_at: new Date().toISOString() })
        .eq("id", messageId);
      if (error) {
        if (previous) {
          const restored = previous;
          setMessages((current) =>
            current.map((message) => (message.id === messageId ? restored : message))
          );
        }
        throw error;
      }
    },
    [conversationId, isEncrypted, encryptForConversation]
  );

  // Forwarding is handled by app/forward-message.tsx, which inserts directly
  // into the CHOSEN destination conversation (not necessarily this one) —
  // there's no per-conversation "forward" action that belongs on this hook.

  const sendImage = useCallback(
    async (localUri: string, kind: "image" | "video" = "image") => {
      // Self-destruct applies to media too. These paths hardcoded null, so a
      // user who switched disappearing messages on and sent a photo got a
      // permanent photo — the UI promised something the code did not do.
      const expiresAt = selfDestructSeconds
        ? new Date(Date.now() + selfDestructSeconds * 1000).toISOString()
        : null;
      if (!conversationId || !userId) return;

      const optimisticId = `optimistic-${randomUUID()}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        conversation_id: conversationId,
        sender_id: userId,
        kind,
        body: null,
        // Show the local file while the upload is in flight.
        media_url: localUri,
        shared_activity_id: null,
        shared_profile_id: null,
        reply_to_id: null,
        edited_at: null,
        forwarded_from_message_id: null,
        forwarded_from_sender_id: null,
        expires_at: expiresAt,
        document_name: null,
        document_size_bytes: null,
        media_duration_ms: null,
        waveform: null,
        created_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      try {
        const path = await uploadChatMedia(
          conversationId,
          localUri,
          isEncrypted ? (data) => encryptBytesForConversation(conversationId, data) : undefined
        );
        const { error: insertError } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          sender_id: userId,
          kind,
          media_url: path,
          expires_at: expiresAt,
        });
        if (insertError) throw insertError;
        playMessageSentSound();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[sendImage] failed:",
          error instanceof Error ? error.message : error,
          { conversationId, isEncrypted }
        );
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? { ...message, pending: false, failed: true } : message
          )
        );
        throw error;
      }
    },
    [conversationId, userId, isEncrypted, encryptBytesForConversation, selfDestructSeconds]
  );

  const sendDocument = useCallback(
    async (localUri: string, name: string, sizeBytes: number) => {
      // Self-destruct applies to media too. These paths hardcoded null, so a
      // user who switched disappearing messages on and sent a photo got a
      // permanent photo — the UI promised something the code did not do.
      const expiresAt = selfDestructSeconds
        ? new Date(Date.now() + selfDestructSeconds * 1000).toISOString()
        : null;
      if (!conversationId || !userId) return;

      const optimisticId = `optimistic-${randomUUID()}`;
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
        expires_at: expiresAt,
        document_name: name,
        document_size_bytes: sizeBytes,
        media_duration_ms: null,
        waveform: null,
        created_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      try {
        const path = await uploadChatDocument(
          conversationId,
          localUri,
          name,
          isEncrypted ? (data) => encryptBytesForConversation(conversationId, data) : undefined
        );
        const { error: insertError } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          sender_id: userId,
          kind: "document",
          media_url: path,
          document_name: name,
          document_size_bytes: sizeBytes,
          expires_at: expiresAt,
        });
        if (insertError) throw insertError;
        playMessageSentSound();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[sendDocument] failed:",
          error instanceof Error ? error.message : error,
          { conversationId, isEncrypted }
        );
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? { ...message, pending: false, failed: true } : message
          )
        );
        throw error;
      }
    },
    [conversationId, userId, isEncrypted, encryptBytesForConversation, selfDestructSeconds]
  );

  const sendVoice = useCallback(
    async (localUri: string, durationMs: number, waveform: string) => {
      const expiresAt = selfDestructSeconds
        ? new Date(Date.now() + selfDestructSeconds * 1000).toISOString()
        : null;
      if (!conversationId || !userId) return;

      const optimisticId = `optimistic-${randomUUID()}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        conversation_id: conversationId,
        sender_id: userId,
        kind: "voice",
        body: null,
        media_url: localUri,
        shared_activity_id: null,
        shared_profile_id: null,
        reply_to_id: null,
        edited_at: null,
        forwarded_from_message_id: null,
        forwarded_from_sender_id: null,
        expires_at: expiresAt,
        document_name: null,
        document_size_bytes: null,
        media_duration_ms: durationMs,
        waveform,
        created_at: new Date().toISOString(),
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      try {
        const path = await uploadChatMedia(
          conversationId,
          localUri,
          isEncrypted ? (data) => encryptBytesForConversation(conversationId, data) : undefined
        );
        // The sender already has the audio — seed the cache so their own
        // voice note never downloads again.
        primeMediaCache(path, localUri);
        const { error: insertError } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          sender_id: userId,
          kind: "voice",
          media_url: path,
          media_duration_ms: durationMs,
          waveform,
          expires_at: expiresAt,
        });
        if (insertError) throw insertError;
        playMessageSentSound();
      } catch (error) {
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? { ...message, pending: false, failed: true } : message
          )
        );
        throw error;
      }
    },
    [conversationId, userId, isEncrypted, encryptBytesForConversation, selfDestructSeconds]
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      // Delete the stored object BEFORE the row, because the row is the only
      // record of where the object lives — dropping it first orphans the file
      // in Storage forever. Nothing removed chat media at all previously, so
      // every deleted photo, every deleted conversation and every
      // self-destructed image left its ciphertext in the bucket permanently:
      // a cost that only grows, and for account deletion a failure to
      // actually delete the user's data.
      const target = messages.find((message) => message.id === messageId);
      if (target?.media_url) {
        const { path } = parseMediaRef(target.media_url);
        // Local file: :// means the upload never completed, so there is
        // nothing on the server to remove.
        if (!path.includes("://")) {
          const { error: storageError } = await supabase.storage
            .from("chat-media")
            .remove([path]);
          // Not fatal: a missing object (already removed, or never uploaded)
          // must not stop the message itself from being deleted.
          if (storageError) {
            console.warn("[deleteMessage] could not remove media:", storageError.message);
          }
        }
      }

      // Optimistically remove; the realtime DELETE event is a no-op afterwards.
      setMessages((current) => current.filter((message) => message.id !== messageId));
      void deleteLocalMessages([messageId]).catch(() => {});
      const { error } = await supabase.from("messages").delete().eq("id", messageId);
      if (error) throw error;
    },
    [messages]
  );

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
        void deleteLocalMessages(expired.map((message) => message.id)).catch(() => {});
        const expiredIds = new Set(expired.map((message) => message.id));
        return current.filter((message) => !expiredIds.has(message.id));
      });
    };

    const interval = setInterval(sweep, 1000);
    sweep();
    return () => clearInterval(interval);
  }, [conversationId]);

  // Track when the other side reads, so checkmarks reflect reality.
  useEffect(() => {
    if (!conversationId || !userId) return;

    const readPeerState = async () => {
      const { data } = await supabase
        .from("conversation_participants")
        .select("user_id, last_read_at")
        .eq("conversation_id", conversationId)
        .neq("user_id", userId);

      const newest = (data ?? [])
        .map((row) => row.last_read_at)
        .filter((value): value is string => !!value)
        .sort()
        .pop();
      setPeerLastReadAt(newest ?? null);
    };

    void readPeerState();

    const channel = supabase
      .channel(`read-state:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversation_participants",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void readPeerState()
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId, userId]);

  // Re-attempts decrypting ONE already-loaded message. decorateWithDecryption
  // only ever runs at load() time and for freshly-arrived realtime rows — a
  // message that failed to decrypt because this device's
  // encrypted_session_keys row was stale (see useE2ee's loadSessionKey,
  // which now deletes such a row and lets repairMissingSessionKeys
  // re-deposit a working one) stayed stuck showing "Unable to decrypt"
  // forever in an already-open chat: the repair happens on the NEXT chat
  // open, not retroactively for rows already rendered on screen. Unlike
  // ChatImage/ChatVideo (which already had a tap-to-retry), text messages
  // had no retry path at all — this is that path.
  const retryDecryption = useCallback(
    async (messageId: string) => {
      if (!isEncrypted || !conversationId) return;
      const target = messages.find((message) => message.id === messageId);
      if (!target || target.kind !== "text" || !target.body) return;
      if (!isEncryptedEnvelope(target.body)) return;

      const decrypted = await decryptForConversation(conversationId, target.body);
      if (decrypted === null) return; // Still not fixed — nothing to update.
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, decryptedBody: decrypted } : message
        )
      );
    },
    [isEncrypted, conversationId, messages, decryptForConversation]
  );

  return {
    messages,
    loading,
    peerLastReadAt,
    error,
    hasMore,
    loadOlder,
    sendVoice,
    sendMessage,
    editMessage,
    sendImage,
    sendDocument,
    deleteMessage,
    markRead,
    refresh: load,
    retryDecryption,
  };
}
