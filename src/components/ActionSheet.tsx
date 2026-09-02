import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../hooks/useTheme";
import { radius, spacing } from "../theme";

export type ActionSheetOption = {
  key: string;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  onPress: () => void;
};

type ActionSheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  options: ActionSheetOption[];
};

/**
 * A Telegram-style in-app bottom sheet — slides up from the bottom of the
 * screen, dims the content behind it, and lives inside the app's own visual
 * language (theme colors, radii) — as opposed to react-native's Alert.alert,
 * which renders as a native OS dialog with the platform's own chrome and
 * can't be restyled.
 */
export function ActionSheet({ visible, onClose, title, options }: ActionSheetProps) {
  const { theme } = useTheme();
  const translateY = useRef(new Animated.Value(300)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(backdropOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      translateY.setValue(300);
      backdropOpacity.setValue(0);
    }
  }, [visible, translateY, backdropOpacity]);

  function handleClose() {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 300, duration: 180, useNativeDriver: true }),
      Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) onClose();
    });
  }

  function handleSelect(option: ActionSheetOption) {
    handleClose();
    // Let the close animation start before running the action, so the sheet
    // doesn't appear to freeze while e.g. a picker or alert opens on top of it.
    setTimeout(option.onPress, 180);
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} accessibilityLabel="Close" />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheetWrapper,
          { transform: [{ translateY }] } as ViewStyle,
        ]}
      >
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: theme.surfaceElevated }}>
          <View style={styles.handle} />
          {title ? (
            <Text style={[styles.title, { color: theme.textSecondary }]}>{title}</Text>
          ) : null}

          {options.map((option, index) => (
            <Pressable
              key={option.key}
              onPress={() => handleSelect(option)}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.row,
                index > 0 && { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth },
                pressed && { backgroundColor: theme.background },
              ]}
            >
              {option.icon ? (
                <Ionicons
                  name={option.icon}
                  size={20}
                  color={option.destructive ? theme.danger : theme.accent}
                  style={styles.rowIcon}
                />
              ) : null}
              <Text
                style={[
                  styles.rowLabel,
                  { color: option.destructive ? theme.danger : theme.text },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}

          <Pressable
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={({ pressed }) => [
              styles.cancelRow,
              { backgroundColor: pressed ? theme.background : theme.surfaceElevated },
            ]}
          >
            <Text style={[styles.cancelLabel, { color: theme.accent }]}>Cancel</Text>
          </Pressable>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrapper: { position: "absolute", left: 0, right: 0, bottom: 0 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(128,128,128,0.4)",
    alignSelf: "center",
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    paddingVertical: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    minHeight: 52,
  },
  rowIcon: { marginRight: spacing.md, width: 24, textAlign: "center" },
  rowLabel: { fontSize: 16, flex: 1 },
  cancelRow: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    alignItems: "center",
    borderRadius: radius.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  cancelLabel: { fontSize: 16, fontWeight: "600" },
});
