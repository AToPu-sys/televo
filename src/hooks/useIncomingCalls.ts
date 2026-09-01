import { useEffect } from "react";

import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";

type CallRow = Database["public"]["Tables"]["calls"]["Row"];

/**
 * Subscribes to every `calls` INSERT the user is allowed to see (RLS already
 * restricts this to conversations they participate in) so an incoming call
 * can ring from anywhere in the app, not just while a specific chat is open.
 */
export function useIncomingCalls(
  userId: string | undefined,
  onIncoming: (call: CallRow) => void
) {
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel("incoming-calls")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "calls" },
        (payload) => {
          const call = payload.new as CallRow;
          // Don't ring yourself when you're the one placing the call.
          if (call.caller_id !== userId && call.status === "ringing") {
            onIncoming(call);
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
    // onIncoming is expected to be stable (wrapped in useCallback by the caller).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
}
