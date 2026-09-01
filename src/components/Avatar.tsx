import { Image, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../hooks/useTheme";

// Telegram assigns each user one of a small set of accent colors, keyed off
// their name so it stays stable between sessions.
const AVATAR_COLORS = ["#E17076", "#7BC862", "#65AADD", "#A695E7", "#EE7AAE", "#F0A34F"];

function colorFor(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash + seed.charCodeAt(index)) % AVATAR_COLORS.length;
  }
  return AVATAR_COLORS[hash];
}

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("") || "?";
}

type AvatarProps = {
  name: string;
  uri?: string | null;
  size?: number;
  online?: boolean;
};

export function Avatar({ name, uri, size = 52, online = false }: AvatarProps) {
  const { theme } = useTheme();
  const dimension = { width: size, height: size, borderRadius: size / 2 };

  return (
    <View>
      {uri ? (
        <Image source={{ uri }} style={dimension} accessibilityIgnoresInvertColors />
      ) : (
        <View style={[dimension, styles.fallback, { backgroundColor: colorFor(name) }]}>
          <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{initialsFor(name)}</Text>
        </View>
      )}
      {online ? (
        <View
          style={[
            styles.presence,
            {
              backgroundColor: theme.online,
              borderColor: theme.background,
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: size * 0.14,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: "center", justifyContent: "center" },
  initials: { color: "#FFFFFF", fontWeight: "600" },
  presence: { position: "absolute", right: 0, bottom: 0, borderWidth: 2 },
});
