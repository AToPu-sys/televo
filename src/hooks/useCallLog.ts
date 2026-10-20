import { useCallback, useEffect, useState } from "react";

import { supabase } from "../lib/supabase";
import { onUserChannelResync, subscribeUserEvents } from "../lib/userChannel";
import type { Database } from "../types/database";

type CallRow = Database["public"]["Tables"]["calls"]["Row"];

export type CallLogEntry = {
  id: string;
  conversationId: string;
  peerId: string;
  peerName: string;
  peerAvatarUrl: string | null;
  kind: "audio" | "video";
  direction: "outgoing" | "incoming";
  status: CallRow["status"];
  startedAt: string;
  durationSeconds: number | null;
};

const PAGE_SIZE = 100;

/** Every call the signed-in user was party to, across every conversation —
 * Telegram's "Calls" tab. RLS on `calls` already scopes this to conversations
 * the user participates in, same as messages. */
export function useCallLog(userId: string | undefined) {
  const [entries, setEntries] = useState<CallLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setEntries([]);
      setLoading(false);
      return;
    }

    setError(null);

    const { data: calls, error: callsError } = await supabase
      .from("calls")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (callsError) {
      setError(callsError.message);
      setLoading(false);
      return;
    }

    const relevant = calls ?? [];
    const conversationIds = Array.from(new Set(relevant.map((call) => call.conversation_id)));

    // Resolve the "other participant" for each conversation the calls
    // belong to, same pattern as useChats — conversation_participants.user_id
    // references auth.users, so profiles need a follow-up query.
    const { data: participantRows } = conversationIds.length
      ? await supabase
          .from("conversation_participants")
          .select("conversation_id, user_id")
          .in("conversation_id", conversationIds)
      : { data: [] };

    const otherUserByConversation = new Map<string, string>();
    for (const row of participantRows ?? []) {
      if (row.user_id !== userId) {
        otherUserByConversation.set(row.conversation_id, row.user_id);
      }
    }

    const otherUserIds = Array.from(new Set(Array.from(otherUserByConversation.values())));
    const { data: profiles } = otherUserIds.length
      ? await supabase.from("profiles").select("id, display_name, avatar_url").in("id", otherUserIds)
      : { data: [] };

    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

    setEntries(
      relevant.map((call) => {
        const peerId = otherUserByConversation.get(call.conversation_id) ?? "";
        const profile = profileById.get(peerId);
        const durationSeconds =
          call.answered_at && call.ended_at
            ? Math.max(
                0,
                Math.round(
                  (new Date(call.ended_at).getTime() - new Date(call.answered_at).getTime()) / 1000
                )
              )
            : null;

        return {
          id: call.id,
          conversationId: call.conversation_id,
          peerId,
          peerName: profile?.display_name ?? "Unknown",
          peerAvatarUrl: profile?.avatar_url ?? null,
          kind: call.kind,
          direction: call.caller_id === userId ? "outgoing" : "incoming",
          status: call.status,
          startedAt: call.started_at,
          durationSeconds,
        };
      })
    );
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!userId) return;

    // Only this user's calls arrive on their channel (src/lib/userChannel.ts);
    // after a reconnect, re-read in case one was missed.
    const offEvents = subscribeUserEvents(userId, (event) => {
      if (event.type === "call_insert" || event.type === "call_update") void load();
    });
    const offResync = onUserChannelResync(userId, () => void load());
    return () => {
      offEvents();
      offResync();
    };
  }, [userId, load]);

  return { entries, loading, error, refresh: load };
}
