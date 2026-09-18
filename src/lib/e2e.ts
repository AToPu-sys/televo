import "react-native-get-random-values";

import { MlKem768 } from "crystals-kyber-js";
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
const KYBER_PRIVATE_KEY_STORE_KEY = "televo.e2e.kyber-private-key";
const KYBER_PUBLIC_KEY_STORE_KEY = "televo.e2e.kyber-public-key";
const TRUSTED_KEY_PREFIX = "televo.e2e.trusted-peer-key.";

/**
 * Remembers the peer public key this device last saw for a conversation, so
 * a later change (peer reinstalled, switched devices, or a MITM swapped the
 * key server-side) can be detected instead of silently taking effect. Keyed
 * locally per device — deliberately not synced anywhere, the same way Signal
 * and WhatsApp keep "safety number changed" state on-device only.
 */
export async function getTrustedPeerKey(conversationId: string): Promise<string | null> {
  return SecureStore.getItemAsync(TRUSTED_KEY_PREFIX + conversationId);
}

export async function setTrustedPeerKey(conversationId: string, publicKey: string): Promise<void> {
  await SecureStore.setItemAsync(TRUSTED_KEY_PREFIX + conversationId, publicKey);
}

const VERIFIED_KEY_PREFIX = "televo.e2e.verified-peer-key.";

/**
 * Marks the CURRENT peer key for a conversation as explicitly verified —
 * the user compared safety numbers out of band and confirmed they match.
 * This is a stronger, distinct signal from getTrustedPeerKey/TOFU above:
 * TOFU only means "the key hasn't silently changed since we first saw it,"
 * which happens automatically with no user action; this means a human
 * actively ruled out a man-in-the-middle for this specific key. Stored
 * against the key itself (not just the conversation) so a later key change
 * — which TOFU already flags via peerKeyChanged — correctly drops back to
 * unverified rather than carrying old trust forward onto a new key.
 */
export async function isPeerKeyVerified(conversationId: string, publicKey: string): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(VERIFIED_KEY_PREFIX + conversationId);
  return stored === publicKey;
}

export async function setPeerKeyVerified(conversationId: string, publicKey: string): Promise<void> {
  await SecureStore.setItemAsync(VERIFIED_KEY_PREFIX + conversationId, publicKey);
}

export type KeyPair = {
  publicKey: string;
  secretKey: string;
  /** ML-KEM-768 (FIPS 203) public key, base64. Absent only if this device's
   * keypair was created before the post-quantum upgrade and hasn't been
   * topped up yet — getOrCreateDeviceKeyPair backfills it on next launch. */
  kyberPublicKey: string;
  kyberSecretKey: string;
};

/** Loads this device's keypair, generating and persisting one on first use.
 * Also backfills the ML-KEM-768 half onto a device that only has the
 * original X25519 keypair from before the post-quantum upgrade — same
 * identity, the hybrid layer is simply added rather than the device treated
 * as new. */
export async function getOrCreateDeviceKeyPair(): Promise<KeyPair> {
  const [storedSecret, storedPublic, storedKyberSecret, storedKyberPublic] = await Promise.all([
    SecureStore.getItemAsync(PRIVATE_KEY_STORE_KEY),
    SecureStore.getItemAsync(PUBLIC_KEY_STORE_KEY),
    SecureStore.getItemAsync(KYBER_PRIVATE_KEY_STORE_KEY),
    SecureStore.getItemAsync(KYBER_PUBLIC_KEY_STORE_KEY),
  ]);

  let publicKey = storedPublic;
  let secretKey = storedSecret;
  if (!publicKey || !secretKey) {
    const pair = nacl.box.keyPair();
    publicKey = encodeBase64(pair.publicKey);
    secretKey = encodeBase64(pair.secretKey);
    await Promise.all([
      SecureStore.setItemAsync(PRIVATE_KEY_STORE_KEY, secretKey),
      SecureStore.setItemAsync(PUBLIC_KEY_STORE_KEY, publicKey),
    ]);
  }

  let kyberPublicKey = storedKyberPublic;
  let kyberSecretKey = storedKyberSecret;
  if (!kyberPublicKey || !kyberSecretKey) {
    const kem = new MlKem768();
    const [pk, sk] = await kem.generateKeyPair();
    kyberPublicKey = encodeBase64(pk);
    kyberSecretKey = encodeBase64(sk);
    await Promise.all([
      SecureStore.setItemAsync(KYBER_PRIVATE_KEY_STORE_KEY, kyberSecretKey),
      SecureStore.setItemAsync(KYBER_PUBLIC_KEY_STORE_KEY, kyberPublicKey),
    ]);
  }

  return { publicKey, secretKey, kyberPublicKey, kyberSecretKey };
}

