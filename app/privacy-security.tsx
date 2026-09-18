import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppLock } from "../src/hooks/useAppLock";
import { useTheme } from "../src/hooks/useTheme";
import {
  clearPasscode,
  getBiometricKind,
  isBiometricUnlockEnabled,
  isPasscodeSet,
  setBiometricUnlockEnabled,
  type BiometricKind,
} from "../src/lib/passcode";
import { radius, spacing } from "../src/theme";
import { FaceIdIcon } from "../src/components/FaceIdIcon";

const IONICON_FALLBACK: Record<BiometricKind, keyof typeof Ionicons.glyphMap> = {
  face: "finger-print", // unreachable — face renders FaceIdIcon below instead
  fingerprint: "finger-print",
  iris: "finger-print",
  generic: "finger-print",
};

const BIOMETRIC_LABEL: Record<BiometricKind, string> = {
  face: "Unlock with Face ID",
  fingerprint: "Unlock with Touch ID",
  iris: "Unlock with Biometrics",
  generic: "Unlock with Biometrics",
};

export default function PrivacySecurityScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { refreshLockState } = useAppLock();

  const [passcodeEnabled, setPasscodeEnabled] = useState(false);
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [biometricKind, setBiometricKind] = useState<BiometricKind>("fingerprint");

  useEffect(() => {
    // SecureStore/LocalAuthentication calls can reject (unavailable on this
    // device); an unhandled rejection here just leaves the toggles at their
    // default rather than surfacing anything, so fail closed instead.
    isPasscodeSet().then(setPasscodeEnabled).catch(() => setPasscodeEnabled(false));
    isBiometricUnlockEnabled().then(setBiometricsEnabled).catch(() => setBiometricsEnabled(false));
    getBiometricKind().then(setBiometricKind).catch(() => setBiometricKind("fingerprint"));
  }, []);

  async function handleTogglePasscode(next: boolean) {
    if (next) {
      router.push("/set-passcode");
      return;
    }

    Alert.alert("Turn off Passcode Lock?", "The app will open without a PIN.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Turn off",
        style: "destructive",
        onPress: async () => {
          await clearPasscode();
          setPasscodeEnabled(false);
          setBiometricsEnabled(false);
          await refreshLockState();
        },
      },
    ]);
  }

  async function handleToggleBiometrics(next: boolean) {
    await setBiometricUnlockEnabled(next);
    setBiometricsEnabled(next);
  }

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
        <Text style={[styles.headerTitle, { color: theme.text }]}>Privacy & Security</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>SECURITY</Text>
        <View style={[styles.section, { backgroundColor: theme.surfaceElevated }]}>
          <View style={styles.row}>
            <View style={styles.rowLabel}>
              <Ionicons name="keypad-outline" size={20} color={theme.accent} />
              <Text style={[styles.rowText, { color: theme.text }]}>Passcode Lock</Text>
            </View>
            <Switch
              value={passcodeEnabled}
              onValueChange={handleTogglePasscode}
              trackColor={{ true: theme.accent, false: theme.border }}
              accessibilityLabel="Passcode Lock"
            />
          </View>

          {passcodeEnabled ? (
            <>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <View style={styles.row}>
                <View style={styles.rowLabel}>
                  {biometricKind === "face" ? (
                    <FaceIdIcon size={20} color={theme.accent} />
                  ) : (
                    <Ionicons name={IONICON_FALLBACK[biometricKind]} size={20} color={theme.accent} />
                  )}
                  <Text style={[styles.rowText, { color: theme.text }]}>
                    {BIOMETRIC_LABEL[biometricKind]}
                  </Text>
                </View>
                <Switch
                  value={biometricsEnabled}
                  onValueChange={handleToggleBiometrics}
                  trackColor={{ true: theme.accent, false: theme.border }}
                  accessibilityLabel="Unlock with biometrics"
                />
              </View>
            </>
          ) : null}
        </View>

        <Pressable
          onPress={() => router.push("/change-email" as never)}
          accessibilityRole="button"
          accessibilityLabel="Change Email"
          style={[styles.section, styles.row, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.rowLabel}>
            <Ionicons name="mail-outline" size={20} color={theme.accent} />
            <Text style={[styles.rowText, { color: theme.text }]}>Change Email</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </Pressable>

        <Pressable
          onPress={() => router.push("/two-factor")}
          accessibilityRole="button"
          accessibilityLabel="Two-Step Verification"
          style={[styles.section, styles.row, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.rowLabel}>
            <Ionicons name="shield-checkmark-outline" size={20} color={theme.accent} />
            <Text style={[styles.rowText, { color: theme.text }]}>Two-Step Verification</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </Pressable>

        <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>PRIVACY</Text>
        <Pressable
          onPress={() => router.push("/privacy-last-seen")}
          accessibilityRole="button"
          accessibilityLabel="Last Seen & Online"
          style={[styles.section, styles.row, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.rowLabel}>
            <Ionicons name="eye-outline" size={20} color={theme.accent} />
            <Text style={[styles.rowText, { color: theme.text }]}>Last Seen & Online</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </Pressable>

        <Pressable
          onPress={() => router.push("/blocked-users")}
          accessibilityRole="button"
          accessibilityLabel="Blocked Users"
          style={[styles.section, styles.row, { backgroundColor: theme.surfaceElevated }]}
        >
          <View style={styles.rowLabel}>
            <Ionicons name="ban-outline" size={20} color={theme.accent} />
            <Text style={[styles.rowText, { color: theme.text }]}>Blocked Users</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </Pressable>
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
  content: { padding: spacing.lg, gap: spacing.sm },
  groupLabel: { fontSize: 12, fontWeight: "600", marginTop: spacing.md, marginLeft: spacing.xs },
  section: { borderRadius: radius.md, paddingHorizontal: spacing.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    minHeight: 52,
  },
  rowLabel: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowText: { fontSize: 16 },
  divider: { height: StyleSheet.hairlineWidth },
});
