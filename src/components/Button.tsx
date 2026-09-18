import { forwardRef } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { radius, spacing } from "../theme";
import { useTheme } from "../hooks/useTheme";

type ButtonProps = PressableProps & {
  title: string;
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Overrides the variant's default text/spinner color — e.g. a "secondary"
   * button used for a destructive action like Block. */
  textColor?: string;
};

export const Button = forwardRef<any, ButtonProps>(function Button(
  { title, variant = "primary", loading = false, disabled, style, textColor: textColorProp, ...rest },
  ref
) {
  const { theme } = useTheme();
  const isDisabled = disabled || loading;

  const backgroundColor =
    variant === "primary" ? theme.accent : variant === "secondary" ? "transparent" : "transparent";
  const textColor = textColorProp ?? (variant === "primary" ? "#FFFFFF" : theme.accent);

  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor,
          borderColor: variant === "secondary" ? textColor : "transparent",
          borderWidth: variant === "secondary" ? 1 : 0,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[styles.label, { color: textColor }]}>{title}</Text>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: {
    minHeight: 50,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  label: { fontSize: 16, fontWeight: "600" },
});
