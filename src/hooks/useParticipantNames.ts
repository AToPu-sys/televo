import { useEffect, useMemo, useState } from "react";

import { supabase } from "../lib/supabase";

/** Maps user ids to display names, for sender names in groups and reply /
 * forward attributions. Starts from the current participants, then also
 * resolves any `extraIds` it doesn't know yet — e.g. the sender of an older
 * group message who has since left, or a member added after this screen
 * opened — so their messages keep a real name instead of a placeholder. */
export function useParticipantNames(
  conversationId: string | undefined,
  selfId: string | undefined,
  extraIds: string[] = []
) {
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
      setNames((current) => {
        const map = { ...current };
        for (const profile of profiles ?? []) {
          map[profile.id] = profile.id === selfId ? "You" : profile.display_name;
        }
        return map;
      });
    })();

    return () => {
      active = false;
    };
  }, [conversationId, selfId]);

  const missingKey = useMemo(
    () =>
      Array.from(new Set(extraIds))
        .filter((id) => id && !(id in names))
        .sort()
        .join(","),
    [extraIds, names]
  );

  useEffect(() => {
    if (!missingKey) return;
    let active = true;
    const missing = missingKey.split(",");

    (async () => {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", missing);
      if (!active) return;
      setNames((current) => {
        const map = { ...current };
        for (const id of missing) {
          const profile = profiles?.find((p) => p.id === id);
          // Recorded even when not found, so an unknown id isn't re-queried
          // on every render.
          map[id] = id === selfId ? "You" : (profile?.display_name ?? "Former member");
        }
        return map;
      });
    })();

    return () => {
      active = false;
    };
  }, [missingKey, selfId]);

  return names;
}
