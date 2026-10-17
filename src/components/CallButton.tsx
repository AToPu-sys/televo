import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

type CallButtonProps = {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  iconColor?: string;
  onPress: () => void;
  label: string;
  small?: boolean;
  rotate?: boolean;
  /** Show `label` as a caption under the circle (the call screen's style). */
  showLabel?: boolean;
  labelColor?: string;
};

export function CallButton({
  icon,
  color,
  iconColor = "#FFFFFF",
  onPress,
  label,
  small = false,
  rotate = false,
  showLabel = false,
  labelColor = "#FFFFFF",
}: CallButtonProps) {
  const size = small ? 60 : 68;

  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.button,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        <Ionicons
          name={icon}
          size={small ? 24 : 28}
          color={iconColor}
          style={rotate ? styles.rotated : undefined}
        />
      </Pressable>
      {showLabel ? (
        <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: "center", gap: 6 },
  label: { fontSize: 12, fontWeight: "500", maxWidth: 76, textAlign: "center" },
  button: { alignItems: "center", justifyContent: "center" },
  rotated: { transform: [{ rotate: "135deg" }] },
});
