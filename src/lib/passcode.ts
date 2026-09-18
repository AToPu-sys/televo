import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";

/**
 * App-level passcode lock (Telegram's "Passcode Lock"): a PIN required to
 * open the app, independent of the account's own password. Stored as a
 * SHA-256 hash in expo-secure-store, never in plaintext, and never sent to
 * the server — this is purely a local device gate, not an auth mechanism.
 */

const PASSCODE_HASH_KEY = "televo.passcode.hash";
const BIOMETRIC_ENABLED_KEY = "televo.passcode.biometric-enabled";
const FAILED_ATTEMPTS_KEY = "televo.passcode.failed-attempts";
const LOCKOUT_UNTIL_KEY = "televo.passcode.lockout-until";

async function hashPasscode(passcode: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `televo-passcode:${passcode}`);
}

export async function isPasscodeSet(): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(PASSCODE_HASH_KEY);
  return !!stored;
}

export async function setPasscode(passcode: string): Promise<void> {
  const hash = await hashPasscode(passcode);
  await SecureStore.setItemAsync(PASSCODE_HASH_KEY, hash);
  await SecureStore.deleteItemAsync(FAILED_ATTEMPTS_KEY);
  await SecureStore.deleteItemAsync(LOCKOUT_UNTIL_KEY);
}

// A 4-digit PIN has only 10,000 combinations — with no lockout, an
// automated tap script can brute-force it in minutes against exactly the
// threat model a passcode lock exists for (physical access). Delays are
// persisted in SecureStore, not component state, so backgrounding or
// relaunching the app doesn't reset the counter. Mirrors Telegram's own
// Passcode Lock, which this feature was explicitly modeled on.
const LOCKOUT_SCHEDULE_MS = [0, 0, 0, 5_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type LockoutStatus = { locked: false } | { locked: true; retryAt: number };

export async function getLockoutStatus(): Promise<LockoutStatus> {
  const until = await SecureStore.getItemAsync(LOCKOUT_UNTIL_KEY);
  if (!until) return { locked: false };
  const retryAt = Number(until);
  if (!Number.isFinite(retryAt) || retryAt <= Date.now()) return { locked: false };
  return { locked: true, retryAt };
}

async function recordFailedAttempt(): Promise<void> {
  const stored = await SecureStore.getItemAsync(FAILED_ATTEMPTS_KEY);
  const count = (Number(stored) || 0) + 1;
  await SecureStore.setItemAsync(FAILED_ATTEMPTS_KEY, String(count));
  const delay = LOCKOUT_SCHEDULE_MS[Math.min(count, LOCKOUT_SCHEDULE_MS.length - 1)];
  if (delay > 0) {
    await SecureStore.setItemAsync(LOCKOUT_UNTIL_KEY, String(Date.now() + delay));
  }
}

async function clearFailedAttempts(): Promise<void> {
  await SecureStore.deleteItemAsync(FAILED_ATTEMPTS_KEY);
  await SecureStore.deleteItemAsync(LOCKOUT_UNTIL_KEY);
}

export async function verifyPasscode(passcode: string): Promise<boolean> {
  const status = await getLockoutStatus();
  if (status.locked) return false;

  const stored = await SecureStore.getItemAsync(PASSCODE_HASH_KEY);
  if (!stored) return false;
  const hash = await hashPasscode(passcode);
  const valid = hash === stored;

  if (valid) {
    await clearFailedAttempts();
  } else {
    await recordFailedAttempt();
  }
  return valid;
}

export async function clearPasscode(): Promise<void> {
  await SecureStore.deleteItemAsync(PASSCODE_HASH_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
  await SecureStore.deleteItemAsync(FAILED_ATTEMPTS_KEY);
  await SecureStore.deleteItemAsync(LOCKOUT_UNTIL_KEY);
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
  return stored === "true";
}

export async function setBiometricUnlockEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, enabled ? "true" : "false");
}

export type BiometricKind = "face" | "fingerprint" | "iris" | "generic";

/**
 * Which biometric the device actually enrolls, so the UI can show the right
 * icon/label — an iPhone with Face ID has no fingerprint sensor at all, so a
 * hardcoded "finger-print" glyph was simply wrong on every Face ID device
 * (which is most current iPhones).
 */
export async function getBiometricKind(): Promise<BiometricKind> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return "face";
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return "fingerprint";
    if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return "iris";
    return "generic";
  } catch {
    return "generic";
  }
}
