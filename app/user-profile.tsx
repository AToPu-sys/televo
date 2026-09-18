import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "../src/components/Avatar";
import { Button } from "../src/components/Button";
import { useAuth } from "../src/hooks/useAuth";
import { blockUser, isUserBlocked, unblockUser } from "../src/hooks/useBlockedUsers";
import { useE2ee } from "../src/hooks/useE2ee";
import { useLastSeen } from "../src/hooks/useLastSeen";
import { useTheme } from "../src/hooks/useTheme";
import { fetchDecryptedMediaFile, parseMediaRef, signedChatMediaUrl } from "../src/lib/media";
import { supabase } from "../src/lib/supabase";
import { spacing } from "../src/theme";
import type { Database } from "../src/types/database";

type Profile = {
  display_name: string;
  username: string;
  bio: string | null;
  avatar_url: string | null;
};

type MediaMessage = {
  id: string;
  kind: "image" | "video";
  media_url: string;
  created_at: string;
};

type DocumentMessage = {
  id: string;
  media_url: string;
  document_name: string | null;
  document_size_bytes: number | null;
  created_at: string;
};

type CallRow = {
  id: string;
  kind: Database["public"]["Enums"]["call_kind"];
  status: Database["public"]["Enums"]["call_status"];
  caller_id: string;
  started_at: string;
  ended_at: string | null;
};

/**
 * Read-only profile view for someone else — tapping a chat's header title/
 * avatar used to do nothing. Mirrors Telegram's contact info screen: avatar,
 * name, @username, bio, and block/report actions.
 */
