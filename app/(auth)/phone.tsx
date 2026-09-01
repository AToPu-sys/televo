import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { useAuth } from "../../src/hooks/useAuth";
import { useTheme } from "../../src/hooks/useTheme";
import { radius, spacing } from "../../src/theme";

export default function PhoneScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { sendPhoneOtp, verifyPhoneOtp } = useAuth();

  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSendCode() {
    setError(null);
    if (!/^\+[1-9]\d{6,14}$/.test(phone.trim())) {
      setError("Enter your number in international format, e.g. +14155552671.");
      return;
    }
    setBusy(true);
    try {
      await sendPhoneOtp(phone);
      setStep("code");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setError(null);
    if (code.trim().length < 4) {
      setError("Enter the code you received.");
      return;
    }
    setBusy(true);
    try {
      await verifyPhoneOtp(phone, code);
      // Root navigator redirects on the new session.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code did not work.");
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
          <Pressable
            onPress={() => (step === "code" ? setStep("phone") : router.back())}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={styles.back}
            hitSlop={12}
          >
            <Ionicons name="chevron-back" size={26} color={theme.accent} />
          </Pressable>

          <Text style={[styles.title, { color: theme.text }]}>
            {step === "phone" ? "Your phone" : "Enter the code"}
          </Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {step === "phone"
              ? "We'll text you a confirmation code."
              : `We sent a code to ${phone}.`}
          </Text>

          <View style={[styles.callout, { backgroundColor: theme.surfaceElevated }]}>
            <Ionicons name="information-circle-outline" size={18} color={theme.textSecondary} />
            <Text style={[styles.calloutText, { color: theme.textSecondary }]}>
              SMS sign-in needs an SMS provider configured in Supabase. Until then, use email
              sign-in.
            </Text>
          </View>

          {step === "phone" ? (
            <View style={styles.form}>
              <TextField
                label="Phone number"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                placeholder="+1 415 555 2671"
                hint="Include your country code."
                error={error}
              />
              <Button title="Send code" onPress={handleSendCode} loading={busy} />
            </View>
          ) : (
            <View style={styles.form}>
              <TextField
                label="Confirmation code"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                autoComplete="sms-otp"
                placeholder="12345"
                error={error}
              />
              <Button title="Verify and continue" onPress={handleVerify} loading={busy} />
              <Button title="Send a new code" variant="ghost" onPress={handleSendCode} />
            </View>
          )}
        </View>
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
  subtitle: { fontSize: 15, marginBottom: spacing.md },
  callout: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.lg,
    alignItems: "flex-start",
  },
  calloutText: { flex: 1, fontSize: 13, lineHeight: 18 },
  form: { gap: spacing.lg },
});
