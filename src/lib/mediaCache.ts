import { Directory, File, Paths } from "expo-file-system";

import { parseMediaRef, signedChatMediaUrl } from "./media";
import { supabase } from "./supabase";

// Persistent on-device cache for chat photos, videos and files.
//
// Keyed by the media's storage path, so a file is downloaded (and, for Secret
// Chat media, decrypted) once and then served from disk every time the chat is
// reopened or the list scrolls back to it. Before this, every bubble mount
// requested a fresh signed URL and re-downloaded the whole file, and encrypted
// media was re-decrypted into a NEW randomly-named file each time, so the old
// cache folder grew with duplicates forever.
//
// Lives in Paths.cache (Library/Caches on iOS): excluded from iCloud backup,
// which Apple requires for re-downloadable content, and the OS may purge it
// under storage pressure — that is fine, a missing file is simply downloaded
// again. "Clear cache" in Settings → Storage empties it; messages themselves
// are not stored here and are never affected.

type Decryptor = (ciphertext: Uint8Array, nonce: string) => Promise<Uint8Array | null>;

const CACHE_DIR_NAME = "media";
// Written by the old fetchDecryptedMediaFile (random names, never reused).
const LEGACY_DIR_NAMES = ["decrypted-media"];

const inFlight = new Map<string, Promise<string | null>>();

function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, CACHE_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function keyFor(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Returns a file:// URI for the media, downloading (and decrypting, when
 * `decryptor` is given and the ref carries a nonce) only if it isn't already
 * cached. Resolves to null when the media can't be fetched or decrypted. */
export function cachedMediaUri(ref: string, decryptor?: Decryptor): Promise<string | null> {
  const { path, nonce } = parseMediaRef(ref);
  const key = keyFor(path);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const job = (async () => {
    const dir = cacheDir();
    const final = new File(dir, key);
    if (final.exists && final.size > 0) return final.uri;

    // Download into a .part file and only rename once complete, so an
    // interrupted download is never mistaken for a cached file.
    const part = new File(dir, `${key}.part`);
    if (part.exists) part.delete();

    if (nonce) {
      if (!decryptor) return null;
      const { data, error } = await supabase.storage.from("chat-media").download(path);
      if (error || !data) return null;
      const plain = await decryptor(new Uint8Array(await data.arrayBuffer()), nonce);
      if (!plain) return null;
      part.create();
      part.write(plain);
    } else {
      const url = await signedChatMediaUrl(path);
      await File.downloadFileAsync(url, part, { idempotent: true });
    }

    if (final.exists) final.delete();
    part.move(final);
    return final.uri;
  })()
    .catch(() => null)
    .finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/** Seeds the cache with a file this device already has (a voice note it just
 * recorded, say), so it is never downloaded back from the server. */
export function primeMediaCache(ref: string, localUri: string): void {
  try {
    const { path } = parseMediaRef(ref);
    const final = new File(cacheDir(), keyFor(path));
    if (final.exists) return;
    new File(localUri).copy(final);
  } catch {
    // Best-effort: worst case the file is downloaded once later.
  }
}

/** Total bytes used by cached media, including leftovers from the old cache. */
export function mediaCacheSize(): number {
  let total = 0;
  for (const name of [CACHE_DIR_NAME, ...LEGACY_DIR_NAMES]) {
    const dir = new Directory(Paths.cache, name);
    if (dir.exists) total += dir.size ?? 0;
  }
  return total;
}

/** Deletes every cached photo, video and file. Messages are untouched; any
 * media still shown in a chat is downloaded again the next time it's opened. */
export function clearMediaCache(): void {
  for (const name of [CACHE_DIR_NAME, ...LEGACY_DIR_NAMES]) {
    const dir = new Directory(Paths.cache, name);
    if (dir.exists) dir.delete();
  }
}
