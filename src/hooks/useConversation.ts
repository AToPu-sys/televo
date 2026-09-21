import { useCallback, useEffect, useState } from "react";

import { supabase } from "../lib/supabase";

export type ConversationHeader = {
  id: string;
  kind: "direct" | "group";
  title: string;
  subtitle: string | null;
  avatarUrl: string | null;
  otherUserId: string | null;
  isEncrypted: boolean;
  selfDestructSeconds: number | null;
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
        is_encrypted,
        self_destruct_seconds,
        conversation_participants ( user_id )
      `
      )
      .eq("id", conversationId)
      .single();

    if (error || !data) {
      // Previously silent — a query failure here (session not fully
      // established yet, RLS denying the row, a network blip) left
      // `conversation` null with zero trace anywhere, which looked
      // identical to "this chat genuinely doesn't exist" from every call
      // site downstream. Logged so a report like "every chat shows Unable
      // to decrypt" can actually be diagnosed instead of guessed at.
      if (error) {
        console.error("[useConversation] load failed:", error.message, { conversationId });
      }
      setLoading(false);
      return;
    }

    const participants = data.conversation_participants ?? [];

    if (data.kind === "group") {
      setConversation({
        id: data.id,
        kind: "group",
        title: data.title ?? "Group",
        subtitle: `${participants.length} members`,
        avatarUrl: null,
        otherUserId: null,
        // Was hardcoded false regardless of the server's actual value —
        // startEncryptedChat supports groups (wraps the session key to every
        // member), but the client could never see that a group was already
        // encrypted. That made the chat screen's auto-encrypt effect try to
        // re-encrypt an already-encrypted group on every open (generating a
        // new session key each time, never actually used for sending since
        // useMessages was ALSO never told the group was encrypted), and it
        // silently sent every group message in plaintext regardless of the
        // server-side flag.
        isEncrypted: data.is_encrypted,
        selfDestructSeconds: data.self_destruct_seconds,
      });
      setLoading(false);
      return;
    }

    const other = participants.find((participant) => participant.user_id !== userId);

    if (!other) {
      setConversation({
        id: data.id,
        kind: "direct",
        title: "Unknown",
        subtitle: null,
        avatarUrl: null,
        otherUserId: null,
        isEncrypted: data.is_encrypted,
        selfDestructSeconds: data.self_destruct_seconds,
      });
      setLoading(false);
      return;
    }

    // Published immediately with a placeholder title, BEFORE the profile
    // round trip below — otherUserId and isEncrypted (everything
    // app/chat/[id].tsx actually gates message loading and encryption on)
    // are already known at this point. Waiting for the profile query first
    // used to hold `loading` true for two SEQUENTIAL round trips
    // (conversations, then profiles) before useMessages was even allowed to
    // start fetching — the profile is display-only (name/avatar in the
    // header) and has no bearing on whether messages can load, so gating on
    // it here was pure added latency on every single chat open, felt as
    // "chats take a while to open" even on a fast connection.
    // Empty title, not a placeholder string: app/chat/[id].tsx's header
    // already falls back to "Chat" for a falsy title (`conversation?.title
    // ?? "Chat"`) and separately checks its OWN `loadingConversation` flag
    // for a "…" spinner state — a literal "…" here would have raced that
    // and briefly shown as the actual conversation title once `loading`
    // flips false one line down, instead of either intended state.
    setConversation({
      id: data.id,
      kind: "direct",
      title: "",
      subtitle: null,
      avatarUrl: null,
      otherUserId: other.user_id,
      isEncrypted: data.is_encrypted,
      selfDestructSeconds: data.self_destruct_seconds,
    });
    setLoading(false);

    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, username, avatar_url")
      .eq("id", other.user_id)
      .single();

    // Fills in the real name/avatar once it arrives — a second, later render,
    // not a second thing the screen has to wait on before showing anything.
    setConversation((current) =>
      current && current.id === data.id
        ? {
            ...current,
            title: profile?.display_name ?? "Unknown",
            subtitle: profile?.username ? `@${String(profile.username)}` : null,
            avatarUrl: profile?.avatar_url ?? null,
          }
        : current
    );
  }, [conversationId, userId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  return { conversation, loading, refresh: load };
}
