import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../hooks/useTheme";
import type { ChatMessage } from "../hooks/useMessages";
import { signedChatMediaUrl } from "../lib/media";
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
};

export function MessageBubble({
  message,
  isOwn,
  onLongPress,
  replyPreview,
  forwardedFrom,
  peerLastReadAt,
}: MessageBubbleProps) {
  const { theme } = useTheme();

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
          <ChatImage path={message.media_url} pending={message.pending} />
        ) : null}

        {message.kind === "document" && message.media_url ? (
          <DocumentAttachment
            path={message.media_url}
            name={message.document_name}
            sizeBytes={message.document_size_bytes}
            textColor={textColor}
          />
        ) : null}

        {message.decryptedBody !== undefined ? (
          message.decryptedBody === null ? (
            <Text style={[styles.text, styles.undecryptable, { color: textColor }]}>
              🔒 Unable to decrypt this message
            </Text>
          ) : (
            <Text style={[styles.text, { color: textColor }]}>{message.decryptedBody}</Text>
          )
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

/**
 * chat-media is a private bucket, so a stored path has to be exchanged for a
 * signed URL before it can render. While a message is still uploading, the
 * optimistic copy already holds a local file:// URI — use it directly.
 */
function ChatImage({ path, pending }: { path: string; pending?: boolean }) {
  const { theme } = useTheme();
  const isLocal = path.startsWith("file:") || path.startsWith("content:");
  const [uri, setUri] = useState<string | null>(isLocal ? path : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isLocal) {
      setUri(path);
      return;
    }

    let active = true;
    signedChatMediaUrl(path)
      .then((signed) => {
        if (active) setUri(signed);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [path, isLocal]);

  if (failed) {
    return (
      <View style={[styles.media, styles.mediaPlaceholder, { backgroundColor: theme.surfaceElevated }]}>
        <Ionicons name="image-outline" size={28} color={theme.textSecondary} />
        <Text style={[styles.mediaError, { color: theme.textSecondary }]}>Image unavailable</Text>
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
    <View>
      <Image source={{ uri }} style={styles.media} accessibilityIgnoresInvertColors />
      {pending ? (
        <View style={styles.uploadOverlay}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : null}
    </View>
  );
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentAttachment({
  path,
  name,
  sizeBytes,
  textColor,
}: {
  path: string;
  name: string | null;
  sizeBytes: number | null;
  textColor: string;
}) {
  const { theme } = useTheme();

  return (
    <View style={styles.documentRow}>
      <Ionicons name="document-text-outline" size={28} color={textColor} />
      <View style={styles.documentText}>
        <Text style={[styles.documentName, { color: textColor }]} numberOfLines={1}>
          {name ?? "Document"}
        </Text>
        <Text style={[styles.documentSize, { color: theme.textSecondary }]}>
          {formatFileSize(sizeBytes)}
        </Text>
      </View>
    </View>
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
  media: { width: 220, height: 160, borderRadius: radius.md },
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
  documentRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minWidth: 180 },
  documentText: { flex: 1, gap: 2 },
  documentName: { fontSize: 14, fontWeight: "600" },
  documentSize: { fontSize: 11 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-end" },
  editedLabel: { fontSize: 11, fontStyle: "italic" },
  time: { fontSize: 11 },
});
