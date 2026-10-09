import { useEffect, useState } from "react";

import { supabase } from "../lib/supabase";

const ONLINE_THRESHOLD_MS = 90_000; // matches roughly 1.5x the heartbeat interval

export type PresenceInfo = { label: string | null };

/**
 * Reads another user's last-seen status, enforcing Telegram's reciprocal
 * rule: if the VIEWER has hidden their own last seen, they can't see anyone
 * else's either (checked client-side here; the meaningful enforcement is
 * that hiding last_seen_at from being read at all would need RLS — this
 * profiles column is otherwise publicly readable like the rest of the
 * profile, so reciprocity is a UI-level courtesy, not a security boundary).
 *
 * The target's timestamp comes from last_seen_for() (064_frozen_last_seen_when_blocked.sql),
 * not a raw profiles select: that RPC freezes the value at whenever a block
 * between the two of them happened, in either direction, so blocking someone
 * shows "was here a while ago" instead of their live presence continuing to
 * update — the same way Telegram reads once a block exists, distinct from a
 * DELETED account (profiles.display_name itself becomes "Deleted Account"
 * for those, with their real last_seen_at left untouched here).
 */
export function useLastSeen(viewerId: string | undefined, targetUserId: string | null | undefined) {
  const [presence, setPresence] = useState<PresenceInfo>({ label: null });
  // Presence was fetched once and never again, so "online" stayed frozen on
  // screen after the peer left (and "last seen ..." never flipped to online).
  // Re-poll on an interval matching the sender's heartbeat.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!viewerId || !targetUserId) {
      setPresence({ label: null });
      return;
    }

    let active = true;

    (async () => {
      const { data: viewer } = await supabase
        .from("profiles")
        .select("show_last_seen")
        .eq("id", viewerId)
        .single();

      if (!active) return;
      if (viewer && !viewer.show_last_seen) {
        setPresence({ label: null });
        return;
      }

      const { data: target } = await supabase
        .from("profiles")
        .select("show_last_seen")
        .eq("id", targetUserId)
        .single();

      if (!active) return;
      if (!target || !target.show_last_seen) {
        setPresence({ label: null });
        return;
      }

      const { data: lastSeenAt } = await supabase.rpc("last_seen_for", {
        p_target_user_id: targetUserId,
      });

      if (!active) return;
      if (!lastSeenAt) {
        setPresence({ label: null });
        return;
      }

      setPresence({ label: formatPresence(lastSeenAt) });
    })();

    return () => {
      active = false;
    };
  }, [viewerId, targetUserId, tick]);

  return presence;
}

function formatPresence(lastSeenAtIso: string): string {
  const lastSeen = new Date(lastSeenAtIso).getTime();
  const now = Date.now();

  if (now - lastSeen < ONLINE_THRESHOLD_MS) {
    return "online";
  }

  const date = new Date(lastSeenAtIso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  if (sameDay) {
    return `last seen today at ${time}`;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `last seen yesterday at ${time}`;
  }

  return `last seen ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