/** Generates a fresh random 32-byte session key for one conversation. */
export function generateSessionKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

/**
 * Combines the X25519 shared secret and the ML-KEM shared secret into one
 * 32-byte key with SHA-512 (truncated), rather than using either secret
 * alone. This is the actual point of a hybrid scheme: an attacker has to
 * recover BOTH inputs to this hash to recover the output, so breaking one
 * exchange (say X25519, via a future large quantum computer) is not enough
 * on its own. Order-dependent by construction — both sides must concatenate
 * the two secrets the same way, which wrapSessionKey/unwrapSessionKey below
 * both do.
 */
function combineSharedSecrets(x25519Secret: Uint8Array, kemSecret: Uint8Array): Uint8Array {
  const combined = new Uint8Array(x25519Secret.length + kemSecret.length);
  combined.set(x25519Secret, 0);
  combined.set(kemSecret, x25519Secret.length);
  return nacl.hash(combined).slice(0, nacl.secretbox.keyLength);
}

export type WrappedSessionKey = {
  encryptedKey: string;
  nonce: string;
  /** ML-KEM ciphertext encapsulating this wrap's contribution to the shared
   * secret. Recipient-specific and one-time — a fresh encapsulation is run
   * per wrap, the KEM equivalent of nacl.box's per-call nonce. Absent only
   * when the recipient has no ML-KEM public key on file yet (pre-upgrade
   * profile), in which case this wrap is X25519-only, same as before. */
  kemCiphertext: string | null;
};

/**
 * Wraps a session key to a recipient, deriving the wrapping key from BOTH
 * an X25519 exchange (nacl.box's usual DH) and a fresh ML-KEM-768
 * encapsulation to the recipient's Kyber public key — see
 * combineSharedSecrets. Falls back to X25519-only if the recipient has no
 * Kyber key yet, so a not-yet-upgraded peer's chat still works.
 */
export async function wrapSessionKey(
  sessionKey: Uint8Array,
  recipientPublicKeyB64: string,
  senderSecretKeyB64: string,
  recipientKyberPublicKeyB64?: string | null
): Promise<WrappedSessionKey> {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

  if (!recipientKyberPublicKeyB64) {
    const boxed = nacl.box(
      sessionKey,
      nonce,
      decodeBase64(recipientPublicKeyB64),
      decodeBase64(senderSecretKeyB64)
    );
    return { encryptedKey: encodeBase64(boxed), nonce: encodeBase64(nonce), kemCiphertext: null };
  }

  // nacl.box's own shared secret (X25519 DH + HSalsa20), computed the same
  // way nacl.box() derives it internally, but exposed here so it can be
  // combined with the KEM secret instead of used to seal directly.
  const x25519Secret = nacl.box.before(
    decodeBase64(recipientPublicKeyB64),
    decodeBase64(senderSecretKeyB64)
  );

  const kem = new MlKem768();
  const [kemCiphertext, kemSecret] = await kem.encap(decodeBase64(recipientKyberPublicKeyB64));

  const wrappingKey = combineSharedSecrets(x25519Secret, kemSecret);
  const sealed = nacl.secretbox(sessionKey, nonce, wrappingKey);

  return {
    encryptedKey: encodeBase64(sealed),
    nonce: encodeBase64(nonce),
    kemCiphertext: encodeBase64(kemCiphertext),
  };
}

/** Unwraps a session key wrapped by wrapSessionKey. Mirrors its branch on
 * whether a KEM ciphertext is present. */
