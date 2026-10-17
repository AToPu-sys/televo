import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";

/**
 * Shared pieces of the call screen's chrome, styled to match the native
 * SwiftUI voice screen (modules/expo-televo-audio/ios/TelevoCallScreen.swift):
 * frosted white-on-dark capsules, an "Encrypted" badge, signal bars, and the
 * blue-violet colour field used when there's no video to show.
 */

/** "Encrypted" capsule — calls are DTLS-SRTP encrypted in transit. */
export function EncryptedPill({ onVideo }: { onVideo: boolean }) {
  return (
    <View style={[styles.pill, { backgroundColor: onVideo ? "rgba(255,255,255,0.16)" : "rgba(127,127,127,0.16)" }]}>
      <Ionicons name="lock-closed" size={11} color={onVideo ? "rgba(255,255,255,0.9)" : "#8A9AA9"} />
      <Text style={[styles.pillText, { color: onVideo ? "rgba(255,255,255,0.9)" : "#8A9AA9" }]}>Encrypted</Text>
    </View>
  );
}

const BAR_COLORS = ["#EB4D4B", "#F2B33D", "#FFFFFF", "#7BD88F"];

/** Four signal bars from useCall's quality (0 bad … 3 excellent). */
export function QualityBars({ level, onVideo }: { level: 0 | 1 | 2 | 3; onVideo: boolean }) {
  const lit = level + 1;
  const on = level >= 2 ? (onVideo ? "#FFFFFF" : "#4DCD5E") : BAR_COLORS[level];
  const off = onVideo ? "rgba(255,255,255,0.28)" : "rgba(127,127,127,0.3)";
  return (
    <View
      style={styles.bars}
      accessibilityRole="image"
      accessibilityLabel={["Poor connection", "Weak connection", "Good connection", "Excellent connection"][level]}
    >
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={[styles.bar, { height: 5 + i * 3, backgroundColor: i < lit ? on : off }]} />
      ))}
    </View>
  );
}

/** Dark gradient behind the header (top) or the controls (bottom), so white
 * text and glass buttons stay legible over any video. */
export function Scrim({ position, height }: { position: "top" | "bottom"; height: number }) {
  const top = position === "top";
  return (
    <View pointerEvents="none" style={[styles.scrim, top ? { top: 0 } : { bottom: 0 }, { height }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={`scrim-${position}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity={top ? 0.55 : 0} />
            <Stop offset="1" stopColor="#000000" stopOpacity={top ? 0 : 0.62} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#scrim-${position})`} />
      </Svg>
    </View>
  );
}

/** Background for a camera-off tile: the voice screen's calling palette
 * instead of flat black. */
export function CameraOffBackdrop() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="camoff-base" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#1B2350" />
            <Stop offset="1" stopColor="#0C0D16" />
          </LinearGradient>
          <RadialGradient id="camoff-glow-a" cx="25%" cy="30%" r="55%">
            <Stop offset="0" stopColor="#4F72F5" stopOpacity={0.55} />
            <Stop offset="1" stopColor="#4F72F5" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="camoff-glow-b" cx="80%" cy="75%" r="60%">
            <Stop offset="0" stopColor="#8A55F2" stopOpacity={0.45} />
            <Stop offset="1" stopColor="#8A55F2" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#camoff-base)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#camoff-glow-a)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#camoff-glow-b)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "500" },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 14 },
  bar: { width: 3, borderRadius: 1.5 },
  scrim: { position: "absolute", left: 0, right: 0 },
});
