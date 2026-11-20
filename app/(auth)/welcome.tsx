import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { Button } from "../../src/components/Button";
import { useTheme } from "../../src/hooks/useTheme";
import { spacing } from "../../src/theme";

const NATIVE_DRIVER = Platform.OS !== "web";

/** One soft glow in the app icon's colours. Drawn with SVG so it looks the
 * same on iOS, Android and web. */
function GlowLayer({ id, color, cx, cy, opacity }: { id: string; color: string; cx: string; cy: string; opacity: number }) {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={id} cx={cx} cy={cy} r="70%">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill={`url(#${id})`} />
    </Svg>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => active && setReduced(v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

export default function WelcomeScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();

  // Entrance: icon, then title, tagline, subtitle, then the buttons.
  const icon = useRef(new Animated.Value(0)).current;
  const flash = useRef(new Animated.Value(0)).current;
  const lines = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  const actions = useRef(new Animated.Value(0)).current;
  // Ambient: the background glows breathe and drift, slowly, forever.
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      [icon, actions, ...lines].forEach((v) => v.setValue(1));
      return;
    }
    const fade = (v: Animated.Value, delay: number, duration = 520) =>
      Animated.timing(v, { toValue: 1, duration, delay, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE_DRIVER });
    const entrance = Animated.parallel([
      Animated.spring(icon, { toValue: 1, friction: 6, tension: 60, useNativeDriver: NATIVE_DRIVER }),
      Animated.sequence([
        Animated.timing(flash, { toValue: 1, duration: 380, delay: 120, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(flash, { toValue: 0, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
      ]),
      fade(lines[0], 260),
      fade(lines[1], 380),
      fade(lines[2], 500),
      fade(actions, 700, 600),
    ]);
    const ambient = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 7000, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(drift, { toValue: 0, duration: 7000, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE_DRIVER }),
      ])
    );
    entrance.start();
    ambient.start();
    return () => {
      entrance.stop();
      ambient.stop();
    };
  }, [reduced, icon, flash, lines, actions, drift]);

  const rise = (v: Animated.Value, by = 14) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [by, 0] }) }],
  });

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: drift.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
            transform: [
              { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [-18, 18] }) },
              { scale: drift.interpolate({ inputRange: [0, 1], outputRange: [1.05, 1.12] }) },
            ],
          },
        ]}
        pointerEvents="none"
      >
        <GlowLayer id="warm" color="#F08A4B" cx="22%" cy="8%" opacity={0.34} />
      </Animated.View>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: drift.interpolate({ inputRange: [0, 1], outputRange: [1, 0.8] }),
            transform: [
              { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [16, -16] }) },
              { scale: 1.1 },
            ],
          },
        ]}
        pointerEvents="none"
      >
        <GlowLayer id="cool" color="#4C8DFF" cx="88%" cy="96%" opacity={0.26} />
      </Animated.View>

      <SafeAreaView style={styles.container}>
        <View style={styles.hero}>
          <View style={styles.iconWrap}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.iconFlash,
                {
                  opacity: flash.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }),
                  transform: [{ scale: flash.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.6] }) }],
                },
              ]}
            />
            <Animated.Image
              source={require("../../assets/welcome-icon.png")}
              style={[
                styles.logo,
                {
                  opacity: icon.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1], extrapolate: "clamp" }),
                  transform: [
                    { scale: icon.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
                    { rotate: icon.interpolate({ inputRange: [0, 1], outputRange: ["-8deg", "0deg"] }) },
                  ],
                },
              ]}
              accessibilityIgnoresInvertColors
              accessible
              accessibilityLabel="Televo"
            />
          </View>
          <Animated.Text style={[styles.title, { color: theme.text }, rise(lines[0])]}>Televo</Animated.Text>
          <Animated.Text style={[styles.tagline, rise(lines[1])]}>Free · Fast · Simple</Animated.Text>
          <Animated.Text style={[styles.subtitle, { color: theme.textSecondary }, rise(lines[2])]}>
            Private messages and calls. Secret Chats only the two of you can read.
          </Animated.Text>
        </View>

        <Animated.View style={[styles.actions, rise(actions, 24)]}>
          <Button title="Continue with Email" onPress={() => router.push("/(auth)/sign-in")} />
          <Button
            title="Log in with QR Code"
            variant="ghost"
            onPress={() => router.push("/(auth)/qr-sign-in")}
          />
        </Animated.View>
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
  iconWrap: { width: 120, height: 120, alignItems: "center", justifyContent: "center" },
  iconFlash: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#F08A4B",
  },
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
    color: "#F2A272",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: -spacing.xs,
  },
  subtitle: { fontSize: 16, textAlign: "center", lineHeight: 23, paddingHorizontal: spacing.md },
  actions: { gap: spacing.md, paddingBottom: spacing.lg },
});