export default function UserProfileScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { userId, conversationId } = useLocalSearchParams<{
    userId: string;
    conversationId?: string;
  }>();
  const { decryptBytesForConversation } = useE2ee();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const { label: presenceLabel } = useLastSeen(user?.id, userId);

  const [media, setMedia] = useState<MediaMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentMessage[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [mediaTab, setMediaTab] = useState<"media" | "files" | "calls">("media");

  useEffect(() => {
    if (!userId) return;
    let active = true;

    supabase
      .from("profiles")
      .select("display_name, username, bio, avatar_url")
      .eq("id", userId)
      .single()
      .then(({ data }) => {
        if (active) setProfile(data);
        setLoading(false);
      });

    if (user?.id) {
      isUserBlocked(user.id, userId)
        .then((value) => active && setBlocked(value))
        .catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [userId, user?.id]);

  useEffect(() => {
    if (!conversationId) return;
    let active = true;

    supabase
      .from("messages")
      .select("id, kind, media_url, created_at")
      .eq("conversation_id", conversationId)
      .in("kind", ["image", "video"])
      .not("media_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(60)
      .then(({ data }) => {
        if (!active || !data) return;
        setMedia(
          data
            .filter((row): row is typeof row & { media_url: string; kind: "image" | "video" } =>
              !!row.media_url && (row.kind === "image" || row.kind === "video")
            )
            .map((row) => ({
              id: row.id,
              kind: row.kind,
              media_url: row.media_url,
              created_at: row.created_at,
            }))
        );
      });

    supabase
      .from("messages")
      .select("id, media_url, document_name, document_size_bytes, created_at")
      .eq("conversation_id", conversationId)
      .eq("kind", "document")
      .not("media_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(60)
      .then(({ data }) => {
        if (!active || !data) return;
        setDocuments(
          data
            .filter((row): row is typeof row & { media_url: string } => !!row.media_url)
            .map((row) => ({
              id: row.id,
              media_url: row.media_url,
              document_name: row.document_name,
              document_size_bytes: row.document_size_bytes,
              created_at: row.created_at,
            }))
        );
      });

    supabase
      .from("calls")
      .select("id, kind, status, caller_id, started_at, ended_at")
      .eq("conversation_id", conversationId)
      .in("status", ["ended", "missed", "declined"])
      .order("started_at", { ascending: false })
      .limit(60)
      .then(({ data }) => {
        if (active && data) setCalls(data);
      });

    return () => {
      active = false;
    };
  }, [conversationId]);

  async function handleToggleBlock() {
    if (!user?.id || !userId || busy) return;
    setBusy(true);
    try {
      if (blocked) {
        await unblockUser(user.id, userId);
        setBlocked(false);
      } else {
        await blockUser(user.id, userId);
        setBlocked(true);
      }
    } catch (caught) {
      Alert.alert("Something went wrong", caught instanceof Error ? caught.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Ionicons
          name="chevron-back"
          size={26}
          color={theme.accent}
          onPress={() => router.back()}
          suppressHighlighting
        />
        <Text style={[styles.headerTitle, { color: theme.text }]}>Profile</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={styles.loader} />
      ) : !profile ? (
        <View style={styles.loader}>
          <Text style={{ color: theme.textSecondary }}>Couldn't load this profile.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.avatarBlock}>
            <Avatar name={profile.display_name} uri={profile.avatar_url} size={104} />
            <Text style={[styles.name, { color: theme.text }]}>{profile.display_name}</Text>
            <Text style={[styles.username, { color: theme.accent }]}>@{profile.username}</Text>
            {presenceLabel ? (
              <Text
                style={[
                  styles.presence,
                  { color: presenceLabel === "online" ? theme.online : theme.textSecondary },
                ]}
              >
                {presenceLabel}
              </Text>
            ) : null}
          </View>

          {profile.bio ? (
            <View style={[styles.section, { borderTopColor: theme.border }]}>
              <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>Bio</Text>
              <Text style={[styles.sectionValue, { color: theme.text }]}>{profile.bio}</Text>
            </View>
          ) : null}

          {conversationId && (media.length > 0 || documents.length > 0 || calls.length > 0) ? (
            <View style={[styles.section, { borderTopColor: theme.border }]}>
              <View style={styles.tabRow}>
                {(
                  [
                    { key: "media", label: "Media", count: media.length },
                    { key: "files", label: "Files", count: documents.length },
                    { key: "calls", label: "Calls", count: calls.length },
                  ] as const
                )
                  .filter((tab) => tab.count > 0)
                  .map((tab) => (
                    <Pressable
                      key={tab.key}
                      onPress={() => setMediaTab(tab.key)}
                      accessibilityRole="button"
                      style={[
                        styles.tab,
                        mediaTab === tab.key ? { borderBottomColor: theme.accent } : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.tabLabel,
                          { color: mediaTab === tab.key ? theme.accent : theme.textSecondary },
                        ]}
                      >
                        {tab.label} ({tab.count})
                      </Text>
                    </Pressable>
                  ))}
              </View>

              {mediaTab === "media" && media.length > 0 ? (
                <View style={styles.grid}>
                  {media.map((item) => (
                    <MediaThumbnail
                      key={item.id}
                      item={item}
                      conversationId={conversationId}
                      decryptBytesForConversation={decryptBytesForConversation}
                    />
                  ))}
                </View>
              ) : null}

              {mediaTab === "files" && documents.length > 0 ? (
                <View style={styles.list}>
                  {documents.map((doc) => (
                    <View key={doc.id} style={styles.listRow}>
                      <Ionicons name="document-text-outline" size={22} color={theme.accent} />
                      <View style={styles.listRowText}>
                        <Text
                          style={[styles.listRowTitle, { color: theme.text }]}
                          numberOfLines={1}
                        >
                          {doc.document_name ?? "Document"}
                        </Text>
                        <Text style={[styles.listRowSubtitle, { color: theme.textSecondary }]}>
                          {formatFileSize(doc.document_size_bytes)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              {mediaTab === "calls" && calls.length > 0 ? (
                <View style={styles.list}>
                  {calls.map((call) => {
                    const isOutgoing = call.caller_id === user?.id;
                    const missed = call.status === "missed" && !isOutgoing;
                    return (
                      <View key={call.id} style={styles.listRow}>
                        <Ionicons
                          name={call.kind === "video" ? "videocam-outline" : "call-outline"}
                          size={22}
                          color={missed ? theme.danger : theme.accent}
                        />
                        <View style={styles.listRowText}>
                          <Text style={[styles.listRowTitle, { color: theme.text }]}>
                            {isOutgoing ? "Outgoing" : "Incoming"}{" "}
                            {call.kind === "video" ? "video call" : "call"}
                          </Text>
                          <Text
                            style={[
                              styles.listRowSubtitle,
                              { color: missed ? theme.danger : theme.textSecondary },
                            ]}
                          >
                            {formatCallSubtitle(call, isOutgoing)}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button
              title={blocked ? "Unblock" : "Block"}
              onPress={handleToggleBlock}
              loading={busy}
              variant="secondary"
              textColor={!blocked ? theme.danger : undefined}
            />
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/** A grid thumbnail for a media message. Encrypted media has to be
 * downloaded and decrypted with the conversation's session key before it can
 * render — a signed URL alone would just show ciphertext bytes, the same
 * issue MessageBubble's ChatImage solves inside the chat itself. */
function MediaThumbnail({
  item,
  conversationId,
  decryptBytesForConversation,
}: {
  item: MediaMessage;
  conversationId: string;
  decryptBytesForConversation: (
    conversationId: string,
    ciphertext: Uint8Array,
    nonce: string
  ) => Promise<Uint8Array | null>;
}) {
  const { theme } = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const { nonce } = parseMediaRef(item.media_url);
    const load = nonce
      ? fetchDecryptedMediaFile(item.media_url, (ciphertext, mediaNonce) =>
          decryptBytesForConversation(conversationId, ciphertext, mediaNonce)
        )
      : signedChatMediaUrl(item.media_url);

    Promise.resolve(load)
      .then((resolved) => {
        if (!active) return;
        if (resolved) setUri(resolved);
        else setFailed(true);
      })
      .catch(() => active && setFailed(true));

    return () => {
      active = false;
    };
  }, [item.media_url, conversationId, decryptBytesForConversation]);

  return (
    <View style={[styles.thumb, { backgroundColor: theme.surfaceElevated }]}>
      {uri ? (
        <Image source={{ uri }} style={styles.thumbImage} resizeMode="cover" />
      ) : failed ? (
        <Ionicons name="image-outline" size={22} color={theme.textSecondary} />
      ) : (
        <ActivityIndicator size="small" color={theme.accent} />
      )}
      {item.kind === "video" ? (
        <View style={styles.thumbPlayBadge}>
          <Ionicons name="play" size={12} color="#FFFFFF" />
        </View>
      ) : null}
    </View>
  );
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCallSubtitle(call: CallRow, isOutgoing: boolean): string {
  const date = new Date(call.started_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = new Date(call.started_at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const outcome =
    call.status === "missed"
      ? isOutgoing
        ? "No answer"
        : "Missed"
      : call.status === "declined"
        ? "Declined"
        : call.ended_at
          ? formatDuration(
              (new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()) / 1000
            )
          : "Ended";
  return `${date}, ${time} · ${outcome}`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  headerSpacer: { width: 26 },
  loader: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: spacing.xl, gap: spacing.lg },
  avatarBlock: { alignItems: "center", gap: spacing.xs },
  name: { fontSize: 22, fontWeight: "700", marginTop: spacing.sm },
  username: { fontSize: 15, fontWeight: "500" },
  presence: { fontSize: 13, marginTop: spacing.xs },
  section: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.lg, gap: spacing.xs },
  sectionLabel: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  sectionValue: { fontSize: 15, lineHeight: 21 },
  actions: { marginTop: spacing.md },
  tabRow: { flexDirection: "row", gap: spacing.lg },
  tab: { paddingBottom: spacing.xs, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabLabel: { fontSize: 13, fontWeight: "600" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: spacing.sm },
  thumb: {
    width: "31.5%",
    aspectRatio: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbPlayBadge: {
    position: "absolute",
    bottom: 6,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { gap: spacing.md, marginTop: spacing.sm },
  listRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  listRowText: { flex: 1 },
  listRowTitle: { fontSize: 15, fontWeight: "500" },
  listRowSubtitle: { fontSize: 13, marginTop: 2 },
});
