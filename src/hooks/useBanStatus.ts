import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { supabase } from "../lib/supabase";

export type BanStatus = {
  bannedUntil: string | null; // null = not banned; an ISO timestamp in the far
  // future (e.g. 'infinity') reads as permanent in the UI
  bannedReason: string | null;
};

/** Enforcement is server-side (enforce_ban_on_message / enforce_ban_on_call);
 * this only explains WHY sending fails and gets out of the way once a ban
 * ends. It used to load once, so a suspension lifted by a moderator (or one
 * that simply ran out) kept the app behind the ban screen until a restart.
 * Now it re-checks every 30 s while suspended, and whenever the app comes
 * back to the foreground. */
const BANNED_POLL_MS = 30_000;

export function useBanStatus(userId: string | undefined) {
  const [status, setStatus] = useState<BanStatus | null>(null);

  useEffect(() => {
    if (!userId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const id = userId;

    async function load() {
      const { data } = await supabase
        .from("user_moderation")
        .select("banned_until, banned_reason")
        .eq("user_id", id)
        .maybeSingle();
      if (cancelled) return;
      const until = data?.banned_until ?? null;
      const active = !!until && new Date(until).getTime() > Date.now();
      setStatus({ bannedUntil: active ? until : null, bannedReason: data?.banned_reason ?? null });
      if (timer) clearTimeout(timer);
      timer = active ? setTimeout(() => void load(), BANNED_POLL_MS) : null;
    }

    void load();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [userId]);

  return status;
}
