import "react-native-get-random-values";

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } = naclUtil;

/**
 * Opt-in end-to-end encryption for direct chats ("Secret Chats"), the same
 * shape as Telegram's design:
 *
 *  - Each device holds an X25519 keypair (nacl.box). The private key never
 *    leaves the device (expo-secure-store, hardware-backed where available);
 *    only the public key is ever sent to the server (profiles.e2e_public_key).
 *  - Starting a Secret Chat generates one random 32-byte session key, then
 *    wraps (nacl.box) a copy of it to each participant's public key and
 *    stores those wrapped copies server-side (encrypted_session_keys). The
 *    server can see ciphertext but never a key it can unwrap itself — that
 *    requires the recipient's private key, which never left their device.
 *  - Every message body in an encrypted conversation is
 *    nacl.secretbox(sessionKey, plaintext) before it's ever sent to Supabase.
 *
 * This is a from-scratch implementation for this app, not a vetted protocol
 * like Signal's — it gets the core primitive (X25519 + XSalsa20-Poly1305,
 * both from the audited tweetnacl library) right, but has none of Signal's
 * forward secrecy (key ratcheting) or multi-device story. Good enough to mean
 * the server genuinely cannot read message content; not a substitute for a
 * professionally audited protocol if that's a hard requirement.
 */

const PRIVATE_KEY_STORE_KEY = "televo.e2e.private-key";
const PUBLIC_KEY_STORE_KEY = "televo.e2e.public-key";

export type KeyPair = { publicKey: string; secretKey: string };

/** Loads this device's keypair, generating and persisting one on first use. */
export async function getOrCreateDeviceKeyPair(): Promise<KeyPair> {
  const [storedSecret, storedPublic] = await Promise.all([
    SecureStore.getItemAsync(PRIVATE_KEY_STORE_KEY),
    SecureStore.getItemAsync(PUBLIC_KEY_STORE_KEY),
  ]);

  if (storedSecret && storedPublic) {
    return { publicKey: storedPublic, secretKey: storedSecret };
  }

  const pair = nacl.box.keyPair();
  const publicKey = encodeBase64(pair.publicKey);
  const secretKey = encodeBase64(pair.secretKey);

  await Promise.all([
    SecureStore.setItemAsync(PRIVATE_KEY_STORE_KEY, secretKey),
    SecureStore.setItemAsync(PUBLIC_KEY_STORE_KEY, publicKey),
  ]);

  return { publicKey, secretKey };
}

/** Generates a fresh random 32-byte session key for one conversation. */
export function generateSessionKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

/** Wraps a session key to a recipient's public key (nacl.box). */
export function wrapSessionKey(
  sessionKey: Uint8Array,
  recipientPublicKeyB64: string,
  senderSecretKeyB64: string
): { encryptedKey: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(
    sessionKey,
    nonce,
    decodeBase64(recipientPublicKeyB64),
    decodeBase64(senderSecretKeyB64)
  );
  return { encryptedKey: encodeBase64(boxed), nonce: encodeBase64(nonce) };
}

/** Unwraps a session key that was boxed to this device's public key. */
export function unwrapSessionKey(
  encryptedKeyB64: string,
  nonceB64: string,
  senderPublicKeyB64: string,
  recipientSecretKeyB64: string
): Uint8Array | null {
  const opened = nacl.box.open(
    decodeBase64(encryptedKeyB64),
    decodeBase64(nonceB64),
    decodeBase64(senderPublicKeyB64),
    decodeBase64(recipientSecretKeyB64)
  );
  return opened;
}

export type EncryptedEnvelope = { ciphertext: string; nonce: string };

/** Encrypts a plaintext message body with the conversation's session key. */
export function encryptMessage(plaintext: string, sessionKey: Uint8Array): EncryptedEnvelope {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(decodeUTF8(plaintext), nonce, sessionKey);
  return { ciphertext: encodeBase64(ciphertext), nonce: encodeBase64(nonce) };
}

/** Decrypts a message body previously produced by encryptMessage. Returns
 * null if the key is wrong or the ciphertext was tampered with. */
export function decryptMessage(envelope: EncryptedEnvelope, sessionKey: Uint8Array): string | null {
  const opened = nacl.secretbox.open(
    decodeBase64(envelope.ciphertext),
    decodeBase64(envelope.nonce),
    sessionKey
  );
  return opened ? encodeUTF8(opened) : null;
}

/** messages.body for an encrypted conversation holds this JSON shape. */
export function serializeEnvelope(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(body: string): EncryptedEnvelope | null {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.ciphertext === "string" && typeof parsed?.nonce === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A safety number for a conversation, in the style of Signal/WhatsApp.
 *
 * Both participants' public keys are sorted and hashed together, so both
 * devices independently derive the SAME digits. If they match when compared
 * out of band (read aloud, or over another channel), no one is sitting in
 * the middle swapping keys — which is the one attack the app was otherwise
 * completely open to, since the client trusts whatever public key the
 * server hands it.
 */
export async function computeSafetyNumber(
  publicKeyA: string,
  publicKeyB: string
): Promise<string> {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `televo-safety-number:${first}:${second}`
  );

  // 60 digits in 12 groups of 5 — same shape as Signal's safety number.
  const digits = digest
    .split("")
    .map((character) => (parseInt(character, 16) % 10).toString())
    .join("")
    .slice(0, 60);

  return (digits.match(/.{1,5}/g) ?? []).join(" ");
}

/** Encrypts raw bytes (a photo or file) with the conversation's session key.
 * Media in Secret Chats used to be uploaded in the clear despite the lock
 * icon, so the server could read every photo and document. */
export function encryptBytes(
  data: Uint8Array,
  sessionKey: Uint8Array
): { ciphertext: Uint8Array; nonce: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { ciphertext: nacl.secretbox(data, nonce, sessionKey), nonce: encodeBase64(nonce) };
}

/** Reverses encryptBytes. Returns null if the key is wrong or the data was
 * tampered with (secretbox is authenticated). */
export function decryptBytes(
  ciphertext: Uint8Array,
  nonceB64: string,
  sessionKey: Uint8Array
): Uint8Array | null {
  return nacl.secretbox.open(ciphertext, decodeBase64(nonceB64), sessionKey);
}
