import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

/**
 * App-level passcode lock (Telegram's "Passcode Lock"): a PIN required to
 * open the app, independent of the account's own password. Stored as a
 * SHA-256 hash in expo-secure-store, never in plaintext, and never sent to
 * the server — this is purely a local device gate, not an auth mechanism.
 */

const PASSCODE_HASH_KEY = "televo.passcode.hash";
const BIOMETRIC_ENABLED_KEY = "televo.passcode.biometric-enabled";

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
}

export async function verifyPasscode(passcode: string): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(PASSCODE_HASH_KEY);
  if (!stored) return false;
  const hash = await hashPasscode(passcode);
  return hash === stored;
}

export async function clearPasscode(): Promise<void> {
  await SecureStore.deleteItemAsync(PASSCODE_HASH_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
  return stored === "true";
}

export async function setBiometricUnlockEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, enabled ? "true" : "false");
}
