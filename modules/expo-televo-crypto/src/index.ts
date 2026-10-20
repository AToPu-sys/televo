import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type TelevoCryptoModuleType = {
  isMLKEMAvailable: () => boolean;
  mlkem768Encapsulate: (publicKey: string) => { ciphertext: string; sharedSecret: string };
  mlkem768Decapsulate: (seed: string, ciphertext: string, publicKey: string | null) => string;
  secretboxSeal?: (message: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Promise<Uint8Array>;
  secretboxOpen?: (box: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Promise<Uint8Array | null>;
};

// Same guard as expo-speaker-toggle: a binary built before this module
// existed must not crash app launch — e2e.ts just stays on crystals-kyber-js.
let nativeModule: TelevoCryptoModuleType | null = null;
if (Platform.OS === "ios") {
  try {
    nativeModule = requireNativeModule("TelevoCrypto");
  } catch {
    nativeModule = null;
  }
}

let available: boolean | null = null;

/** True on iOS 26+ with this module in the binary: CryptoKit's ML-KEM-768
 * can stand in for crystals-kyber-js. */
export function isNativeMLKEMAvailable(): boolean {
  if (available === null) {
    try {
      available = nativeModule?.isMLKEMAvailable() ?? false;
    } catch {
      available = false;
    }
  }
  return available;
}

/** ML-KEM-768 encapsulation to a raw 1184-byte public key, all base64.
 * Throws when unavailable — callers check isNativeMLKEMAvailable first. */
export function mlkem768Encapsulate(publicKeyB64: string): { ciphertext: string; sharedSecret: string } {
  if (!nativeModule) throw new Error("TelevoCrypto native module is not in this build");
  return nativeModule.mlkem768Encapsulate(publicKeyB64);
}

/** ML-KEM-768 decapsulation with a private key given as its 64-byte FIPS 203
 * seed. Pass the matching public key to have CryptoKit verify the pair. */
export function mlkem768Decapsulate(seedB64: string, ciphertextB64: string, publicKeyB64?: string | null): string {
  if (!nativeModule) throw new Error("TelevoCrypto native module is not in this build");
  return nativeModule.mlkem768Decapsulate(seedB64, ciphertextB64, publicKeyB64 ?? null);
}

/** True when this build has the native (C) secretbox. */
export function isNativeSecretBoxAvailable(): boolean {
  return typeof nativeModule?.secretboxOpen === "function" && typeof nativeModule?.secretboxSeal === "function";
}

// The native side reads a typed array from its own start; a view into a
// larger buffer is passed as a compact copy to be safe.
function compact(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/** nacl.secretbox in C, off the JS thread. Same bytes as tweetnacl-js. */
export function secretboxSeal(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (!nativeModule?.secretboxSeal) throw new Error("native secretbox is not in this build");
  return nativeModule.secretboxSeal(compact(message), compact(nonce), compact(key));
}

/** nacl.secretbox.open in C, off the JS thread; null on a wrong key or
 * tampered data. */
export function secretboxOpen(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array | null> {
  if (!nativeModule?.secretboxOpen) throw new Error("native secretbox is not in this build");
  return nativeModule.secretboxOpen(compact(box), compact(nonce), compact(key));
}

