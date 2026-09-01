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

/** Uploads a picked image to a conversation and returns its storage path. */
export async function uploadChatMedia(conversationId: string, localUri: string) {
  const extension = extensionFor(localUri, "jpg");
  const path = `${conversationId}/${randomUUID()}.${extension}`;
  const bytes = await readAsArrayBuffer(localUri);

  const { error } = await supabase.storage.from("chat-media").upload(path, bytes, {
    contentType: contentTypeFor(extension),
    upsert: false,
  });

  if (error) throw error;
  return path;
}

/**
 * chat-media is a private bucket, so rendering needs a signed URL rather than a
 * public one. An hour is plenty for a message being viewed now.
 */
export async function signedChatMediaUrl(path: string, expiresInSeconds = 3600) {
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
