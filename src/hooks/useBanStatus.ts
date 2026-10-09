import { useEffect, useState } from "react";

import { supabase } from "../lib/supabase";

export type BanStatus = {
  bannedUntil: string | null; // null = not banned; an ISO timestamp in the far
  // future (e.g. 'infinity') reads as permanent in the UI
  bannedReason: string | null;
};

/** Polled rather than realtime-subscribed: a ban is rare and not
 * time-sensitive the way a message is — the user finds out the moment they
 * next try to act (send a message, place a call) and enforce_ban_on_message/
 * enforce_ban_on_call already reject that server-side regardless of whether
 * this hook has caught up yet. This exists to explain WHY, not to enforce
 * anything itself. */
export function useBanStatus(userId: string | undefined) {
  const [status, setStatus] = useState<BanStatus | null>(null);

  useEffect(() => {
    if (!userId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const id = userId;

    async function load() {
      const { data } = await supabase
        .from("user_moderation")
        .select("banned_until, banned_reason")
        .eq("user_id", id)
        .maybeSingle();
      if (cancelled) return;
      const until = data?.banned_until ?? null;
      setStatus({
        bannedUntil: until && new Date(until).getTime() > Date.now() ? until : null,
        bannedReason: data?.banned_reason ?? null,
      });
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return status;
}
