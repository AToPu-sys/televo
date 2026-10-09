import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppLock } from "../hooks/useAppLock";
import {
  getBiometricKind,
  getLockoutStatus,
  isBiometricUnlockEnabled,
  type BiometricKind,
} from "../lib/passcode";
import { useTheme } from "../hooks/useTheme";
import { spacing } from "../theme";
import { FaceIdIcon } from "./FaceIdIcon";

const IONICON_FALLBACK: Record<BiometricKind, keyof typeof Ionicons.glyphMap> = {
  face: "finger-print", // unreachable — face renders FaceIdIcon below instead
  fingerprint: "finger-print",
  iris: "finger-print",
  generic: "finger-print",
};

const PASSCODE_LENGTH = 4;
// Standard phone keypad layout: 1-9 in order, then 0 centered on its own row.
const KEYPAD_ROWS = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
];

/** Full-screen PIN pad shown whenever the app is locked. Modeled on
 * Telegram's Passcode Lock screen. */
export function PasscodeScreen() {
  const { theme } = useTheme();
  const { unlockWithPasscode, unlockWithBiometrics } = useAppLock();
  const [entered, setEntered] = useState("");
  const [error, setError] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [biometricKind, setBiometricKind] = useState<BiometricKind>("fingerprint");
  // Persisted lockout after repeated wrong PINs (see getLockoutStatus) — a
  // 4-digit PIN is only 10,000 combinations, so without this an automated
  // tap script could brute-force it in minutes against exactly the "stolen
  // unlocked-but-locked phone" scenario this screen exists to guard.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    isBiometricUnlockEnabled().then(setBiometricsAvailable).catch(() => setBiometricsAvailable(false));
    getBiometricKind().then(setBiometricKind).catch(() => setBiometricKind("fingerprint"));
    getLockoutStatus()
      .then((status) => setRetryAt(status.locked ? status.retryAt : null))
      .catch(() => setRetryAt(null));
    // Try biometrics immediately on mount, mirroring Telegram/most apps.
    void unlockWithBiometrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticks once a second only while locked out, so the countdown updates and
  // the pad re-enables itself the moment the lockout expires.
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  const lockedOut = !!retryAt && retryAt > now;
  const lockoutSecondsLeft = lockedOut ? Math.ceil((retryAt! - now) / 1000) : 0;

  async function handleDigit(digit: number) {
    if (lockedOut) return;
    if (entered.length >= PASSCODE_LENGTH) return;
    const next = entered + String(digit);
    setEntered(next);
    setError(false);

    if (next.length === PASSCODE_LENGTH) {
      const success = await unlockWithPasscode(next);
      if (!success) {
        setError(true);
        setTimeout(() => setEntered(""), 400);
        const status = await getLockoutStatus();
        setRetryAt(status.locked ? status.retryAt : null);
      }
    }
  }

  function handleBackspace() {
    setEntered((current) => current.slice(0, -1));
    setError(false);
  }

  // 2026-09-28: used to wrap itself in its own <Modal> here — needed back
  // when _layout.tsx rendered PasscodeScreen as a plain inline sibling of
  // <Stack> (flex:1 in the same implicit column only covers the space its
  // parent happens to give it, not the whole display). _layout.tsx now
  // renders MfaChallengeScreen/PasscodeScreen inside ONE persistent outer
  // <Modal> of its own, for the same full-screen-coverage reason. Keeping a
  // SECOND <Modal> here nested it inside that one — two independent native
  // presentation windows, one inside the other — which is what caused the
  // app to hang solid on a bare black screen after Face ID/passcode unlock
  // on a real device (no crash log, because nothing threw; the two native
  // presentations just deadlocked against each other). A plain View is
  // enough now that the outer Modal already guarantees full-screen coverage.
  return (
    <>
      {/* The background sits on the outer View, not the SafeAreaView, so the
          colour reaches under the notch and home indicator instead of
          leaving unpainted bands there. */}
      <View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: theme.background }]}>
        <SafeAreaView style={styles.container}>
          <View style={styles.content}>
            <Ionicons name="lock-closed" size={40} color={theme.accent} />
            <Text style={[styles.title, { color: theme.text }]}>Enter Passcode</Text>
            {lockedOut ? (
              <Text style={[styles.lockoutText, { color: theme.danger }]}>
                Too many attempts. Try again in {lockoutSecondsLeft}s.
              </Text>
            ) : null}

            <View style={styles.dots}>
              {Array.from({ length: PASSCODE_LENGTH }).map((_, index) => (
                <View
                  key={index}
                  style={[
                    styles.dot,
                    {
                      borderColor: error ? theme.danger : theme.accent,
                      backgroundColor:
                        index < entered.length ? (error ? theme.danger : theme.accent) : "transparent",
                    },
                  ]}
                />
              ))}
            </View>

            <View style={[styles.pad, lockedOut && styles.padDisabled]} pointerEvents={lockedOut ? "none" : "auto"}>
              {KEYPAD_ROWS.map((row) => (
                <View key={row.join(",")} style={styles.padRow}>
                  {row.map((digit) => (
                    <Pressable
                      key={digit}
                      onPress={() => handleDigit(digit)}
                      accessibilityRole="button"
                      accessibilityLabel={`${digit}`}
                      style={({ pressed }) => [
                        styles.key,
                        { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
                      ]}
                    >
                      <Text style={[styles.keyText, { color: theme.text }]}>{digit}</Text>
                    </Pressable>
                  ))}
                </View>
              ))}

              <View style={styles.padRow}>
                {biometricsAvailable ? (
                  <Pressable
                    onPress={() => void unlockWithBiometrics()}
                    accessibilityRole="button"
                    accessibilityLabel="Unlock with biometrics"
                    style={styles.key}
                  >
                    {biometricKind === "face" ? (
                      <FaceIdIcon size={28} color={theme.accent} />
                    ) : (
                      <Ionicons name={IONICON_FALLBACK[biometricKind]} size={28} color={theme.accent} />
                    )}
                  </Pressable>
                ) : (
                  <View style={styles.key} />
                )}

                <Pressable
                  onPress={() => handleDigit(0)}
                  accessibilityRole="button"
                  accessibilityLabel="0"
                  style={({ pressed }) => [
                    styles.key,
                    { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
                  ]}
                >
                  <Text style={[styles.keyText, { color: theme.text }]}>0</Text>
                </Pressable>

                <Pressable
                  onPress={handleBackspace}
                  accessibilityRole="button"
                  accessibilityLabel="Backspace"
                  style={({ pressed }) => [
                    styles.key,
                    { backgroundColor: pressed ? theme.surfaceElevated : "transparent" },
                  ]}
                >
                  <Ionicons name="backspace-outline" size={26} color={theme.text} />
                </Pressable>
              </View>
            </View>
          </View>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  title: { fontSize: 20, fontWeight: "600" },
  dots: { flexDirection: "row", gap: spacing.md, marginVertical: spacing.lg },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  pad: { gap: spacing.sm },
  padDisabled: { opacity: 0.35 },
  lockoutText: { fontSize: 14, fontWeight: "500", marginTop: -spacing.md },
  padRow: { flexDirection: "row", justifyContent: "center", gap: spacing.sm },
  key: {
    width: 80,
    height: 80,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 40,
  },
  keyText: { fontSize: 28, fontWeight: "500" },
});
