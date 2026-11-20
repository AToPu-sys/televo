import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../hooks/useTheme";
import { supabase } from "../lib/supabase";
import { spacing } from "../theme";

const APPEAL_EMAIL = "hello@gettelevo.space";

type Appeal = { status: "pending" | "approved" | "denied"; created_at: string };

/** Full-screen gate shown whenever the signed-in account is suspended
 * (user_moderation.banned_until in the future — see useBanStatus).
 *
 * "Request unblock" calls submit_ban_appeal (091_ban_appeals_via_moderation_chat.sql):
 * the request reaches a human moderator as a message from Televo Moderation,
 * they answer yes or no, and the server applies it. This screen covers the
 * whole app, so the answer is shown here too; when the suspension is lifted,
 * useBanStatus notices within 30 s and the screen goes away. Email stays as
 * a fallback. */
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
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appeal, setAppeal] = useState<Appeal | null>(null);

  const loadAppeal = useCallback(async () => {
    const { data } = await supabase
      .from("ban_appeals")
      .select("status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setAppeal((data as Appeal | null) ?? null);
  }, [userId]);

  useEffect(() => {
    void loadAppeal();
    const timer = setInterval(() => void loadAppeal(), 30_000);
    return () => clearInterval(timer);
  }, [loadAppeal]);

  async function copyId() {
    await Clipboard.setStringAsync(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function submit() {
    const message = text.trim();
    if (!message) {
      setError("Write a few words about why the suspension should be lifted.");
      return;
    }
    setSending(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("submit_ban_appeal", { p_message: message });
    setSending(false);
    if (rpcError) {
      const code = rpcError.message ?? "";
      setError(
        code.includes("appeal_pending") || code.includes("ban_appeals_one_pending")
          ? "Your request is already with a moderator. You'll see the answer here."
          : code.includes("too_many_appeals")
            ? "You can send up to 3 requests a week. Try again later."
            : code.includes("not_suspended")
              ? "This account is no longer suspended. Reopen the app."
              : "Couldn't send the request. Check your connection and try again."
      );
      void loadAppeal();
      return;
    }
    setText("");
    void loadAppeal();
  }

  function openEmail() {
    const subject = encodeURIComponent("Account appeal");
    const body = encodeURIComponent(`User ID: ${userId}\n\nWhy I think this ban should be lifted:\n`);
    void Linking.openURL(`mailto:${APPEAL_EMAIL}?subject=${subject}&body=${body}`);
  }

  const pending = appeal?.status === "pending";
  const denied = appeal?.status === "denied";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Ionicons name="hand-left-outline" size={56} color={theme.danger} />
          <Text style={[styles.title, { color: theme.text }]}>Account suspended</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            {permanent
              ? "This account has been suspended indefinitely."
              : until
                ? `This account is suspended until ${new Date(until).toLocaleString()}.`
                : "This account is currently suspended."}
          </Text>
          {reason ? <Text style={[styles.reason, { color: theme.textSecondary }]}>{reason}</Text> : null}

          {pending ? (
            <View style={[styles.statusBox, { backgroundColor: theme.surfaceElevated }]}>
              <Ionicons name="time-outline" size={20} color={theme.accent} />
              <Text style={[styles.statusText, { color: theme.text }]}>
                Your request is with a moderator. The answer will appear here, and the app unlocks by
                itself if it's lifted.
              </Text>
            </View>
          ) : (
            <>
              {denied ? (
                <View style={[styles.statusBox, { backgroundColor: theme.surfaceElevated }]}>
                  <Ionicons name="close-circle-outline" size={20} color={theme.danger} />
                  <Text style={[styles.statusText, { color: theme.text }]}>
                    A moderator reviewed your last request and kept the suspension.
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.label, { color: theme.textSecondary }]}>
                Think this is a mistake? Tell the moderator what happened.
              </Text>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Why should the suspension be lifted?"
                placeholderTextColor={theme.textSecondary}
                multiline
                maxLength={1000}
                style={[
                  styles.input,
                  { color: theme.text, backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                ]}
              />
              {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
              <Pressable
                onPress={submit}
                disabled={sending}
                style={[styles.button, { backgroundColor: theme.accent, opacity: sending ? 0.7 : 1 }]}
                accessibilityRole="button"
              >
                {sending ? (
                  <ActivityIndicator color="#1A1414" />
                ) : (
                  <Text style={styles.buttonText}>Request unblock</Text>
                )}
              </Pressable>
            </>
          )}

          <View style={[styles.idBox, { backgroundColor: theme.surfaceElevated }]}>
            <Text style={[styles.idLabel, { color: theme.textSecondary }]}>Your account ID</Text>
            <Pressable onPress={copyId} style={styles.idRow}>
              <Text style={[styles.idValue, { color: theme.text }]} selectable>
                {userId}
              </Text>
              <Ionicons name={copied ? "checkmark" : "copy-outline"} size={18} color={theme.accent} />
            </Pressable>
          </View>

          <Pressable onPress={openEmail} accessibilityRole="link">
            <Text style={[styles.emailLink, { color: theme.textSecondary }]}>
              Or email {APPEAL_EMAIL} with your account ID
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  title: { fontSize: 22, fontWeight: "700", marginTop: spacing.md },
  body: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  reason: { fontSize: 14, textAlign: "center", fontStyle: "italic" },
  statusBox: {
    width: "100%",
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start",
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  statusText: { flex: 1, fontSize: 14, lineHeight: 20 },
  label: { fontSize: 14, textAlign: "center", marginTop: spacing.lg },
  input: {
    width: "100%",
    minHeight: 96,
    maxHeight: 180,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    fontSize: 15,
    textAlignVertical: "top",
  },
  error: { fontSize: 13, textAlign: "center" },
  button: {
    marginTop: spacing.sm,
    minWidth: 220,
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  buttonText: { color: "#1A1414", fontSize: 16, fontWeight: "700" },
  idBox: {
    width: "100%",
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  idLabel: { fontSize: 12, marginBottom: 4 },
  idRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  idValue: { fontSize: 14, fontFamily: "Menlo", flexShrink: 1 },
  emailLink: { fontSize: 13, textAlign: "center", marginTop: spacing.md, textDecorationLine: "underline" },
});
