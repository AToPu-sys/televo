import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../src/components/Button";
import { TextField } from "../src/components/TextField";
import { useAuth } from "../src/hooks/useAuth";
import { useTheme } from "../src/hooks/useTheme";
import { spacing } from "../src/theme";

/**
 * Shown after a successful password sign-in when the account has Two-Step
 * Verification enabled. This is a hard gate, not a route the user can back
 * out of — every RLS-checked query fails at AAL1, so there's nothing useful
 * to show behind it until the code is verified. See RootNavigator.
 */
export default function MfaChallengeScreen() {
  const { theme } = useTheme();
  const { verifyMfaCode, signOut } = useAuth();

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleVerify() {
    setError(null);
    if (code.trim().length < 6) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    try {
      await verifyMfaCode(code);
      // Root navigator re-renders once needsMfaChallenge clears.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code didn't work.");
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
        <View style={styles.content}>
          <Ionicons name="shield-checkmark-outline" size={48} color={theme.accent} />
          <Text style={[styles.title, { color: theme.text }]}>Two-Step Verification</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            Enter the code from your authenticator app.
          </Text>

          <View style={styles.form}>
            <TextField
              label="6-digit code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              placeholder="123456"
              error={error}
              autoFocus
            />
            <Button title="Verify" onPress={handleVerify} loading={busy} />
            <Button title="Sign out instead" variant="ghost" onPress={() => void signOut()} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  title: { fontSize: 22, fontWeight: "700", marginTop: spacing.sm },
  subtitle: { fontSize: 14, textAlign: "center", marginBottom: spacing.lg },
  form: { width: "100%", gap: spacing.lg },
});
