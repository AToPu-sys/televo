export type ThemeName = "light" | "dark";

export type Theme = {
  name: ThemeName;
  background: string;
  surface: string;
  surfaceElevated: string;
  headerBackground: string;
  headerText: string;
  text: string;
  textSecondary: string;
  accent: string;
  accentText: string;
  bubbleOut: string;
  bubbleOutText: string;
  bubbleIn: string;
  bubbleInText: string;
  border: string;
  chatBackground: string;
  danger: string;
  online: string;
  unreadBadge: string;
};

// Telegram-inspired palettes. The blue is the signature accent in both modes;
// the chat canvas stays slightly tinted so bubbles read against it.
export const lightTheme: Theme = {
  name: "light",
  background: "#FFFFFF",
  surface: "#FFFFFF",
  surfaceElevated: "#F1F1F5",
  headerBackground: "#527DA3",
  headerText: "#FFFFFF",
  text: "#000000",
  textSecondary: "#707579",
  accent: "#3390EC",
  accentText: "#FFFFFF",
  bubbleOut: "#EFFDDE",
  bubbleOutText: "#000000",
  bubbleIn: "#FFFFFF",
  bubbleInText: "#000000",
  border: "#E4E4E8",
  chatBackground: "#D6E5F0",
  danger: "#E53935",
  online: "#4DCD5E",
  unreadBadge: "#3390EC",
};

export const darkTheme: Theme = {
  name: "dark",
  background: "#17212B",
  surface: "#17212B",
  surfaceElevated: "#232E3C",
  headerBackground: "#17212B",
  headerText: "#FFFFFF",
  text: "#FFFFFF",
  textSecondary: "#8A9AA9",
  accent: "#5EB5F7",
  accentText: "#FFFFFF",
  bubbleOut: "#2B5278",
  bubbleOutText: "#FFFFFF",
  bubbleIn: "#182533",
  bubbleInText: "#FFFFFF",
  border: "#101921",
  chatBackground: "#0E1621",
  danger: "#EC6657",
  online: "#4DCD5E",
  unreadBadge: "#5EB5F7",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
};
