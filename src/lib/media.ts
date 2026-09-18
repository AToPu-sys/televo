import { Directory, File, Paths } from "expo-file-system";

import { MissingSessionKeyError } from "../hooks/useE2ee";
import { supabase } from "./supabase";
import { randomUUID } from "./uuid";

/**
 * Storage layout is dictated by the bucket policies, not by preference:
 *
 *   chat-media/<conversation_id>/<file>  — the policy reads the first folder
 *                                          segment and checks you participate
 *   avatars/<user_id>/<file>             — the policy checks it equals auth.uid()
 *
 * Upload to any other path fails the RLS check.
 */

/** Copies a view into a standalone ArrayBuffer for the storage client. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

async function readAsArrayBuffer(uri: string) {
  // fetch() on a local file:// URI is how Expo exposes picked media; this
  // avoids pulling in a filesystem dependency just to read bytes.
  const response = await fetch(uri);
  return await response.arrayBuffer();
}

function extensionFor(uri: string, fallback: string) {
  const match = /\.([a-zA-Z0-9]+)(?:\?|$)/.exec(uri);
  return match ? match[1].toLowerCase() : fallback;
}

function contentTypeFor(extension: string) {
  switch (extension) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    default:
      return "image/jpeg";
  }
}

/** Uploads a picked image to a conversation and returns its storage path.
 *
 * `encryptor` is supplied for Secret Chats: the bytes are encrypted with the
 * conversation's session key BEFORE upload, so the server stores ciphertext
 * it cannot read. Without it, media in a "Secret Chat" was uploaded in the
 * clear while the UI showed a lock — the encryption applied to text only. */
export async function uploadChatMedia(
  conversationId: string,
  localUri: string,
  encryptor?: (data: Uint8Array) => Promise<{ ciphertext: Uint8Array; nonce: string } | null>
) {
  const extension = extensionFor(localUri, "jpg");
  const path = `${conversationId}/${randomUUID()}.${extension}`;
  const buffer = await readAsArrayBuffer(localUri);

  // Supabase's storage client wants an ArrayBuffer/Blob. Passing a bare
  // Uint8Array (which the encryption path produces) can upload as empty, so
  // ciphertext is wrapped back into its own ArrayBuffer before sending.
  let payload: ArrayBuffer = buffer;
  let nonce: string | null = null;

  if (encryptor) {
    const encrypted = await encryptor(new Uint8Array(buffer));
    if (!encrypted) {
      // Refuse rather than silently fall back to an unencrypted upload.
      throw new MissingSessionKeyError();
    }
    payload = toArrayBuffer(encrypted.ciphertext);
    nonce = encrypted.nonce;
  }

  const { error } = await supabase.storage.from("chat-media").upload(path, payload, {
    contentType: encryptor ? "application/octet-stream" : contentTypeFor(extension),
    upsert: false,
  });

  if (error) throw error;
  // The nonce is needed to decrypt and is not secret, so it rides along in
  // the stored path reference.
  return nonce ? `${path}#${nonce}` : path;
}

/**
 * Uploads any file as a document message. Reuses the chat-media bucket (its
 * RLS already scopes uploads by conversation) rather than a separate bucket,
 * since the access rule is identical; the original filename is kept in the
 * storage path so a downloaded file doesn't end up named after a UUID.
 */
export async function uploadChatDocument(
  conversationId: string,
  localUri: string,
  fileName: string,
  encryptor?: (data: Uint8Array) => Promise<{ ciphertext: Uint8Array; nonce: string } | null>
) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${conversationId}/documents/${randomUUID()}-${safeName}`;
  const buffer = await readAsArrayBuffer(localUri);

  let payload: ArrayBuffer = buffer;
  let nonce: string | null = null;

  if (encryptor) {
    const encrypted = await encryptor(new Uint8Array(buffer));
    if (!encrypted) {
      throw new MissingSessionKeyError();
    }
    payload = toArrayBuffer(encrypted.ciphertext);
    nonce = encrypted.nonce;
  }

  const { error } = await supabase.storage.from("chat-media").upload(path, payload, {
    contentType: "application/octet-stream",
    upsert: false,
  });

  if (error) throw error;
  return nonce ? `${path}#${nonce}` : path;
}

/** Splits a stored reference into its path and (optional) encryption nonce. */
export function parseMediaRef(ref: string): { path: string; nonce: string | null } {
  const hash = ref.indexOf("#");
  return hash === -1
    ? { path: ref, nonce: null }
    : { path: ref.slice(0, hash), nonce: ref.slice(hash + 1) };
}

/** Base64-encodes bytes in chunks. Building the binary string one character
 * at a time is O(n^2) in JS engines and janks the UI on a multi-MB video;
 * String.fromCharCode over a bounded slice avoids both that and the argument
 * -count limit that a single spread would hit. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** Guesses a MIME type from a stored path so decrypted bytes get a data URI
 * the platform will actually play or display. This used to be hardcoded to
 * image/jpeg, which silently broke every encrypted video and document. */
