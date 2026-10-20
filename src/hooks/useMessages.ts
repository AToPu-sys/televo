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
import {
  cancelOutboxEntry,
  enqueueOutbox,
  flushOutbox,
  isInOutbox,
  outboxEntriesFor,
  restoreOutbox,
  retryOutboxEntry,
  subscribeOutbox,
  type OutboxEntry,
} from "../lib/outbox";
import { supabase } from "../lib/supabase";
import { onUserChannelResync, subscribeUserEvents } from "../lib/userChannel";
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

/** A queued text message (src/lib/outbox.ts) as a bubble. `body` is what
 * will be stored — for a Secret Chat the envelope, which
 * decorateWithDecryption opens like any other row. expires_at stays unset
 * until the server row arrives, so a self-destruct timer can't make a
 * message vanish from the screen while it's still waiting to be sent. */
function messageFromOutbox(entry: OutboxEntry, failed: boolean): ChatMessage {
  return {
    id: entry.id,
    conversation_id: entry.conversationId,
    sender_id: entry.senderId,
    kind: "text",
    body: entry.body,
    media_url: null,
    shared_activity_id: null,
    shared_profile_id: null,
    reply_to_id: entry.replyToId,
    edited_at: null,
    forwarded_from_message_id: null,
    forwarded_from_sender_id: null,
    expires_at: null,
    document_name: null,
    document_size_bytes: null,
    media_duration_ms: null,
    waveform: null,
    created_at: entry.createdAt,
    pending: !failed,
    failed,
  };
}

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
  // Latest messages for callbacks handed to memoized bubbles, which keep
  // whichever callback they rendered with.
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  // Ids delivered live on the user channel, so a load() racing them can't
  // drop them (see withUnsent).
  const liveIdsRef = useRef(new Set<string>());
  const [hasMore, setHasMore] = useState(false);
  // The other participant's last_read_at, so a sent message can show whether
  // it was actually read. Previously every sent message showed a double
  // checkmark unconditionally, which simply lied to the user.
  const [peerLastReadAt, setPeerLastReadAt] = useState<string | null>(null);
  const loadingOlderRef = useRef(false);
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
    let unsent: ChatMessage[] = [];
    try {
      if (userId) {
        await bindLocalMessagesToUser(userId);
        await restoreOutbox(userId);
      }
      unsent = await decorateWithDecryption(
        outboxEntriesFor(conversationId).map(({ entry, failed }) => messageFromOutbox(entry, failed))
      );
      const local = await readLocalMessages(conversationId, PAGE_SIZE);
      if (local.length > 0 && runId === loadRunIdRef.current) {
        const decoratedLocal = await decorateWithDecryption(local);
        if (runId === loadRunIdRef.current) {
          setMessages((current) => withUnsent(decoratedLocal, current, unsent));
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
        setMessages((current) => withUnsent(decorated, current, unsent));
        setHasMore(rows.length === PAGE_SIZE);
      }
    }
    if (runId === loadRunIdRef.current) setLoading(false);
  }, [conversationId, userId, decorateWithDecryption]);

  /** A (re)load only knows server rows; this keeps what exists only on this
   * device so far — queued or failed text, uploads in flight — on screen,
   * newest first above them. A reconnect refetch used to wipe queued
   * messages off the screen until they landed. */
  function withUnsent(serverRows: ChatMessage[], current: ChatMessage[], queued: ChatMessage[]): ChatMessage[] {
    const onServer = new Set(serverRows.map((message) => message.id));
    const newestOnServer = serverRows[0]?.created_at;
    const extra = new Map<string, ChatMessage>();
    for (const message of current) {
      if (message.conversation_id !== conversationId || onServer.has(message.id)) continue;
      if (
        message.pending ||
        isInOutbox(message.id) ||
        (message.failed && message.kind === "text") ||
        // Arrived live while this fetch was in flight.
        (liveIdsRef.current.has(message.id) && (!newestOnServer || message.created_at > newestOnServer))
      ) {
        extra.set(message.id, message);
      }
    }
    for (const message of queued) {
      if (!onServer.has(message.id) && !extra.has(message.id) && isInOutbox(message.id)) {
        extra.set(message.id, message);
      }
    }
    const unsentFirst = [...extra.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return [...unsentFirst, ...serverRows];
  }

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

  // Live changes to this chat arrive on the user's channel
  // (src/lib/userChannel.ts) as complete rows — no per-message refetch.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!conversationId || !userId) return;

    const onInsert = async (incoming: MessageRow) => {
      liveIdsRef.current.add(incoming.id);
      void upsertLocalMessages([incoming]).catch(() => {});
      const [decorated] = await decorateWithDecryption([incoming]);

      setMessages((current) => {
        // Our own text message, sent under an id chosen on this device
        // (src/lib/outbox.ts): replace exactly that bubble. Matching by
        // sender alone used to drop EVERY pending message of ours in a
        // Secret Chat on the first echo, so a burst of messages blinked
        // out and back in.
        if (current.some((message) => message.id === decorated.id)) {
          return current.map((message) => (message.id === decorated.id ? decorated : message));
        }
        // Media still goes up under a temporary "optimistic-" id — swap
        // that copy for the server row rather than showing it twice.
        // Compare by the ciphertext body when encrypted (plaintext bodies
        // differ by nonce each time, so they'd never match).
        const withoutOptimistic = current.filter((message) => {
          if (!message.pending || !message.id.startsWith("optimistic-")) return true;
          const isOurEcho =
            message.sender_id === incoming.sender_id &&
            message.kind === incoming.kind &&
            (isEncrypted || message.body === incoming.body);
          return !isOurEcho;
        });
        return [decorated, ...withoutOptimistic];
      });
    };

    const onUpdate = async (updated: MessageRow) => {
      void upsertLocalMessages([updated]).catch(() => {});
      const [decorated] = await decorateWithDecryption([updated]);
      setMessages((current) =>
        current.map((message) => (message.id === decorated.id ? decorated : message))
      );
    };

    const offEvents = subscribeUserEvents(userId, (event) => {
      switch (event.type) {
        case "message_insert":
          if (event.message.conversation_id === conversationId) void onInsert(event.message);
          return;
        case "message_update":
          if (event.message.conversation_id === conversationId) void onUpdate(event.message);
          return;
        case "message_delete":
          if (event.conversation_id !== conversationId) return;
          void deleteLocalMessages([event.id]).catch(() => {});
          setMessages((current) => current.filter((message) => message.id !== event.id));
          return;
        case "participant_update":
          // Read receipts: the newest read position among the others.
          if (event.conversation_id !== conversationId || event.user_id === userId || !event.last_read_at) return;
          setPeerLastReadAt((current) =>
            !current || event.last_read_at! > current ? event.last_read_at : current
          );
          return;
      }
    });

    // Realtime has no replay: after a drop (handover, tunnel, background)
    // refetch, and send whatever was queued meanwhile.
    const offResync = onUserChannelResync(userId, () => {
      void loadRef.current();
      void flushOutbox();
    });

    return () => {
      offEvents();
      offResync();
    };
  }, [conversationId, userId, isEncrypted, decorateWithDecryption]);

  // Bubbles follow the send queue: clock while queued or sending, red when
  // the server rejected it, plain once it landed.
  useEffect(() => {
    if (!conversationId) return;
    return subscribeOutbox((entry, status) => {
      if (entry.conversationId !== conversationId) return;
      if (status === "sent") playMessageSentSound();
      setMessages((current) =>
        current.map((message) => {
          if (message.id !== entry.id) return message;
          if (status === "sent") return { ...message, pending: false, failed: false };
          if (status === "failed") return { ...message, pending: false, failed: true };
          return { ...message, pending: true, failed: false };
        })
      );
    });
  }, [conversationId]);

  const sendMessage = useCallback(
    async (body: string, replyToId?: string | null) => {
      const trimmed = body.trim();
      if (!trimmed || !conversationId || !userId) return;

      // The message's real id, chosen here so a retry can never post it
      // twice (see src/lib/outbox.ts).
      const messageId = randomUUID();
      const createdAt = new Date().toISOString();

      const optimistic: ChatMessage = {
        id: messageId,
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
        // Set by the server row; see messageFromOutbox.
        expires_at: null,
        document_name: null,
        document_size_bytes: null,
        media_duration_ms: null,
        waveform: null,
        created_at: createdAt,
        pending: true,
      };
      setMessages((current) => [optimistic, ...current]);

      // Encrypted now, once: the queue (and its copy on disk) only ever
      // holds the envelope.
      let storedBody: string;
      try {
        storedBody = isEncrypted ? await encryptForConversation(conversationId, trimmed) : trimmed;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[sendMessage] failed:",
          error instanceof Error ? error.message : error,
          { conversationId, isEncrypted }
        );
        // Leave the bubble in place but mark it failed, so the text isn't
        // lost; a tap retries (retrySend).
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId ? { ...message, pending: false, failed: true } : message
          )
        );
        throw error;
      }

      enqueueOutbox({
        id: messageId,
        conversationId,
        senderId: userId,
        body: storedBody,
        replyToId: replyToId ?? null,
        selfDestructSeconds,
        createdAt,
      });
    },
    [conversationId, userId, isEncrypted, encryptForConversation, selfDestructSeconds]
  );

  /** Tap on a red bubble: back into the queue, or — when it never got that
   * far (encryption failed) — sent again from its text. */
  const retrySend = useCallback(
    async (messageId: string) => {
      if (retryOutboxEntry(messageId)) return;
      const target = messagesRef.current.find((message) => message.id === messageId);
      if (!target?.failed || target.kind !== "text") return;
      const text = target.decryptedBody ?? target.body;
      if (!text) return;
      setMessages((current) => current.filter((message) => message.id !== messageId));
      await sendMessage(text, target.reply_to_id);
    },
    [sendMessage]
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
        // The sender already has the file — keep it as the cached copy so
        // their own photo or video is there offline and never downloads back.
        primeMediaCache(path, localUri);
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
        primeMediaCache(path, localUri);
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
      // Not sent yet: just stop it from going out.
      cancelOutboxEntry(messageId);
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

    // Live updates come through the user channel (see the effect above);
    // this re-reads after a reconnect, when some may have been missed.
    const offResync = onUserChannelResync(userId, () => void readPeerState());

    return () => {
      offResync();
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
    retrySend,
  };
}