export async function unwrapSessionKey(
  encryptedKeyB64: string,
  nonceB64: string,
  senderPublicKeyB64: string,
  recipientSecretKeyB64: string,
  kemCiphertextB64?: string | null,
  recipientKyberSecretKeyB64?: string | null
): Promise<Uint8Array | null> {
  if (!kemCiphertextB64 || !recipientKyberSecretKeyB64) {
    return nacl.box.open(
      decodeBase64(encryptedKeyB64),
      decodeBase64(nonceB64),
      decodeBase64(senderPublicKeyB64),
      decodeBase64(recipientSecretKeyB64)
    );
  }

  const x25519Secret = nacl.box.before(
    decodeBase64(senderPublicKeyB64),
    decodeBase64(recipientSecretKeyB64)
  );

  const kem = new MlKem768();
  const kemSecret = await kem.decap(
    decodeBase64(kemCiphertextB64),
    decodeBase64(recipientKyberSecretKeyB64)
  );

  const wrappingKey = combineSharedSecrets(x25519Secret, kemSecret);
  return nacl.secretbox.open(decodeBase64(encryptedKeyB64), decodeBase64(nonceB64), wrappingKey);
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

export type SignalEnvelope = {
  box: string;
  nonce: string;
  /** Present only on the message that carries a fresh ML-KEM encapsulation
   * for this call (the caller's first signal to a peer with a Kyber key on
   * file). One per call, not per message — see generateCallKemSecret. */
  kemCiphertext?: string;
};

/**
 * Runs ONE ML-KEM-768 encapsulation for an entire call, rather than per
 * signaling message (an offer/answer/ICE-candidate exchange can be dozens of
 * messages, and re-running a KEM on each would add real latency to call
 * setup, which is exactly what was slow before it got fixed). The caller
 * calls this once, attaches the ciphertext to its first encrypted signal,
 * and reuses the returned secret to encrypt every later message in the
 * call. The callee decapsulates once (decapCallKemSecret) on that first
 * message and reuses the result the same way.
 */
export async function generateCallKemSecret(
  peerKyberPublicKeyB64: string
): Promise<{ ciphertext: string; secret: Uint8Array }> {
  const kem = new MlKem768();
  const [ciphertext, secret] = await kem.encap(decodeBase64(peerKyberPublicKeyB64));
  return { ciphertext: encodeBase64(ciphertext), secret };
}

/** Callee's side of generateCallKemSecret: recovers the same per-call secret
 * from the ciphertext the caller attached to its first signal. */
export async function decapCallKemSecret(
  ciphertextB64: string,
  ownKyberSecretKeyB64: string
): Promise<Uint8Array> {
  const kem = new MlKem768();
  return kem.decap(decodeBase64(ciphertextB64), decodeBase64(ownKyberSecretKeyB64));
}

/**
 * Encrypts one call-signaling message (an SDP offer/answer or an ICE
 * candidate) to the other party. Hybrid when a per-call KEM secret is
 * available: the X25519 DH shared secret (nacl.box's usual key agreement,
 * same as chat session keys use) is combined with it via the same
 * SHA-512-based combiner chat encryption uses, so breaking this also
 * requires breaking both primitives at once. Falls back to X25519-only
 * nacl.box when no call-level secret has been established yet (this
 * device's peer has no Kyber key on file), so a not-yet-upgraded peer can
 * still receive calls.
 *
 * This exists because SDP and ICE candidates carry real network information
 * — including each device's actual IP addresses via ICE candidates — and
 * were previously sent as plain JSON over the Realtime broadcast channel,
 * readable by Supabase and by anyone who could observe that channel. The
 * call's audio/video is already encrypted in transit by WebRTC itself
 * (DTLS-SRTP, mandatory in the protocol); this closes the one part of a call
 * that wasn't already protected.
 */
export function encryptSignal(
  payload: unknown,
  recipientPublicKeyB64: string,
  senderSecretKeyB64: string,
  callKemSecret?: Uint8Array | null,
  attachKemCiphertext?: string
): SignalEnvelope {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = decodeUTF8(JSON.stringify(payload));

  if (!callKemSecret) {
    const boxed = nacl.box(
      plaintext,
      nonce,
      decodeBase64(recipientPublicKeyB64),
      decodeBase64(senderSecretKeyB64)
    );
    return { box: encodeBase64(boxed), nonce: encodeBase64(nonce) };
  }

  const x25519Secret = nacl.box.before(
    decodeBase64(recipientPublicKeyB64),
    decodeBase64(senderSecretKeyB64)
  );
  const key = combineSharedSecrets(x25519Secret, callKemSecret);
  const boxed = nacl.secretbox(plaintext, nonce, key);
  return {
    box: encodeBase64(boxed),
    nonce: encodeBase64(nonce),
    kemCiphertext: attachKemCiphertext,
  };
}

/** Reverses encryptSignal. Returns null if the key is wrong, the sender's
 * public key doesn't match, or the envelope was tampered with. */
export function decryptSignal<T = unknown>(
  envelope: SignalEnvelope,
  senderPublicKeyB64: string,
  recipientSecretKeyB64: string,
  callKemSecret?: Uint8Array | null
): T | null {
  const opened = callKemSecret
    ? nacl.secretbox.open(
        decodeBase64(envelope.box),
        decodeBase64(envelope.nonce),
        combineSharedSecrets(
          nacl.box.before(decodeBase64(senderPublicKeyB64), decodeBase64(recipientSecretKeyB64)),
          callKemSecret
        )
      )
    : nacl.box.open(
        decodeBase64(envelope.box),
        decodeBase64(envelope.nonce),
        decodeBase64(senderPublicKeyB64),
        decodeBase64(recipientSecretKeyB64)
      );
  if (!opened) return null;
  try {
    return JSON.parse(encodeUTF8(opened)) as T;
  } catch {
    return null;
  }
}
