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
import { useAuth } from "../src/hooks/useAuth";
import { useTheme } from "../src/hooks/useTheme";
import { radius, spacing } from "../src/theme";

/** Supabase's "Secure email change" (the project default) requires
 * confirming from BOTH the old and new addresses before the account's email
 * actually changes — updateUser() only starts that process. There is no
 * further step to take in-app: both confirmation links land back here as
 * `televo://` callbacks that useAuthDeepLinks (app/_layout.tsx) already
 * handles the same way it handles every other auth email link. */
export default function ChangeEmailScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { user, changeEmail } = useAuth();

  const [newEmail, setNewEmail] = useState("");
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

    setBusy(true);
    try {
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
