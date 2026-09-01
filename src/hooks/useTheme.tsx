import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";

import { darkTheme, lightTheme, type Theme, type ThemeName } from "../theme";

const STORAGE_KEY = "tgclone.theme-preference";

/** "system" follows the OS; the explicit values override it. */
type ThemePreference = ThemeName | "system";

type ThemeContextValue = {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!active) return;
        if (stored === "light" || stored === "dark" || stored === "system") {
          setPreferenceState(stored);
        }
      })
      .catch(() => {
        // A missing/unreadable preference just means we stay on "system".
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
      // Persisting is best-effort; the in-memory choice still applies.
    });
  }, []);

  const resolvedName: ThemeName =
    preference === "system" ? (systemScheme === "dark" ? "dark" : "light") : preference;

  const toggle = useCallback(() => {
    setPreference(resolvedName === "dark" ? "light" : "dark");
  }, [resolvedName, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: resolvedName === "dark" ? darkTheme : lightTheme,
      preference,
      setPreference,
      toggle,
    }),
    [resolvedName, preference, setPreference, toggle]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