export function mimeForPath(path: string): string {
  const match = /\.([a-zA-Z0-9]+)(?:#|\?|$)/.exec(path);
  switch (match?.[1].toLowerCase()) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "pdf":
      return "application/pdf";
    default:
      return "image/jpeg";
  }
}

/** Downloads encrypted media and returns the decrypted RAW BYTES.
 *
 * Used for files that are written to disk (documents), where going through a
 * base64 data URI would just be wasted work and memory. */
export async function fetchDecryptedBytes(
  ref: string,
  decryptor: (ciphertext: Uint8Array, nonce: string) => Promise<Uint8Array | null>
): Promise<Uint8Array | null> {
  const { path, nonce } = parseMediaRef(ref);
  if (!nonce) return null;

  const { data, error } = await supabase.storage.from("chat-media").download(path);
  if (error || !data) return null;

  return await decryptor(new Uint8Array(await data.arrayBuffer()), nonce);
}

/** Downloads encrypted media and returns a data URI the app can render.
 *
 * Only safe for SMALL payloads. A `data:` URI embeds the entire file as
 * base64 text inside a single JS string handed to a native component prop —
 * a real photo from a modern iPhone camera is routinely 3-8MB, which becomes
 * a 4-10MB string. That doesn't throw or reject anything (toBase64 runs
 * fine, the promise resolves with a valid URI), so nothing here ever saw a
 * failure — but React Native's Image silently failed to decode/display a
 * URI that large, which is exactly what "Image unavailable — tap to retry"
 * looked like for every full-size photo: deterministic on every retry,
 * because the size never changes. Use fetchDecryptedMediaFile instead for
 * anything that isn't known to be small (a thumbnail, an icon). */
export async function fetchDecryptedMedia(
  ref: string,
  decryptor: (ciphertext: Uint8Array, nonce: string) => Promise<Uint8Array | null>,
  mimeType?: string
): Promise<string | null> {
  const { path, nonce } = parseMediaRef(ref);
  if (!nonce) return null;

  const { data, error } = await supabase.storage.from("chat-media").download(path);
  if (error || !data) return null;

  const plain = await decryptor(new Uint8Array(await data.arrayBuffer()), nonce);
  if (!plain) return null;

  return `data:${mimeType ?? mimeForPath(path)};base64,${toBase64(plain)}`;
}

/** Downloads encrypted media, decrypts it, and writes the plaintext to a
 * cache file, returning a `file://` URI — the fix for fetchDecryptedMedia's
 * data-URI size cliff above. A full-resolution photo or any video is
 * comfortably handled: the bytes are written to disk once, and every native
 * component (Image, expo-video's VideoView) already knows how to stream a
 * file:// URI regardless of size, the same way it handles a signed HTTPS URL
 * for non-encrypted media. */
export async function fetchDecryptedMediaFile(
  ref: string,
  decryptor: (ciphertext: Uint8Array, nonce: string) => Promise<Uint8Array | null>
): Promise<string | null> {
  const { path, nonce } = parseMediaRef(ref);
  if (!nonce) return null;

  const { data, error } = await supabase.storage.from("chat-media").download(path);
  if (error || !data) return null;

  const plain = await decryptor(new Uint8Array(await data.arrayBuffer()), nonce);
  if (!plain) return null;

  const extension = extensionFor(path, "jpg");
  const folder = new Directory(Paths.cache, "decrypted-media");
  if (!folder.exists) folder.create({ intermediates: true });
  // A fresh UUID name per call, not the storage key — the same encrypted
  // ref can be decrypted more than once (component remount, retry), and
  // reusing a name would collide with expo-file-system's own File.create.
  const target = new File(folder, `${randomUUID()}.${extension}`);
  target.create();
  target.write(plain);

  return target.uri;
}

/**
 * chat-media is a private bucket, so rendering needs a signed URL rather than a
 * public one. An hour is plenty for a message being viewed now.
 */
export async function signedChatMediaUrl(ref: string, expiresInSeconds = 3600) {
  const { path } = parseMediaRef(ref);
  const { data, error } = await supabase.storage
    .from("chat-media")
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}

/** Uploads a new avatar and returns its public URL (avatars is a public bucket). */
export async function uploadAvatar(userId: string, localUri: string) {
  const extension = extensionFor(localUri, "jpg");
  const path = `${userId}/avatar.${extension}`;
  const bytes = await readAsArrayBuffer(localUri);

  const { error } = await supabase.storage.from("avatars").upload(path, bytes, {
    contentType: contentTypeFor(extension),
    // One avatar per user, replaced in place.
    upsert: true,
  });

  if (error) throw error;

  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  // Bust caches so a replaced avatar shows immediately.
  return `${data.publicUrl}?v=${Date.now()}`;
}
