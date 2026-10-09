import { Ionicons } from "@expo/vector-icons";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useVideoPlayer, VideoView } from "expo-video";
import { memo, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../hooks/useTheme";
import type { ChatMessage } from "../hooks/useMessages";
import { mimeForPath } from "../lib/media";
import { useE2ee } from "../hooks/useE2ee";
import { parseEnvelope } from "../lib/e2e";
import { describeGroupEvent } from "../lib/groupEvents";
import { cachedMediaUri } from "../lib/mediaCache";
import { VoiceMessage } from "./VoiceMessage";
import { radius, spacing } from "../theme";

type ReplyPreview = { senderName: string; text: string };
type ForwardAttribution = { senderName: string };

type MessageBubbleProps = {
  message: ChatMessage;
  isOwn: boolean;
  onLongPress?: (message: ChatMessage) => void;
  /** Resolved by the parent from its already-loaded message list, keyed by
   * message.reply_to_id — avoids a query per bubble for the common case. */
  replyPreview?: ReplyPreview | null;
  forwardedFrom?: ForwardAttribution | null;
  /** The other participant's last_read_at, for real read receipts. */
  peerLastReadAt?: string | null;
  /** Re-attempts decrypting this one message — see useMessages'
   * retryDecryption for why this exists: a message that failed to decrypt
   * because this device's session-key row was stale used to be a dead end
   * with no way back short of leaving and re-entering the chat, unlike a
   * failed photo/video, which already had tap-to-retry. */
  onRetryDecryption?: (messageId: string) => void;
  /** Opens the full-screen photo/video viewer for this message. Absent
   * kind/media_url means the bubble has no media and never calls it. */
  onOpenMedia?: (messageId: string) => void;
  /** Shown above an incoming message in a group, on the first message of a
   * run from the same sender — otherwise nobody can tell who wrote what. */
  senderName?: string | null;
};

function MessageBubbleComponent({
  message,
  isOwn,
  onLongPress,
  replyPreview,
  forwardedFrom,
  peerLastReadAt,
  onRetryDecryption,
  onOpenMedia,
  senderName,
}: MessageBubbleProps) {
  const { theme } = useTheme();

  if (message.kind === "system") {
    return (
      <View style={styles.systemRow}>
        <Text style={[styles.systemText, { backgroundColor: theme.surfaceElevated, color: theme.textSecondary }]}>
          {describeGroupEvent(message.body)}
        </Text>
      </View>
    );
  }

  const backgroundColor = isOwn ? theme.bubbleOut : theme.bubbleIn;
  const textColor = isOwn ? theme.bubbleOutText : theme.bubbleInText;

  return (
    // The FlatList itself has `inverted` set, which already flips rendering
    // order bottom-up — rows must NOT be re-flipped here, or text mirrors.
    <View style={[styles.row, isOwn ? styles.alignEnd : styles.alignStart]}>
      <Pressable
        onLongPress={onLongPress ? () => onLongPress(message) : undefined}
        delayLongPress={350}
        accessibilityRole={onLongPress ? "button" : undefined}
        accessibilityLabel={onLongPress ? "Message options" : undefined}
        style={[
          styles.bubble,
          { backgroundColor },
          isOwn ? styles.bubbleOut : styles.bubbleIn,
          message.failed ? { borderColor: theme.danger, borderWidth: 1 } : null,
        ]}
      >
        {senderName ? (
          <Text style={[styles.senderName, { color: theme.accent }]} numberOfLines={1}>
            {senderName}
          </Text>
        ) : null}

        {forwardedFrom ? (
          <Text style={[styles.forwardedLabel, { color: textColor }]}>
            Forwarded from {forwardedFrom.senderName}
          </Text>
        ) : null}

        {replyPreview ? (
          <View style={[styles.replyQuote, { borderLeftColor: textColor }]}>
            <Text style={[styles.replyQuoteName, { color: textColor }]} numberOfLines={1}>
              {replyPreview.senderName}
            </Text>
            <Text style={[styles.replyQuoteText, { color: textColor }]} numberOfLines={1}>
              {replyPreview.text}
            </Text>
          </View>
        ) : null}

        {message.kind === "image" && message.media_url ? (
          <ChatImage
            path={message.media_url}
            pending={message.pending}
            conversationId={message.conversation_id}
            onPress={onOpenMedia ? () => onOpenMedia(message.id) : undefined}
          />
        ) : null}

        {message.kind === "video" && message.media_url ? (
          <ChatVideo
            path={message.media_url}
            pending={message.pending}
            conversationId={message.conversation_id}
            onPress={onOpenMedia ? () => onOpenMedia(message.id) : undefined}
          />
        ) : null}

        {message.kind === "document" && message.media_url ? (
          <DocumentAttachment
            path={message.media_url}
            name={message.document_name}
            sizeBytes={message.document_size_bytes}
            textColor={textColor}
            conversationId={message.conversation_id}
          />
        ) : null}

        {message.kind === "voice" && message.media_url ? (
          <VoiceMessage
            mediaRef={message.media_url}
            durationMs={message.media_duration_ms}
            waveform={message.waveform}
            conversationId={message.conversation_id}
            color={textColor}
            accent={theme.accent}
          />
        ) : null}

        {message.decryptedBody !== undefined ? (
          message.decryptedBody === null ? (
            <Pressable
              onPress={() => onRetryDecryption?.(message.id)}
              accessibilityRole="button"
              accessibilityLabel="Retry decrypting this message"
            >
              <Text style={[styles.text, styles.undecryptable, { color: textColor }]}>
                🔒 Unable to decrypt this message — tap to retry
              </Text>
            </Pressable>
          ) : (
            <Text style={[styles.text, { color: textColor }]}>{message.decryptedBody}</Text>
          )
        ) : message.body && parseEnvelope(message.body) ? (
          // Belt-and-suspenders: the chat screen now withholds messages
          // entirely until isEncrypted is known for certain (see
          // app/chat/[id].tsx's combined `loading`), so this should be
          // unreachable in practice. Kept so a raw ciphertext envelope can
          // never render as if it were plaintext even if some future path
          // feeds this component a message before decryption ran.
          <Text style={[styles.text, styles.undecryptable, { color: textColor }]}>🔒 …</Text>
        ) : message.body ? (
          <Text style={[styles.text, { color: textColor }]}>{message.body}</Text>
        ) : null}

        <View style={styles.meta}>
          {message.expires_at ? (
            <Ionicons name="timer-outline" size={12} color={theme.textSecondary} />
          ) : null}
          {message.edited_at ? (
            <Text style={[styles.editedLabel, { color: theme.textSecondary }]}>edited</Text>
          ) : null}
          <Text style={[styles.time, { color: theme.textSecondary }]}>
            {formatTime(message.created_at)}
          </Text>
          {isOwn ? <DeliveryState message={message} peerLastReadAt={peerLastReadAt} /> : null}
        </View>
      </Pressable>
    </View>
  );
}

/** Memoized with an explicit comparator.
 *
 * Without this, every keystroke in the composer re-rendered every visible
 * bubble — and a bubble is not cheap: image bubbles resolve signed URLs and
 * video bubbles hold a player instance, so a re-render can restart media
 * work. The parent builds `replyPreview` and `forwardedFrom` as fresh object
 * literals per row on every render, so referential equality alone would
 * never hit; they are compared by the fields actually rendered instead.
 *
 * `message` is compared field-by-field rather than by identity for the same
 * reason: useMessages replaces the array on every realtime event, and an
 * unchanged message frequently arrives as a new object. */
export const MessageBubble = memo(MessageBubbleComponent, (prev, next) => {
  // onOpenMedia/onRetryDecryption/onLongPress intentionally excluded from
  // this comparison, matching the existing fields below — the parent passes
  // a stable identity-per-message closure for each.
  const a = prev.message;
  const b = next.message;
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.decryptedBody === b.decryptedBody &&
    a.edited_at === b.edited_at &&
    a.expires_at === b.expires_at &&
    a.media_url === b.media_url &&
    a.pending === b.pending &&
    a.failed === b.failed &&
    a.created_at === b.created_at &&
    prev.isOwn === next.isOwn &&
    prev.peerLastReadAt === next.peerLastReadAt &&
    prev.onLongPress === next.onLongPress &&
    prev.replyPreview?.text === next.replyPreview?.text &&
    prev.replyPreview?.senderName === next.replyPreview?.senderName &&
    prev.senderName === next.senderName &&
    prev.forwardedFrom?.senderName === next.forwardedFrom?.senderName
  );
});

