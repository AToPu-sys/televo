import { useCallback, useEffect, useState } from "react";

import { supabase } from "../lib/supabase";
import { randomUUID } from "../lib/uuid";

export type Contact = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bio: string | null;
};

/** Every other user on the instance — the directory you can start a chat from. */
export function useContacts(userId: string | undefined) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);

    const { data, error: queryError } = await supabase
      .from("profiles")
      .select("id, display_name, username, avatar_url, bio")
      .order("display_name", { ascending: true })
      .limit(200);

    if (queryError) {
      setError(queryError.message);
      setLoading(false);
      return;
    }

    setContacts(
      (data ?? [])
        .filter((profile) => profile.id !== userId)
        .map((profile) => ({
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
  const { error: selfError } = await supabase
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: userId });

  if (selfError) throw selfError;

  const { error: otherError } = await supabase
    .from("conversation_participants")
    .insert({ conversation_id: conversationId, user_id: otherUserId });

  if (otherError) throw otherError;

  return conversationId;
}
