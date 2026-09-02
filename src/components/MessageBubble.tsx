import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../hooks/useTheme";
import type { ChatMessage } from "../hooks/useMessages";
import { signedChatMediaUrl } from "../lib/media";
import { radius, spacing } from "../theme";

type MessageBubbleProps = {
  message: ChatMessage;
  isOwn: boolean;
  onLongPress?: (message: ChatMessage) => void;
};

export function MessageBubble({ message, isOwn, onLongPress }: MessageBubbleProps) {
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
        {message.kind === "image" && message.media_url ? (
          <ChatImage path={message.media_url} pending={message.pending} />
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
          <Text style={[styles.time, { color: theme.textSecondary }]}>
            {formatTime(message.created_at)}
          </Text>
          {isOwn ? <DeliveryState message={message} /> : null}
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

function DeliveryState({ message }: { message: ChatMessage }) {
  const { theme } = useTheme();

  if (message.failed) {
    return <Ionicons name="alert-circle" size={14} color={theme.danger} />;
  }
  if (message.pending) {
    return <Ionicons name="time-outline" size={14} color={theme.textSecondary} />;
  }
  return <Ionicons name="checkmark-done" size={14} color={theme.accent} />;
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
  meta: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-end" },
  time: { fontSize: 11 },
});
