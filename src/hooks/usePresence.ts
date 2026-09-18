import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { supabase } from "../lib/supabase";

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Keeps profiles.last_seen_at fresh for the signed-in user while the app is
 * foregrounded: one write on mount, one every 60s, and one on backgrounding
 * so "last seen" reflects roughly when they actually stopped using the app
 * rather than going stale immediately.
 */
export function usePresenceHeartbeat(userId: string | undefined) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!userId) return;

    const touch = () => {
      // .catch, not bare void: an update that rejects (a dropped network
      // request, RLS momentarily unhappy right after sign-in before the
      // fresh JWT has propagated) is an unhandled promise rejection
      // otherwise — the same class of bug that made a failure in
      // E2eeProvider's init silently reset the whole JS context with no
      // Error Boundary to catch it. A stale last_seen_at is harmless; a
      // silent app reset is not.
      supabase
        .from("profiles")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", userId)
        .then(({ error }) => {
          if (error) console.error("[usePresenceHeartbeat] update failed:", error.message);
        });
    };

    touch();
    intervalRef.current = setInterval(touch, HEARTBEAT_INTERVAL_MS);

    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === "active") {
        touch();
      } else if (state === "background" || state === "inactive") {
        touch();
      }
    };
    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      subscription.remove();
    };
  }, [userId]);
}
