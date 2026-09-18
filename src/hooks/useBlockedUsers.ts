import { useCallback, useEffect, useState } from "react";

import { supabase } from "../lib/supabase";

export type BlockedUser = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
};

export function useBlockedUsers(userId: string | undefined) {
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!userId) {
      setBlocked([]);
      setLoading(false);
      return;
    }

    const { data: rows } = await supabase
      .from("blocked_users")
      .select("blocked_id")
      .eq("blocker_id", userId);

    const ids = (rows ?? []).map((row) => row.blocked_id);
    if (ids.length === 0) {
      setBlocked([]);
      setLoading(false);
      return;
    }

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name, username, avatar_url")
      .in("id", ids);

    setBlocked(
      (profiles ?? []).map((profile) => ({
        id: profile.id,
        displayName: profile.display_name,
        username: String(profile.username),
        avatarUrl: profile.avatar_url,
      }))
    );
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const unblock = useCallback(
    async (blockedId: string) => {
      if (!userId) return;
      const { error } = await supabase
        .from("blocked_users")
        .delete()
        .eq("blocker_id", userId)
        .eq("blocked_id", blockedId);
      if (error) throw error;
      setBlocked((current) => current.filter((entry) => entry.id !== blockedId));
    },
    [userId]
  );

  return { blocked, loading, unblock, refresh: load };
}

export async function blockUser(blockerId: string, blockedId: string) {
  const { error } = await supabase
    .from("blocked_users")
    .insert({ blocker_id: blockerId, blocked_id: blockedId });
  if (error) throw error;
}

export async function unblockUser(blockerId: string, blockedId: string) {
  const { error } = await supabase
    .from("blocked_users")
    .delete()
    .eq("blocker_id", blockerId)
    .eq("blocked_id", blockedId);
  if (error) throw error;
}

export async function isUserBlocked(blockerId: string, otherUserId: string): Promise<boolean> {
  const { data } = await supabase
    .from("blocked_users")
    .select("blocked_id")
    .eq("blocker_id", blockerId)
    .eq("blocked_id", otherUserId)
    .maybeSingle();
  return !!data;
}
