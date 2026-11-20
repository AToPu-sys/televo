import { useRouter } from "expo-router";
import { Image, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { Button } from "../../src/components/Button";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";

/** Two soft glows in the app icon's colours: warm from the top, cool from
 * the bottom. Drawn with SVG so it looks the same on iOS, Android and web. */
function Glow() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id="warm" cx="22%" cy="8%" r="70%">
          <Stop offset="0" stopColor="#F08A4B" stopOpacity="0.34" />
          <Stop offset="1" stopColor="#F08A4B" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="cool" cx="88%" cy="96%" r="72%">
          <Stop offset="0" stopColor="#4C8DFF" stopOpacity="0.26" />
          <Stop offset="1" stopColor="#4C8DFF" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill="url(#warm)" />
      <Rect x="0" y="0" width="100" height="100" fill="url(#cool)" />
    </Svg>
  );
}

export default function WelcomeScreen() {
  const { theme } = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <Glow />
      <SafeAreaView style={styles.container}>
        <View style={styles.hero}>
          <Image
            source={require("../../assets/welcome-icon.png")}
            style={styles.logo}
            accessibilityIgnoresInvertColors
            accessible
            accessibilityLabel="Televo"
          />
          <Text style={[styles.title, { color: theme.text }]}>Televo</Text>
          <Text style={[styles.tagline, { color: "#F2A272" }]}>Free · Fast · Simple</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            Private messages and calls. Secret Chats only the two of you can read.
          </Text>
        </View>

        <View style={styles.actions}>
          <Button title="Continue with Email" onPress={() => router.push("/(auth)/sign-in")} />
          <Button
            title="Log in with QR Code"
            variant="ghost"
            onPress={() => router.push("/(auth)/qr-sign-in")}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  container: {
    flex: 1,
    justifyContent: "space-between",
    padding: spacing.xl,
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
  },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  logo: {
    width: 120,
    height: 120,
    borderRadius: 28,
    shadowColor: "#F08A4B",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
  },
  title: { fontSize: 34, fontWeight: "700", letterSpacing: -0.5 },
  tagline: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: -spacing.xs,
  },
  subtitle: { fontSize: 16, textAlign: "center", lineHeight: 23, paddingHorizontal: spacing.md },
  actions: { gap: spacing.md, paddingBottom: spacing.lg },
});
