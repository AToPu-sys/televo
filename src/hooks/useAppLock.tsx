import * as LocalAuthentication from "expo-local-authentication";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";

import { isBiometricUnlockEnabled, isPasscodeSet, verifyPasscode } from "../lib/passcode";

// How long the app can be backgrounded before the lock screen reappears.
// Telegram calls this "Auto-Lock"; a short grace period avoids re-prompting
// for a quick app-switch (e.g. copying a code from another app).
const GRACE_PERIOD_MS = 30_000;

type AppLockContextValue = {
  /** True once we've checked whether a passcode is even configured. */
  ready: boolean;
  /** True if a passcode exists AND the app is currently locked. */
  isLocked: boolean;
  hasPasscode: boolean;
  unlockWithPasscode: (passcode: string) => Promise<boolean>;
  unlockWithBiometrics: () => Promise<boolean>;
  /** Call after enabling/disabling the passcode in Settings. */
  refreshLockState: () => Promise<void>;
};

const AppLockContext = createContext<AppLockContextValue | undefined>(undefined);

export function AppLockProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [hasPasscode, setHasPasscode] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  const refreshLockState = useCallback(async () => {
    const configured = await isPasscodeSet();
    setHasPasscode(configured);
    if (!configured) setIsLocked(false);
  }, []);

  useEffect(() => {
    (async () => {
      const configured = await isPasscodeSet();
      setHasPasscode(configured);
      // Start locked if a passcode exists — the very first app launch this
      // session should require it, same as Telegram's own behavior.
      setIsLocked(configured);
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!hasPasscode) return;

    const handleChange = (state: AppStateStatus) => {
      if (state === "background" || state === "inactive") {
        backgroundedAt.current = Date.now();
      } else if (state === "active" && backgroundedAt.current) {
        const elapsed = Date.now() - backgroundedAt.current;
        if (elapsed > GRACE_PERIOD_MS) {
          setIsLocked(true);
        }
        backgroundedAt.current = null;
      }
    };

    const subscription = AppState.addEventListener("change", handleChange);
    return () => subscription.remove();
  }, [hasPasscode]);

  const unlockWithPasscode = useCallback(async (passcode: string) => {
    const valid = await verifyPasscode(passcode);
    if (valid) setIsLocked(false);
    return valid;
  }, []);

  const unlockWithBiometrics = useCallback(async () => {
    const biometricsOn = await isBiometricUnlockEnabled();
    if (!biometricsOn) return false;

    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !enrolled) return false;

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock Televo",
      disableDeviceFallback: false,
    });

    if (result.success) {
      setIsLocked(false);
      return true;
    }
    return false;
  }, []);

  return (
    <AppLockContext.Provider
      value={{ ready, isLocked, hasPasscode, unlockWithPasscode, unlockWithBiometrics, refreshLockState }}
    >
      {children}
    </AppLockContext.Provider>
  );
}

export function useAppLock() {
  const context = useContext(AppLockContext);
  if (!context) {
    throw new Error("useAppLock must be used within an AppLockProvider");
  }
  return context;
}
