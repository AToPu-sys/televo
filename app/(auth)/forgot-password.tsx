import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { useAuth } from "../../src/hooks/useAuth";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";

export default function ForgotPasswordScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { sendPasswordReset } = useAuth();

  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!email.trim()) {
      setError("Enter the email you signed up with.");
      return;
    }

    setBusy(true);
    try {
      await sendPasswordReset(email);
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't send the reset email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.back}
            hitSlop={12}
          >
            <Ionicons name="chevron-back" size={26} color={theme.accent} />
          </Pressable>

          <Text style={[styles.title, { color: theme.text }]}>Reset password</Text>

          {sent ? (
            <>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                If an account exists for {email.trim()}, a reset link is on its way. Open it on
                this device to choose a new password. Check your spam folder if it doesn&apos;t
                arrive within a few minutes.
              </Text>
              <Button title="Back to sign in" onPress={() => router.back()} />
            </>
          ) : (
            <>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                Enter your email and we&apos;ll send you a link to set a new password.
              </Text>
              <TextField
                label="Email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                placeholder="you@example.com"
              />
              {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
              <Button title="Send reset link" onPress={handleSubmit} loading={busy} />
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
  content: { padding: spacing.xl, gap: spacing.lg },
  back: { alignSelf: "flex-start" },
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 15, lineHeight: 21 },
  error: { fontSize: 14 },
});
