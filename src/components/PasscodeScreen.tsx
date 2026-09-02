import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppLock } from "../hooks/useAppLock";
import { isBiometricUnlockEnabled } from "../lib/passcode";
import { useTheme } from "../hooks/useTheme";
import { spacing } from "../theme";

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

  useEffect(() => {
    isBiometricUnlockEnabled().then(setBiometricsAvailable);
    // Try biometrics immediately on mount, mirroring Telegram/most apps.
    void unlockWithBiometrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDigit(digit: number) {
    if (entered.length >= PASSCODE_LENGTH) return;
    const next = entered + String(digit);
    setEntered(next);
    setError(false);

    if (next.length === PASSCODE_LENGTH) {
      const success = await unlockWithPasscode(next);
      if (!success) {
        setError(true);
        setTimeout(() => setEntered(""), 400);
      }
    }
  }

  function handleBackspace() {
    setEntered((current) => current.slice(0, -1));
    setError(false);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.content}>
        <Ionicons name="lock-closed" size={40} color={theme.accent} />
        <Text style={[styles.title, { color: theme.text }]}>Enter Passcode</Text>

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

        <View style={styles.pad}>
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
                <Ionicons name="finger-print" size={28} color={theme.accent} />
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  title: { fontSize: 20, fontWeight: "600" },
  dots: { flexDirection: "row", gap: spacing.md, marginVertical: spacing.lg },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  pad: { gap: spacing.sm },
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
