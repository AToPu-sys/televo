import { wipeAllAsync } from "../shims/secureStore.web";

// In a browser, signing out must leave nothing behind: a shared or borrowed
// computer would otherwise keep the account's Secret Chat private keys,
// readable by the next person at the keyboard, and a different account
// signing in there could even pick them up as its own.
export async function wipeDeviceSecretsOnSignOut(): Promise<void> {
  await wipeAllAsync();
}
