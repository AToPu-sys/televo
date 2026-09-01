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
};

export function CallButton({
  icon,
  color,
  iconColor = "#FFFFFF",
  onPress,
  label,
  small = false,
  rotate = false,
}: CallButtonProps) {
  const size = small ? 52 : 68;

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
          size={small ? 22 : 28}
          color={iconColor}
          style={rotate ? styles.rotated : undefined}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: "center" },
  button: { alignItems: "center", justifyContent: "center" },
  rotated: { transform: [{ rotate: "135deg" }] },
});
