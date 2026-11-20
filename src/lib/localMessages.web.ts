import type { Database } from "../types/database";

// Web build of localMessages.ts. The browser keeps nothing on disk: on a
// shared or borrowed computer, chats must not outlive the tab. The cache and
// outbox live in memory for the current session only and vanish on reload or
// sign-out; the server stays the source of truth, exactly as on the phone.

export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

let boundUser: string | null = null;
const messages = new Map<string, MessageRow>();
const outbox = new Map<string, { senderId: string; createdAt: string; entry: string }>();
const chatList = new Map<string, string>();

export async function bindLocalMessagesToUser(userId: string): Promise<void> {
  if (boundUser !== userId) {
    messages.clear();
    outbox.clear();
    chatList.clear();
    boundUser = userId;
  }
}

export async function readLocalMessages(
  conversationId: string,
  limit: number,
  olderThan?: string
): Promise<MessageRow[]> {
  return [...messages.values()]
    .filter((m) => m.conversation_id === conversationId && (!olderThan || m.created_at < olderThan))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}

export async function upsertLocalMessages(rows: MessageRow[]): Promise<void> {
  for (const row of rows) messages.set(row.id, row);
}

export async function deleteLocalMessages(ids: string[]): Promise<void> {
  for (const id of ids) messages.delete(id);
}

export async function reconcileLocalWindow(
  conversationId: string,
  serverRows: MessageRow[],
  windowStart: string | null,
  windowEnd: string | null
): Promise<void> {
  const keep = new Set(serverRows.map((r) => r.id));
  for (const [id, m] of messages) {
    if (m.conversation_id !== conversationId) continue;
    const inWindow = (!windowStart || m.created_at >= windowStart) && (!windowEnd || m.created_at <= windowEnd);
    if (inWindow && !keep.has(id)) messages.delete(id);
  }
  await upsertLocalMessages(serverRows);
}

export async function wipeLocalMessages(): Promise<void> {
  messages.clear();
  outbox.clear();
  chatList.clear();
  boundUser = null;
}

export async function readOutboxRows(senderId: string): Promise<string[]> {
  return [...outbox.values()]
    .filter((o) => o.senderId === senderId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((o) => o.entry);
}

export async function saveOutboxRow(id: string, senderId: string, createdAt: string, entry: string): Promise<void> {
  outbox.set(id, { senderId, createdAt, entry });
}

export async function deleteOutboxRow(id: string): Promise<void> {
  outbox.delete(id);
}

export async function readChatListCache(userId: string): Promise<string | null> {
  return chatList.get(userId) ?? null;
}

export async function writeChatListCache(userId: string, json: string): Promise<void> {
  chatList.set(userId, json);
}
