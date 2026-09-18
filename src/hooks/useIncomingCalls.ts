import { useEffect, useRef } from "react";

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
  // The subscription must not be torn down and rebuilt every render, but the
  // handler it calls MUST be the current one. Keeping the callback in a ref
  // gives both: a subscription keyed only on userId, always dispatching to
  // the latest closure.
  //
  // This previously pinned the FIRST render's callback, which was a real bug,
  // not just a style issue: that closure captured useCall's first-render
  // members, which in turn captured useE2ee's keyPair while it was still
  // null (it loads asynchronously from SecureStore). The callee therefore
  // answered every incoming call with a crypto context that could not
  // decrypt anything — the caller's encrypted offer was silently dropped,
  // so Accept never had an offer to answer and the phone rang forever.
  const onIncomingRef = useRef(onIncoming);
  onIncomingRef.current = onIncoming;

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
            onIncomingRef.current(call);
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);
}
