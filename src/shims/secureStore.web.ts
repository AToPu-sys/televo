// Web stand-in for expo-secure-store (wired in metro.config.js for the web
// build only). Same async API, so the app code doesn't change.
//
// Values live in IndexedDB, encrypted with AES-GCM under a key the browser
// generates as NON-EXTRACTABLE and keeps in IndexedDB as a CryptoKey object:
// page script can use it but no API can read its raw bytes, so copying the
// storage off the disk (or a browser-sync / backup dump) yields only
// ciphertext. This does not protect against script running inside the page
// (XSS) — that is what the strict Content-Security-Policy is for.

const DB = "televo-secure";
const STORE = "kv";
const KEY_ID = "__wrap_key__";

export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

let keyPromise: Promise<CryptoKey> | null = null;
function wrapKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await tx<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID));
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await tx("readwrite", (s) => s.put(key, KEY_ID));
      return key;
    })();
  }
  return keyPromise;
}

function storageKey(key: string) {
  if (!/^[\w.-]+$/.test(key)) throw new Error("Invalid key provided to SecureStore.");
  return "v:" + key;
}

export async function setItemAsync(key: string, value: string, _options?: unknown): Promise<void> {
  if (typeof value !== "string") throw new Error("SecureStore values must be strings.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrapKey(), new TextEncoder().encode(value));
  await tx("readwrite", (s) => s.put({ iv, data }, storageKey(key)));
}

export async function getItemAsync(key: string, _options?: unknown): Promise<string | null> {
  const row = await tx<{ iv: Uint8Array; data: ArrayBuffer } | undefined>("readonly", (s) => s.get(storageKey(key)));
  if (!row) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.iv }, await wrapKey(), row.data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function deleteItemAsync(key: string, _options?: unknown): Promise<void> {
  await tx("readwrite", (s) => s.delete(storageKey(key)));
}

export async function isAvailableAsync(): Promise<boolean> {
  return typeof indexedDB !== "undefined" && !!globalThis.crypto?.subtle;
}

export function getItem(): string | null {
  throw new Error("Synchronous SecureStore access is not available on the web.");
}
export function setItem(): void {
  throw new Error("Synchronous SecureStore access is not available on the web.");
}
export function canUseBiometricAuthentication(): boolean {
  return false;
}
