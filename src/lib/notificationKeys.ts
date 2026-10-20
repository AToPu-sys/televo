import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import naclUtil from "tweetnacl-util";

/**
 * Hands Secret Chat session keys to the Notification Service Extension
 * (plugins/notification-service), so a push for a Secret Chat message can be
 * decrypted ON THE PHONE and show the real text instead of "sent a message".
 * The server still never sees plaintext: it only forwards the same E2E
 * envelope it already stores.
 *
 * The extension is a separate process and can't read the app's own keychain
 * items, so each conversation's session key is copied into a keychain access
 * group both targets are entitled to. Only per-conversation session keys go
 * there — the device's identity keys (X25519 / ML-KEM) never leave the app's
 * private group. AFTER_FIRST_UNLOCK because pushes arrive while the phone is
 * locked; ThisDeviceOnly keeps the copy out of backups like the originals.
 */

// Must match keychain-access-groups in both targets' entitlements; the team
// prefix is part of the group name.
const SHARED_KEYCHAIN_GROUP = "P37BNY7C4J.com.televo.app.shared";
// The extension reads service "televo.nse:no-auth" — expo-secure-store
// appends ":no-auth" to keychainService for items without biometrics.
const KEYCHAIN_SERVICE = "televo.nse";

const SHARED = {
  keychainService: KEYCHAIN_SERVICE,
  accessGroup: SHARED_KEYCHAIN_GROUP,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
// The keychain can't be listed through SecureStore, so the conversations whose
// keys were copied are kept in an index item next to them; signing out reads
// it to delete every copy.
const INDEX_KEY = "nse.index";
let indexWrite: Promise<void> = Promise.resolve();

async function readIndex(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY, SHARED);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberShared(conversationId: string): Promise<void> {
  indexWrite = indexWrite.then(async () => {
    const ids = await readIndex();
    if (ids.includes(conversationId)) return;
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...ids, conversationId]), SHARED);
  }).catch(() => {});
  return indexWrite;
}

/**
 * Deletes every Secret Chat session key this device copied for the
 * notification extension. Called on sign-out (account deletion signs out
 * too): otherwise the keys outlive the account in a keychain readable while
 * the phone is locked, and could decrypt stored or intercepted envelopes.
 */
export async function wipeSharedSessionKeys(): Promise<void> {
  if (Platform.OS !== "ios") return;
  copied.clear();
  indexWrite = indexWrite.then(async () => {
    for (const id of await readIndex()) {
      await SecureStore.deleteItemAsync(`nse.sk.${id}`, SHARED).catch(() => {});
    }
    await SecureStore.deleteItemAsync(INDEX_KEY, SHARED).catch(() => {});
  }).catch(() => {});
  return indexWrite;
}

// Last key copied per conversation in this app session, so reloading a chat
// doesn't rewrite the keychain, but a rekeyed chat does.
const copied = new Map<string, string>();

export async function shareSessionKeyWithNotifications(
  conversationId: string,
  sessionKey: Uint8Array
): Promise<void> {
  if (Platform.OS !== "ios") return;
  const encoded = naclUtil.encodeBase64(sessionKey);
  if (copied.get(conversationId) === encoded) return;
  copied.set(conversationId, encoded);
  try {
    await SecureStore.setItemAsync(`nse.sk.${conversationId}`, encoded, SHARED);
    await rememberShared(conversationId);
  } catch (error) {
    // A binary without the keychain-sharing entitlement ends up here; its
    // Secret Chat pushes just keep the generic text. Not retried this
    // session — the entitlement can't appear without a new build.
    console.warn("[notificationKeys] could not share session key", error);
  }
}

/**
 * This device's own copy of a conversation's session key, written by
 * shareSessionKeyWithNotifications. Lets a Secret Chat be read with no
 * connection: loadSessionKey asks the server for the wrapped key first (so a
 * rekey always wins) and falls back to this only when that request fails.
 */
export async function readSharedSessionKey(conversationId: string): Promise<Uint8Array | null> {
  if (Platform.OS !== "ios") return null;
  try {
    const encoded = await SecureStore.getItemAsync(`nse.sk.${conversationId}`, SHARED);
    if (!encoded) return null;
    const key = naclUtil.decodeBase64(encoded);
    if (key.length !== 32) return null;
    copied.set(conversationId, encoded);
    return key;
  } catch {
    return null;
  }
}

