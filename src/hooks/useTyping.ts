import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "../lib/supabase";

const TYPING_TIMEOUT_MS = 3000;
const THROTTLE_MS = 1500;

/**
 * Typing indicators over Realtime broadcast rather than table writes — they're
 * ephemeral signals, so there's no reason to persist them or fire RLS checks.
 */
export function useTyping(
  conversationId: string | undefined,
  userId: string | undefined,
  displayName: string | undefined
) {
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastSentRef = useRef(0);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!conversationId || !userId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const join = () => {
      // private: true routes the join through Realtime Authorization (see
      // 040_private_typing_channel.sql) instead of the channel being world-
      // subscribable to anyone who knows the conversation id.
      const channel = supabase.channel(`typing:${conversationId}`, {
        config: { broadcast: { self: false }, private: true },
      });

      channel
        .on("broadcast", { event: "typing" }, ({ payload }) => {
          const senderId = payload?.userId as string | undefined;
          const name = (payload?.displayName as string | undefined) ?? "Someone";
          if (!senderId || senderId === userId) return;

          setTypingUsers((current) => ({ ...current, [senderId]: name }));

          // Each keystroke refreshes the expiry; the indicator clears on its
          // own if the sender stops typing or drops off.
          clearTimeout(timersRef.current[senderId]);
          timersRef.current[senderId] = setTimeout(() => {
            setTypingUsers((current) => {
              const next = { ...current };
              delete next[senderId];
              return next;
            });
          }, TYPING_TIMEOUT_MS);
        })
        // Explicit stop, sent the moment a message is actually delivered —
        // without this the indicator only cleared on the 3s timeout, so
        // sending well within that window (the common case) left "X is
        // typing…" visible for up to 3s after the message had already
        // arrived.
        .on("broadcast", { event: "typing-stopped" }, ({ payload }) => {
          const senderId = payload?.userId as string | undefined;
          if (!senderId) return;
          clearTimeout(timersRef.current[senderId]);
          delete timersRef.current[senderId];
          setTypingUsers((current) => {
            if (!(senderId in current)) return current;
            const next = { ...current };
            delete next[senderId];
            return next;
          });
        })
        .subscribe((status) => {
          if (cancelled) return;
          // A private channel can fail its first join attempt if it's
          // opened within the first moment or two of the app's process
          // (e.g. the chat screen is the very first thing shown after a
          // notification-triggered cold launch) — the restored session's
          // JWT may not have reached the Realtime socket's own auth yet.
          // Retrying once covers that window; see the identical race
          // documented on useCall.ts's joinSignalChannel.
          if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT") return;
          retryTimer = setTimeout(() => {
            if (cancelled) return;
            void supabase.removeChannel(channel);
            join();
          }, 800);
        });

      channelRef.current = channel;
    };

    join();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      Object.values(timersRef.current).forEach(clearTimeout);
      timersRef.current = {};
      setTypingUsers({});
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    };
  }, [conversationId, userId]);

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (!channelRef.current || !userId) return;
    // Throttle so a fast typist doesn't emit on every keystroke.
    if (now - lastSentRef.current < THROTTLE_MS) return;
    lastSentRef.current = now;

    void channelRef.current.send({
      type: "broadcast",
      event: "typing",
      payload: { userId, displayName },
    });
  }, [userId, displayName]);

  const notifyStoppedTyping = useCallback(() => {
    if (!channelRef.current || !userId) return;
    lastSentRef.current = 0; // let the very next keystroke send immediately
    void channelRef.current.send({
      type: "broadcast",
      event: "typing-stopped",
      payload: { userId },
    });
  }, [userId]);

  const names = Object.values(typingUsers);
  const typingLabel =
    names.length === 0
      ? null
      : names.length === 1
        ? `${names[0]} is typing…`
        : `${names.length} people are typing…`;

  return { typingLabel, notifyTyping, notifyStoppedTyping };
}
