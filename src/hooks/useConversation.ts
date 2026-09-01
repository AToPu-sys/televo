import { useCallback, useEffect, useState } from "react";

import { supabase } from "../lib/supabase";

export type ConversationHeader = {
  id: string;
  title: string;
  subtitle: string | null;
  avatarUrl: string | null;
};

/** Loads the header details for one conversation (title, avatar, member count). */
export function useConversation(conversationId: string | undefined, userId: string | undefined) {
  const [conversation, setConversation] = useState<ConversationHeader | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!conversationId) {
      setConversation(null);
      setLoading(false);
      return;
    }

    // participants.user_id references auth.users rather than public.profiles,
    // so the profile is fetched in a follow-up query rather than embedded.
    const { data, error } = await supabase
      .from("conversations")
      .select(
        `
        id,
        kind,
        title,
        conversation_participants ( user_id )
      `
      )
      .eq("id", conversationId)
      .single();

    if (error || !data) {
      setLoading(false);
      return;
    }

    const participants = data.conversation_participants ?? [];

    if (data.kind === "group") {
      setConversation({
        id: data.id,
        title: data.title ?? "Group",
        subtitle: `${participants.length} members`,
        avatarUrl: null,
      });
      setLoading(false);
      return;
    }

    const other = participants.find((participant) => participant.user_id !== userId);

    if (!other) {
      setConversation({ id: data.id, title: "Unknown", subtitle: null, avatarUrl: null });
      setLoading(false);
      return;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, username, avatar_url")
      .eq("id", other.user_id)
      .single();

    setConversation({
      id: data.id,
      title: profile?.display_name ?? "Unknown",
      subtitle: profile?.username ? `@${String(profile.username)}` : null,
      avatarUrl: profile?.avatar_url ?? null,
    });
    setLoading(false);
  }, [conversationId, userId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  return { conversation, loading, refresh: load };
}
