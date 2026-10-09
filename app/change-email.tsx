import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../src/components/Button";
import { TextField } from "../src/components/TextField";
import { useAuth, verifyCurrentPassword } from "../src/hooks/useAuth";
import { useTheme } from "../src/hooks/useTheme";
import { radius, spacing } from "../src/theme";

/** Supabase's "Secure email change" setting, if enabled on the project, would
 * additionally confirm from the OLD address before the change takes effect —
 * but that's a dashboard toggle this app can't verify at runtime, so it isn't
 * relied on as the only safeguard. The password check below is the
 * guaranteed one: it's the defense against a hijacked *session* (stolen
 * token, unlocked phone) being used to quietly move the account to an
 * attacker-controlled address — proving the current password is known is
 * required before updateUser() is even called. See verifyCurrentPassword in
 * useAuth.tsx. Confirmation links still land back here as `televo://`
 * callbacks that useAuthDeepLinks (app/_layout.tsx) already handles. */
export default function ChangeEmailScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user, changeEmail } = useAuth();

  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit() {
    setError(null);
    const trimmed = newEmail.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (trimmed.toLowerCase() === user?.email?.toLowerCase()) {
      setError("That's already your current email address.");
      return;
    }
    if (!password) {
      setError("Enter your current password to confirm it's really you.");
      return;
    }

    setBusy(true);
    try {
      if (!user?.email) throw new Error("Couldn't verify your account.");
      const passwordOk = await verifyCurrentPassword(user.email, password);
      if (!passwordOk) {
        setError("That password is incorrect.");
        return;
      }
      await changeEmail(trimmed);
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't start the email change.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Change Email</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {sent ? (
            <View style={[styles.sentBox, { backgroundColor: theme.surfaceElevated }]}>
              <Ionicons name="mail-open-outline" size={32} color={theme.accent} />
              <Text style={[styles.sentTitle, { color: theme.text }]}>Check your inbox</Text>
              <Text style={[styles.sentBody, { color: theme.textSecondary }]}>
                We sent confirmation links to both {user?.email} and {newEmail.trim()}. Open both
                to finish moving your account to the new address.
              </Text>
              <Button title="Done" onPress={() => router.back()} />
            </View>
          ) : (
            <>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                Current email: {user?.email ?? "—"}
              </Text>
              <TextField
                label="New email address"
                value={newEmail}
                onChangeText={setNewEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                placeholder="you@example.com"
              />
              <TextField
                label="Current password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="current-password"
                placeholder="Confirm it's you"
              />
              {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
              <Button title="Send confirmation" onPress={handleSubmit} loading={busy} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: { fontSize: 17, fontWeight: "600" },
  headerSpacer: { width: 26 },
  content: { padding: spacing.xl, gap: spacing.lg },
  subtitle: { fontSize: 15, lineHeight: 21 },
  error: { fontSize: 14 },
  sentBox: {
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: "center",
    gap: spacing.md,
  },
  sentTitle: { fontSize: 18, fontWeight: "600" },
  sentBody: { fontSize: 14, lineHeight: 20, textAlign: "center" },
});
