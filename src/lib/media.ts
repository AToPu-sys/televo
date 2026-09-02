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
      throw new Error("This Secret Chat has no encryption key yet, so the file wasn't sent.");
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
      throw new Error("This Secret Chat has no encryption key yet, so the file wasn't sent.");
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

/** Downloads encrypted media and returns a data URI the app can render. */
export async function fetchDecryptedMedia(
  ref: string,
  decryptor: (ciphertext: Uint8Array, nonce: string) => Promise<Uint8Array | null>
): Promise<string | null> {
  const { path, nonce } = parseMediaRef(ref);
  if (!nonce) return null;

  const { data, error } = await supabase.storage.from("chat-media").download(path);
  if (error || !data) return null;

  const plain = await decryptor(new Uint8Array(await data.arrayBuffer()), nonce);
  if (!plain) return null;

  let binary = "";
  for (let index = 0; index < plain.length; index += 1) {
    binary += String.fromCharCode(plain[index]);
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
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
