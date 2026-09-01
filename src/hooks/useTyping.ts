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

    const channel = supabase.channel(`typing:${conversationId}`, {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const senderId = payload?.userId as string | undefined;
        const name = (payload?.displayName as string | undefined) ?? "Someone";
        if (!senderId || senderId === userId) return;

        setTypingUsers((current) => ({ ...current, [senderId]: name }));

        // Each keystroke refreshes the expiry; the indicator clears on its own
        // if the sender stops typing or drops off.
        clearTimeout(timersRef.current[senderId]);
        timersRef.current[senderId] = setTimeout(() => {
          setTypingUsers((current) => {
            const next = { ...current };
            delete next[senderId];
            return next;
          });
        }, TYPING_TIMEOUT_MS);
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      Object.values(timersRef.current).forEach(clearTimeout);
      timersRef.current = {};
      setTypingUsers({});
      void supabase.removeChannel(channel);
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

  const names = Object.values(typingUsers);
  const typingLabel =
    names.length === 0
      ? null
      : names.length === 1
        ? `${names[0]} is typing…`
        : `${names.length} people are typing…`;

  return { typingLabel, notifyTyping };
}
