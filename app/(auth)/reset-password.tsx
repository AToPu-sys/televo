import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { MIN_PASSWORD_LENGTH, validatePassword } from "../../src/lib/password";
import { useAuth } from "../../src/hooks/useAuth";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";



export default function ResetPasswordScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { updatePassword } = useAuth();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setError(null);

    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }

    setBusy(true);
    try {
      await updatePassword(password);
      // Clearing recoveringPassword lets the root navigator route onward.
      router.replace("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't update the password.");
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
          <Text style={[styles.title, { color: theme.text }]}>Choose a new password</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            This replaces the password on your account. You&apos;ll stay signed in on this device.
          </Text>

          <TextField
            label="New password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            placeholder="••••••••"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          />
          <TextField
            label="Confirm new password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            placeholder="••••••••"
          />

          {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}

          <Button title="Save new password" onPress={handleSubmit} loading={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.lg },
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 15, lineHeight: 21 },
  error: { fontSize: 14 },
});
