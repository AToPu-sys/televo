import { useEffect, useState } from "react";

import { supabase } from "../lib/supabase";

/** Maps every participant's user id to their display name, for rendering
 * reply-quote and forward attributions (which need a sender name, not just
 * an id) in both direct chats and groups. */
export function useParticipantNames(conversationId: string | undefined, selfId: string | undefined) {
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!conversationId) return;
    let active = true;

    (async () => {
      const { data: participants } = await supabase
        .from("conversation_participants")
        .select("user_id")
        .eq("conversation_id", conversationId);

      const ids = (participants ?? []).map((p) => p.user_id);
      if (ids.length === 0) return;

      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);

      if (!active) return;
      const map: Record<string, string> = {};
      for (const profile of profiles ?? []) {
        map[profile.id] = profile.id === selfId ? "You" : profile.display_name;
      }
      setNames(map);
    })();

    return () => {
      active = false;
    };
  }, [conversationId, selfId]);

  return names;
}
