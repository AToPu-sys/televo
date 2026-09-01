import { Ionicons } from "@expo/vector-icons";
import { Image, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../hooks/useTheme";
import type { ChatMessage } from "../hooks/useMessages";
import { radius, spacing } from "../theme";

export function MessageBubble({ message, isOwn }: { message: ChatMessage; isOwn: boolean }) {
  const { theme } = useTheme();

  const backgroundColor = isOwn ? theme.bubbleOut : theme.bubbleIn;
  const textColor = isOwn ? theme.bubbleOutText : theme.bubbleInText;

  return (
    // The list is inverted, so each row is flipped back upright here.
    <View style={[styles.row, styles.unflip, isOwn ? styles.alignEnd : styles.alignStart]}>
      <View
        style={[
          styles.bubble,
          { backgroundColor },
          isOwn ? styles.bubbleOut : styles.bubbleIn,
          message.failed ? { borderColor: theme.danger, borderWidth: 1 } : null,
        ]}
      >
        {message.kind === "image" && message.media_url ? (
          <Image
            source={{ uri: message.media_url }}
            style={styles.media}
            accessibilityIgnoresInvertColors
          />
        ) : null}

        {message.body ? (
          <Text style={[styles.text, { color: textColor }]}>{message.body}</Text>
        ) : null}

        <View style={styles.meta}>
          <Text style={[styles.time, { color: theme.textSecondary }]}>
            {formatTime(message.created_at)}
          </Text>
          {isOwn ? <DeliveryState message={message} /> : null}
        </View>
      </View>
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
  unflip: { transform: [{ scaleY: -1 }] },
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
  media: { width: 220, height: 160, borderRadius: radius.md },
  meta: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-end" },
  time: { fontSize: 11 },
});
