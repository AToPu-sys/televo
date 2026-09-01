import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

import { useTheme } from "../hooks/useTheme";
import { radius, spacing } from "../theme";

type TextFieldProps = TextInputProps & {
  label: string;
  error?: string | null;
  hint?: string;
};

export function TextField({ label, error, hint, style, ...rest }: TextFieldProps) {
  const { theme } = useTheme();

  return (
    <View style={styles.wrapper}>
      {/* A visible label, not a placeholder-only field, so the purpose stays
          on screen once the user starts typing. */}
      <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          {
            backgroundColor: theme.surfaceElevated,
            color: theme.text,
            borderColor: error ? theme.danger : theme.border,
          },
          style,
        ]}
        placeholderTextColor={theme.textSecondary}
        accessibilityLabel={label}
        {...rest}
      />
      {error ? (
        <Text style={[styles.message, { color: theme.danger }]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.message, { color: theme.textSecondary }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: "600", marginLeft: spacing.xs },
  input: {
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    fontSize: 16,
  },
  message: { fontSize: 12, marginLeft: spacing.xs },
});
