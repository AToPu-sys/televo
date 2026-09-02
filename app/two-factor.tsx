import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../src/components/Button";
import { TextField } from "../src/components/TextField";
import { useTheme } from "../src/hooks/useTheme";
import { supabase } from "../src/lib/supabase";
import { radius, spacing } from "../src/theme";

type Factor = { id: string; friendly_name: string | null; status: string };

/**
 * Telegram's "Two-Step Verification" is a password checked on top of login.
 * This uses Supabase's native TOTP MFA (an authenticator app code) instead —
 * the same idea (a second factor beyond the account password), implemented
 * with a real, server-verified standard rather than a bespoke password field.
 */
export default function TwoFactorScreen() {
  const { theme } = useTheme();
  const router = useRouter();

  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadFactors() {
    setLoading(true);
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors((data?.totp ?? []).map((f) => ({ id: f.id, friendly_name: f.friendly_name ?? null, status: f.status })));
    setLoading(false);
  }

  useEffect(() => {
    void loadFactors();
  }, []);

  async function handleStartEnroll() {
    setError(null);
    setEnrolling(true);
    try {
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Televo",
      });
      if (enrollError) throw enrollError;

      setFactorId(data.id);
      setQrUri(data.totp.qr_code);
      setSecret(data.totp.secret);
    } catch (caught) {
      Alert.alert(
        "Couldn't start setup",
        caught instanceof Error ? caught.message : "Please try again."
      );
      setEnrolling(false);
    }
  }

  async function handleVerify() {
    if (!factorId) return;
    setError(null);
    setVerifying(true);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (verifyError) throw verifyError;

      setEnrolling(false);
      setQrUri(null);
      setSecret(null);
      setFactorId(null);
      setCode("");
      await loadFactors();
      Alert.alert("Two-Step Verification enabled", "You'll need a code from your authenticator app to sign in from now on.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code didn't work.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleRemove(id: string) {
    Alert.alert(
      "Turn off Two-Step Verification?",
      "Your account will only require your password to sign in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Turn off",
          style: "destructive",
          onPress: async () => {
            const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: id });
            if (unenrollError) {
              Alert.alert("Couldn't remove it", unenrollError.message);
              return;
            }
            await loadFactors();
          },
        },
      ]
    );
  }

  const activeFactor = factors.find((f) => f.status === "verified");

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={26} color={theme.accent} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Two-Step Verification</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <ActivityIndicator color={theme.accent} style={styles.loader} />
        ) : activeFactor ? (
          <View style={styles.center}>
            <Ionicons name="shield-checkmark" size={56} color={theme.online} />
            <Text style={[styles.statusTitle, { color: theme.text }]}>Enabled</Text>
            <Text style={[styles.statusBody, { color: theme.textSecondary }]}>
              Signing in requires a code from your authenticator app, in addition to your password.
            </Text>
            <Button
              title="Turn off"
              variant="secondary"
              onPress={() => handleRemove(activeFactor.id)}
              style={styles.actionButton}
            />
          </View>
        ) : enrolling && qrUri ? (
          <View style={styles.center}>
            <Text style={[styles.statusBody, { color: theme.textSecondary }]}>
              Scan this code with Google Authenticator, Authy, or any TOTP app.
            </Text>
            <Image source={{ uri: qrUri }} style={styles.qr} accessibilityIgnoresInvertColors />
            {secret ? (
              <Text style={[styles.secret, { color: theme.textSecondary }]} selectable>
                Can't scan? Enter manually: {secret}
              </Text>
            ) : null}

            <TextField
              label="6-digit code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              placeholder="123456"
              error={error}
            />
            <Button
              title="Verify and enable"
              onPress={handleVerify}
              loading={verifying}
              style={styles.actionButton}
            />
          </View>
        ) : (
          <View style={styles.center}>
            <Ionicons name="shield-outline" size={56} color={theme.textSecondary} />
            <Text style={[styles.statusTitle, { color: theme.text }]}>Not enabled</Text>
            <Text style={[styles.statusBody, { color: theme.textSecondary }]}>
              Add an authenticator app code as a second step when signing in, on top of your
              password.
            </Text>
            <Button
              title="Set up Two-Step Verification"
              onPress={handleStartEnroll}
              loading={enrolling}
              style={styles.actionButton}
            />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  headerSpacer: { width: 26 },
  content: { padding: spacing.xl, flexGrow: 1 },
  loader: { marginTop: spacing.xxl },
  center: { alignItems: "center", gap: spacing.md, paddingTop: spacing.xl },
  statusTitle: { fontSize: 20, fontWeight: "700" },
  statusBody: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  actionButton: { marginTop: spacing.md, minWidth: 220 },
  qr: { width: 200, height: 200, borderRadius: radius.md, marginVertical: spacing.md },
  secret: { fontSize: 12, textAlign: "center", marginBottom: spacing.md },
});
