import * as SQLite from "expo-sqlite";

import type { Database } from "../types/database";

// On-device copy of chat messages, so a chat opens instantly (and works with
// no connection) instead of waiting for the server on every visit.
//
// The server stays the source of truth: rows are stored exactly as the server
// returned them — Secret Chat bodies remain ciphertext envelopes and are
// decrypted at render time like before, so nothing readable is added to disk.
// Only server-confirmed rows are written (never optimistic ones). Clearing the
// media cache in Settings never touches this database; signing out wipes it,
// so the next account on the same phone can't read the previous one's chats.

export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

const DB_NAME = "televo-messages.db";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const handle = await SQLite.openDatabaseAsync(DB_NAME);
      await handle.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          row TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_conv_created
          ON messages (conversation_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT);
      `);
      return handle;
    })().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function isExpired(row: MessageRow, now: number): boolean {
  return !!row.expires_at && new Date(row.expires_at).getTime() <= now;
}

/** Binds the cache to one account. If a different account's data is found
 * (sign-out wipe skipped by a crash, say), it is erased before use. */
export async function bindLocalMessagesToUser(userId: string): Promise<void> {
  const handle = await db();
  const owner = await handle.getFirstAsync<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'owner'"
  );
  if (owner && owner.value !== userId) {
    await handle.execAsync("DELETE FROM messages;");
  }
  await handle.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES ('owner', ?)", userId);
}

/** Newest-first page of cached messages, optionally older than a timestamp.
 * Expired self-destruct messages are dropped on the way out. */
export async function readLocalMessages(
  conversationId: string,
  limit: number,
  olderThan?: string
): Promise<MessageRow[]> {
  const handle = await db();
  const rows = olderThan
    ? await handle.getAllAsync<{ row: string }>(
        "SELECT row FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?",
        conversationId,
        olderThan,
        limit
      )
    : await handle.getAllAsync<{ row: string }>(
        "SELECT row FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
        conversationId,
        limit
      );
  const now = Date.now();
  const parsed = rows.map((r) => JSON.parse(r.row) as MessageRow);
  const expired = parsed.filter((row) => isExpired(row, now));
  if (expired.length > 0) void deleteLocalMessages(expired.map((row) => row.id));
  return parsed.filter((row) => !isExpired(row, now));
}

export async function upsertLocalMessages(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const handle = await db();
  await handle.withTransactionAsync(async () => {
    for (const row of rows) {
      await handle.runAsync(
        "INSERT OR REPLACE INTO messages (id, conversation_id, created_at, row) VALUES (?, ?, ?, ?)",
        row.id,
        row.conversation_id,
        row.created_at,
        JSON.stringify(row)
      );
    }
  });
}

export async function deleteLocalMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const handle = await db();
  await handle.withTransactionAsync(async () => {
    for (const id of ids) {
      await handle.runAsync("DELETE FROM messages WHERE id = ?", id);
    }
  });
}

/** Makes the cache agree with one server page: everything the server returned
 * is stored, and any cached message inside the same time window that the
 * server no longer has (deleted while this device wasn't listening) is removed.
 * `windowStart` is the oldest created_at the server page covers; pass null
 * when the server returned the complete history (fewer rows than the limit). */
export async function reconcileLocalWindow(
  conversationId: string,
  serverRows: MessageRow[],
  windowStart: string | null,
  windowEnd: string | null,
  endInclusive = false
): Promise<void> {
  const handle = await db();
  const keep = new Set(serverRows.map((row) => row.id));
  const cached = await handle.getAllAsync<{ id: string }>(
    windowEnd
      ? `SELECT id FROM messages WHERE conversation_id = ? AND created_at >= ? AND created_at ${endInclusive ? "<=" : "<"} ?`
      : "SELECT id FROM messages WHERE conversation_id = ? AND created_at >= ?",
    ...(windowEnd
      ? [conversationId, windowStart ?? "", windowEnd]
      : [conversationId, windowStart ?? ""])
  );
  await deleteLocalMessages(cached.map((r) => r.id).filter((id) => !keep.has(id)));
  await upsertLocalMessages(serverRows);
}

/** Erases every cached message (sign-out, account deletion). */
export async function wipeLocalMessages(): Promise<void> {
  const handle = await db();
  await handle.execAsync("DELETE FROM messages; DELETE FROM meta;");
}
