import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../../src/components/Button";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";

export default function WelcomeScreen() {
  const { theme } = useTheme();
  const router = useRouter();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.hero}>
        <View style={[styles.logo, { backgroundColor: theme.accent }]}>
          <Ionicons name="chatbubbles" size={56} color="#FFFFFF" />
        </View>
        <Text style={[styles.title, { color: theme.text }]}>Televo</Text>
        <Text style={[styles.tagline, { color: theme.accent }]}>
          Fast · Secure · Simple
        </Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          End-to-end encrypted messages and calls.
        </Text>
      </View>

      <View style={styles.actions}>
        <Button title="Continue with Email" onPress={() => router.push("/(auth)/sign-in")} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "space-between", padding: spacing.xl },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  logo: {
    width: 112,
    height: 112,
    borderRadius: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 30, fontWeight: "700" },
  tagline: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: spacing.xs,
  },
  subtitle: { fontSize: 16, textAlign: "center", lineHeight: 22, paddingHorizontal: spacing.lg },
  actions: { gap: spacing.md, paddingBottom: spacing.lg },
});
