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

import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { useAuth } from "../../src/hooks/useAuth";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";

export default function SignInScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { signInWithEmail, signUpWithEmail } = useAuth();

  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === "sign-up";

  async function handleSubmit() {
    setError(null);
    setNotice(null);

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    if (isSignUp && username.trim().length < 3) {
      setError("Username must be at least 3 characters (letters, numbers, _ or .).");
      return;
    }
    if (isSignUp && !/^[a-zA-Z0-9_.]+$/.test(username.trim())) {
      setError("Username can only contain letters, numbers, underscores and dots.");
      return;
    }

    setBusy(true);
    try {
      if (isSignUp) {
        const { needsConfirmation } = await signUpWithEmail(email, password, {
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
        });
        if (needsConfirmation) {
          setNotice("Check your email to confirm your account, then sign in.");
          setMode("sign-in");
        }
      } else {
        await signInWithEmail(email, password);
      }
      // On success the root navigator redirects; nothing to do here.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
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

          <Text style={[styles.title, { color: theme.text }]}>
            {isSignUp ? "Create account" : "Welcome back"}
          </Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {isSignUp
              ? "Pick a username your friends can find you by."
              : "Sign in with your email and password."}
          </Text>

          <View style={styles.form}>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="you@example.com"
            />
            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete={isSignUp ? "new-password" : "current-password"}
              placeholder="••••••••"
            />

            {isSignUp ? (
              <>
                <TextField
                  label="Username"
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  placeholder="jane_doe"
                  hint="3–24 characters. Letters, numbers, underscore, dot."
                />
                <TextField
                  label="Display name"
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Jane Doe"
                  hint="Optional — defaults to your username."
                />
              </>
            ) : null}

            {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
            {notice ? (
              <Text style={[styles.notice, { color: theme.accent }]}>{notice}</Text>
            ) : null}

            <Button
              title={isSignUp ? "Create account" : "Sign in"}
              onPress={handleSubmit}
              loading={busy}
            />
            <Button
              title={isSignUp ? "I already have an account" : "Create a new account"}
              variant="ghost"
              onPress={() => {
                setMode(isSignUp ? "sign-in" : "sign-up");
                setError(null);
                setNotice(null);
              }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.sm },
  back: { alignSelf: "flex-start", marginBottom: spacing.md },
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 15, marginBottom: spacing.lg },
  form: { gap: spacing.lg },
  error: { fontSize: 14 },
  notice: { fontSize: 14 },
});