/**
 * chat-media is a private bucket, so a stored path has to be exchanged for a
 * signed URL before it can render. While a message is still uploading, the
 * optimistic copy already holds a local file:// URI — use it directly.
 */
function ChatImage({
  path,
  pending,
  conversationId,
  onPress,
}: {
  path: string;
  pending?: boolean;
  conversationId?: string;
  onPress?: () => void;
}) {
  const { theme } = useTheme();
  const { decryptBytesForConversation } = useE2ee();
  const isLocal = path.startsWith("file:") || path.startsWith("content:");
  const [uri, setUri] = useState<string | null>(isLocal ? path : null);
  const [failed, setFailed] = useState(false);
  // The actual photo's aspect ratio, so the bubble shows it in full instead
  // of cropping it into a fixed 220x160 box (Image's default resizeMode is
  // "cover", which crops to fill — exactly the "appears cut off" report).
  const [aspectRatio, setAspectRatio] = useState(1);
  // Bumped to force a retry from the "Image unavailable" state — a failed
  // load is very often transient (session token mid-refresh, a network
  // blip) rather than the media actually being gone, so it shouldn't be a
  // dead end with no way back short of leaving and re-entering the chat.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (isLocal) {
      setUri(path);
      return;
    }

    let active = true;

    // A "#nonce" suffix marks media encrypted with the chat's session key;
    // cachedMediaUri downloads + decrypts it once and serves it from disk.
    const load = cachedMediaUri(path, (ciphertext, mediaNonce) =>
      decryptBytesForConversation(conversationId ?? "", ciphertext, mediaNonce)
    );

    Promise.resolve(load)
      .then((resolved) => {
        if (!active) return;
        if (resolved) {
          setUri(resolved);
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch((error) => {
        if (!active) return;
        // eslint-disable-next-line no-console
        console.error("[ChatImage] load failed:", error instanceof Error ? error.message : error, {
          hasNonce: path.includes("#"),
        });
        setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [path, isLocal, conversationId, decryptBytesForConversation, retryCount]);

  useEffect(() => {
    if (!uri) return;
    let active = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (active && width > 0 && height > 0) setAspectRatio(width / height);
      },
      () => {
        // Non-fatal: the image still renders at the default square ratio.
      }
    );
    return () => {
      active = false;
    };
  }, [uri]);

  if (failed) {
    return (
      <Pressable
        onPress={() => {
          setFailed(false);
          setRetryCount((count) => count + 1);
        }}
        style={[styles.media, styles.mediaPlaceholder, { backgroundColor: theme.surfaceElevated }]}
        accessibilityRole="button"
        accessibilityLabel="Retry loading image"
      >
        <Ionicons name="image-outline" size={28} color={theme.textSecondary} />
        <Text style={[styles.mediaError, { color: theme.textSecondary }]}>
          Image unavailable — tap to retry
        </Text>
      </Pressable>
    );
  }

  if (!uri) {
    return (
      <View style={[styles.media, styles.mediaPlaceholder, { backgroundColor: theme.surfaceElevated }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  // Width fixed (matches the old 220 default), height derived from the real
  // aspect ratio and clamped so a very tall/wide photo still fits the bubble
  // — the same bounds WhatsApp/Telegram use for an inline photo.
  const width = 220;
  const height = Math.max(140, Math.min(320, width / aspectRatio));

  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined}>
      <Image
        source={{ uri }}
        style={[styles.media, { width, height }]}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
      />
      {pending ? (
        <View style={styles.uploadOverlay}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : null}
    </Pressable>
  );
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Plays a video message. Resolves through the same path as ChatImage: a
 * signed URL for plaintext media, or download-and-decrypt for Secret Chats.
 * Videos previously had no render branch at all, so a sent video arrived as
 * an empty bubble.
 */
function ChatVideo({
  path,
  pending,
  conversationId,
  onPress,
}: {
  path: string;
  pending?: boolean;
  conversationId?: string;
  onPress?: () => void;
}) {
  const { theme } = useTheme();
  const { decryptBytesForConversation } = useE2ee();
  const isLocal = path.startsWith("file:") || path.startsWith("content:");
  const [uri, setUri] = useState<string | null>(isLocal ? path : null);
  const [failed, setFailed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (isLocal) {
      setUri(path);
      return;
    }

    let active = true;

    const load = cachedMediaUri(path, (ciphertext, mediaNonce) =>
      decryptBytesForConversation(conversationId ?? "", ciphertext, mediaNonce)
    );

    Promise.resolve(load)
      .then((resolved) => {
        if (!active) return;
        if (resolved) {
          setUri(resolved);
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch((error) => {
        if (!active) return;
        // eslint-disable-next-line no-console
        console.error("[ChatVideo] load failed:", error instanceof Error ? error.message : error, {
          hasNonce: path.includes("#"),
        });
        setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [path, isLocal, conversationId, decryptBytesForConversation, retryCount]);

  // The player must be created unconditionally — hooks cannot sit behind the
  // early returns below. A null source simply leaves it idle until the URI
  // resolves.
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = false;
  });

  if (failed) {
    return (
      <View style={[styles.media, styles.mediaPlaceholder, { backgroundColor: theme.surfaceElevated }]}>
        <Ionicons name="videocam-outline" size={28} color={theme.textSecondary} />
        <Text style={[styles.mediaError, { color: theme.textSecondary }]}>Video unavailable</Text>
      </View>
    );
  }

  if (!uri) {
    return (
      <View style={[styles.media, styles.mediaPlaceholder, { backgroundColor: theme.surfaceElevated }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined}>
      <VideoView
        player={player}
        style={styles.media}
        nativeControls
        allowsFullscreen
        contentFit="cover"
      />
      {pending ? (
        <View style={styles.uploadOverlay}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * A document message. Tapping it saves the file to the app's cache and hands
 * it to the OS share sheet, which is what lets the user actually open it in
 * Files, Quick Look, or another app — previously this was an inert row and
 * an attached document could never be opened.
 */
function DocumentAttachment({
  path,
  name,
  sizeBytes,
  textColor,
  conversationId,
}: {
  path: string;
  name: string | null;
  sizeBytes: number | null;
  textColor: string;
  conversationId?: string;
}) {
  const { theme } = useTheme();
  const { decryptBytesForConversation } = useE2ee();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Not supported", "This device can't open attachments.");
        return;
      }

      // Save under the name the sender gave it, not the storage key, so the
      // file arrives in Files/Quick Look correctly named.
      const safeName = (name ?? "document").replace(/[^a-zA-Z0-9._-]/g, "_");

      // A dedicated subdirectory keeps one attachment from overwriting
      // another that happens to share a filename.
      const folder = new Directory(Paths.cache, "attachments");
      if (!folder.exists) folder.create({ intermediates: true });

      // `File` here is expo-file-system's class, which TypeScript's DOM lib
      // also declares; the alias keeps the two from being confused.
      const target = new File(folder, safeName);
      if (target.exists) target.delete();

      // Downloaded (and, for Secret Chats, decrypted) once into the media
      // cache, then copied out under the sender's filename for the share sheet.
      const cached = await cachedMediaUri(path, (ciphertext, mediaNonce) =>
        decryptBytesForConversation(conversationId ?? "", ciphertext, mediaNonce)
      );
      if (!cached) {
        Alert.alert("Unavailable", "This file could not be downloaded or decrypted.");
        return;
      }
      new File(cached).copy(target);

      await Sharing.shareAsync(target.uri, {
        mimeType: mimeForPath(path),
        dialogTitle: safeName,
      });
    } catch {
      Alert.alert("Unavailable", "This file could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`Open ${name ?? "document"}`}
      style={styles.documentRow}
    >
      {busy ? (
        <ActivityIndicator color={textColor} style={styles.documentIcon} />
      ) : (
        <Ionicons name="document-text-outline" size={28} color={textColor} />
      )}
      <View style={styles.documentText}>
        <Text style={[styles.documentName, { color: textColor }]} numberOfLines={1}>
          {name ?? "Document"}
        </Text>
        <Text style={[styles.documentSize, { color: theme.textSecondary }]}>
          {formatFileSize(sizeBytes)}
        </Text>
      </View>
    </Pressable>
  );
}

function DeliveryState({
  message,
  peerLastReadAt,
}: {
  message: ChatMessage;
  peerLastReadAt?: string | null;
}) {
  const { theme } = useTheme();

  if (message.failed) {
    return <Ionicons name="alert-circle" size={14} color={theme.danger} />;
  }
  if (message.pending) {
    return <Ionicons name="time-outline" size={14} color={theme.textSecondary} />;
  }

  // A single tick means delivered; the double tick is only shown once the
  // other person's last_read_at is actually at or past this message. It used
  // to show "read" for everything, regardless of whether it had been.
  const wasRead =
    !!peerLastReadAt && new Date(peerLastReadAt).getTime() >= new Date(message.created_at).getTime();

  return (
    <Ionicons
      name={wasRead ? "checkmark-done" : "checkmark"}
      size={14}
      color={wasRead ? theme.accent : theme.textSecondary}
    />
  );
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const styles = StyleSheet.create({
  systemRow: { alignItems: "center", marginVertical: spacing.sm, paddingHorizontal: spacing.lg },
  systemText: {
    fontSize: 13,
    fontWeight: "500",
    textAlign: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: 12,
    overflow: "hidden",
  },
  senderName: { fontSize: 13, fontWeight: "700", marginBottom: 2 },
  row: { flexDirection: "row", marginVertical: 2 },
  alignStart: { justifyContent: "flex-start" },
  alignEnd: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    gap: spacing.xs,
  },
  bubbleOut: { borderBottomRightRadius: radius.xs },
  bubbleIn: { borderBottomLeftRadius: radius.xs },
  text: { fontSize: 16, lineHeight: 21 },
  undecryptable: { fontStyle: "italic", opacity: 0.7 },
  forwardedLabel: { fontSize: 12, fontStyle: "italic", opacity: 0.75 },
  replyQuote: {
    borderLeftWidth: 3,
    paddingLeft: spacing.sm,
    opacity: 0.85,
    gap: 1,
  },
  replyQuoteName: { fontSize: 12, fontWeight: "700" },
  replyQuoteText: { fontSize: 12 },
  media: { width: 220, height: 160, borderRadius: radius.md, overflow: "hidden" },
  mediaPlaceholder: { alignItems: "center", justifyContent: "center", gap: spacing.xs },
  mediaError: { fontSize: 12 },
  uploadOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
    borderRadius: radius.md,
  },
  documentIcon: { width: 28 },
  documentRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minWidth: 180 },
  documentText: { flex: 1, gap: 2 },
  documentName: { fontSize: 14, fontWeight: "600" },
  documentSize: { fontSize: 11 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-end" },
  editedLabel: { fontSize: 11, fontStyle: "italic" },
  time: { fontSize: 11 },
});
