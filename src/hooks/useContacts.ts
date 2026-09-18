import { useCallback, useEffect, useState } from "react";

import { ASSISTANT_USER_ID } from "../lib/assistant";
import { supabase } from "../lib/supabase";
import { randomUUID } from "../lib/uuid";

export type Contact = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bio: string | null;
};

/**
 * People the user already knows: everyone they have an existing conversation
 * with. This used to query every profile on the instance with no filtering
 * at all — a brand-new account immediately saw the entire user directory,
 * including people who had never messaged them and weren't in their phone
 * contacts. Finding someone NEW is find-friends.tsx's job (phone-number
 * matching via useContactDiscovery, which never exposes the full directory
 * either) — this list is deliberately "who I already talk to," matching how
 * WhatsApp/Telegram's contacts tab works.
 */
export function useContacts(userId: string | undefined) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setContacts([]);
      setLoading(false);
      return;
    }
    setError(null);

    const { data: participantRows, error: participantsError } = await supabase
      .from("conversation_participants")
      .select("conversation_id, conversations!inner(kind)")
      .eq("user_id", userId);

    if (participantsError) {
      setError(participantsError.message);
      setLoading(false);
      return;
    }

    const directConversationIds = (participantRows ?? [])
      .filter((row) => row.conversations.kind === "direct")
      .map((row) => row.conversation_id);

    if (directConversationIds.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    const { data: otherParticipants, error: othersError } = await supabase
      .from("conversation_participants")
      .select("user_id")
      .in("conversation_id", directConversationIds)
      .neq("user_id", userId);

    if (othersError) {
      setError(othersError.message);
      setLoading(false);
      return;
    }

    const otherIds = Array.from(new Set((otherParticipants ?? []).map((row) => row.user_id))).filter(
      (id) => id !== ASSISTANT_USER_ID
    );

    if (otherIds.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    const { data, error: queryError } = await supabase
      .from("profiles")
      .select("id, display_name, username, avatar_url, bio")
      .in("id", otherIds)
      .order("display_name", { ascending: true });

    if (queryError) {
      setError(queryError.message);
      setLoading(false);
      return;
    }

    setContacts(
      (data ?? []).map((profile) => ({
        id: profile.id,
        displayName: profile.display_name,
        username: String(profile.username),
        avatarUrl: profile.avatar_url,
        bio: profile.bio,
      }))
    );
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  return { contacts, loading, error, refresh: load };
}

/**
 * Returns the existing direct conversation with `otherUserId`, creating one if
 * there isn't a chat between the two users yet.
 */
export async function findOrCreateDirectChat(userId: string, otherUserId: string) {
  // Conversations the current user is in...
  const { data: mine, error: mineError } = await supabase
    .from("conversation_participants")
    .select("conversation_id, conversations!inner ( id, kind )")
    .eq("user_id", userId);

  if (mineError) throw mineError;

  const directIds = (mine ?? [])
    .filter((row) => row.conversations?.kind === "direct")
    .map((row) => row.conversation_id);

  // ...intersected with conversations the other user is in.
  if (directIds.length > 0) {
    const { data: theirs, error: theirsError } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", otherUserId)
      .in("conversation_id", directIds);

    if (theirsError) throw theirsError;
    const existing = theirs?.[0]?.conversation_id;
    if (existing) return existing;
  }

  // The id is generated client-side on purpose. Chaining .select() onto the
  // insert would make PostgREST do an INSERT ... RETURNING, and the SELECT
  // policy on conversations only admits existing participants — which we
  // aren't until the participant rows below exist. So the insert would fail
  // even though the row is valid.
  const conversationId = randomUUID();

  const { error: createError } = await supabase
    .from("conversations")
    .insert({ id: conversationId, kind: "direct", created_by: userId });

  if (createError) throw createError;

  // Order matters under RLS: the insert policy allows adding yourself, or
  // adding anyone once you're already a participant. So add self first, then
  // the other person — a single batched insert can fail the second row.
  // If either insert below fails, the conversation row above is orphaned
  // (only the creator a participant, or no participants at all) — best-effort
  // clean it up rather than leaving dead rows behind on every network blip.
  const { error: selfError } = await supabase
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: userId });

  if (selfError) {
    void supabase.from("conversations").delete().eq("id", conversationId);
    throw selfError;
  }

  const { error: otherError } = await supabase
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: otherUserId });

  if (otherError) {
    void supabase.from("conversations").delete().eq("id", conversationId);
    throw otherError;
  }

  return conversationId;
}

/** Creates a group conversation with the given title and members. */
export async function createGroupChat(userId: string, title: string, memberIds: string[]) {
  const conversationId = randomUUID();

  const { error: createError } = await supabase
    .from("conversations")
    .insert({ id: conversationId, kind: "group", title: title.trim(), created_by: userId });

  if (createError) throw createError;

  // Creator first — the participant policy only lets you add others once you
  // are a member yourself. The creator is also the group admin.
  const { error: selfError } = await supabase
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: userId, is_admin: true });

  if (selfError) {
    void supabase.from("conversations").delete().eq("id", conversationId);
    throw selfError;
  }

  const others = memberIds.filter((id) => id !== userId);
  if (others.length > 0) {
    const { error: membersError } = await supabase.from("conversation_participants").insert(
      others.map((id) => ({
        conversation_id: conversationId,
        user_id: id,
      }))
    );
    if (membersError) {
      void supabase.from("conversations").delete().eq("id", conversationId);
      throw membersError;
    }
  }

  return conversationId;
}
