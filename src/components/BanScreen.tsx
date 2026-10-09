import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../hooks/useTheme";
import { spacing } from "../theme";

const APPEAL_EMAIL = "hello@gettelevo.space";

/** Full-screen gate shown whenever the signed-in account is suspended
 * (user_moderation.banned_until in the future — see useBanStatus). Ending
 * up here used to mean a generic red "failed" bubble on every message send
 * with no explanation and no way out — this is the appeal path the
 * support-email agent (supabase/functions/support-email-agent) needs: a
 * user ID in the email is now MANDATORY for the agent to act, so the one
 * job of this screen is making that ID impossible to miss. */
export function BanScreen({
  userId,
  reason,
  permanent,
  until,
}: {
  userId: string;
  reason: string | null;
  permanent: boolean;
  until: string | null;
}) {
  const { theme } = useTheme();
  const [copied, setCopied] = useState(false);

  async function copyId() {
    await Clipboard.setStringAsync(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function openAppeal() {
    const subject = encodeURIComponent("Account appeal");
    const body = encodeURIComponent(`User ID: ${userId}\n\nWhy I think this ban should be lifted:\n`);
    void Linking.openURL(`mailto:${APPEAL_EMAIL}?subject=${subject}&body=${body}`);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.content}>
        <Ionicons name="hand-left-outline" size={56} color={theme.danger} />
        <Text style={[styles.title, { color: theme.text }]}>Account suspended</Text>
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          {permanent
            ? "This account has been suspended indefinitely."
            : until
              ? `This account is suspended until ${new Date(until).toLocaleString()}.`
              : "This account is currently suspended."}
        </Text>
        {reason ? (
          <Text style={[styles.reason, { color: theme.textSecondary }]}>{reason}</Text>
        ) : null}

        <View style={[styles.idBox, { backgroundColor: theme.surfaceElevated }]}>
          <Text style={[styles.idLabel, { color: theme.textSecondary }]}>Your account ID</Text>
          <Pressable onPress={copyId} style={styles.idRow}>
            <Text style={[styles.idValue, { color: theme.text }]} selectable>
              {userId}
            </Text>
            <Ionicons name={copied ? "checkmark" : "copy-outline"} size={18} color={theme.accent} />
          </Pressable>
        </View>

        <Text style={[styles.instructions, { color: theme.textSecondary }]}>
          To appeal, email {APPEAL_EMAIL} from the address this account is registered with, and
          include your account ID above. Explain why this ban should be lifted — our support team
          reviews every appeal.
        </Text>

        <Pressable
          onPress={openAppeal}
          style={[styles.button, { backgroundColor: theme.accent }]}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Email support</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  title: { fontSize: 22, fontWeight: "700", marginTop: spacing.md },
  body: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  reason: { fontSize: 14, textAlign: "center", fontStyle: "italic" },
  idBox: {
    width: "100%",
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  idLabel: { fontSize: 12, marginBottom: 4 },
  idRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  idValue: { fontSize: 14, fontFamily: "Menlo", flexShrink: 1 },
  instructions: { fontSize: 13, textAlign: "center", lineHeight: 19, marginTop: spacing.lg },
  button: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  buttonText: { color: "#1A1414", fontSize: 16, fontWeight: "700" },
});
