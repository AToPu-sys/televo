import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppLock } from "../src/hooks/useAppLock";
import { useTheme } from "../src/hooks/useTheme";
import { setPasscode } from "../src/lib/passcode";
import { spacing } from "../src/theme";

const PASSCODE_LENGTH = 4;
// Standard phone keypad layout: 1-9 in order, then 0 centered on its own row.
const KEYPAD_ROWS = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
];

export default function SetPasscodeScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const { refreshLockState } = useAppLock();

  const [stage, setStage] = useState<"enter" | "confirm">("enter");
  const [firstEntry, setFirstEntry] = useState("");
  const [entered, setEntered] = useState("");
  const [error, setError] = useState(false);

  async function handleDigit(digit: number) {
    if (entered.length >= PASSCODE_LENGTH) return;
    const next = entered + String(digit);
    setEntered(next);
    setError(false);

    if (next.length !== PASSCODE_LENGTH) return;

    if (stage === "enter") {
      setFirstEntry(next);
      setEntered("");
      setStage("confirm");
      return;
    }

    // Confirm stage.
    if (next === firstEntry) {
      await setPasscode(next);
      await refreshLockState();
      router.back();
    } else {
      setError(true);
      setTimeout(() => {
        setEntered("");
        setFirstEntry("");
        setStage("enter");
        setError(false);
      }, 500);
    }
  }

  function handleBackspace() {
    setEntered((current) => current.slice(0, -1));
    setError(false);
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={styles.close}
        hitSlop={12}
      >
        <Ionicons name="close" size={26} color={theme.accent} />
      </Pressable>

      <View style={styles.content}>
        <Ionicons name="lock-closed" size={40} color={theme.accent} />
        <Text style={[styles.title, { color: theme.text }]}>
          {stage === "enter" ? "Set Passcode" : "Confirm Passcode"}
        </Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          {error ? "Passcodes didn't match — try again." : "This unlocks Televo on this device."}
        </Text>

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
            <View style={styles.key} />
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
  close: { alignSelf: "flex-end", padding: spacing.lg },
  content: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, marginTop: -60 },
  title: { fontSize: 20, fontWeight: "600", marginTop: spacing.md },
  subtitle: { fontSize: 14, textAlign: "center", paddingHorizontal: spacing.xl },
  dots: { flexDirection: "row", gap: spacing.md, marginVertical: spacing.lg },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  pad: { gap: spacing.sm },
  padRow: { flexDirection: "row", justifyContent: "center", gap: spacing.sm },
  key: { width: 80, height: 80, alignItems: "center", justifyContent: "center", borderRadius: 40 },
  keyText: { fontSize: 28, fontWeight: "500" },
});
