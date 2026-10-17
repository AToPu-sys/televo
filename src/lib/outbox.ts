import { AppState } from "react-native";

import { deleteOutboxRow, readOutboxRows, saveOutboxRow } from "./localMessages";
import { supabase } from "./supabase";

/**
 * Text messages on their way to the server — the same idea as Telegram's
 * send queue.
 *
 * Every message gets its id on the phone, before the first attempt. That
 * makes sending idempotent: if a request reached the server but its answer
 * was lost (tunnel, Wi-Fi handover), the retry hits the primary key and is
 * recognised as already sent instead of posting a duplicate. It also lets
 * the realtime echo replace exactly its own bubble.
 *
 * A send that fails for a passing reason (no connection, server busy,
 * session refreshing) stays queued with the clock icon and is retried with
 * backoff, when the app returns to the foreground, and when realtime
 * reconnects. Only a real rejection (blocked, not a participant, the reply
 * target deleted) turns the bubble red, and a tap queues it again. Entries
 * are kept in SQLite, so they survive leaving the chat or the app being
 * killed; for a Secret Chat the stored body is the E2E envelope — the
 * plaintext is never written to disk. Sends go out one at a time, oldest
 * first, so a chat never receives them out of order.
 */

export type OutboxEntry = {
  /** The message's own id, chosen on the device. */
  id: string;
  conversationId: string;
  senderId: string;
  /** Exactly what goes into messages.body: plaintext, or for a Secret Chat
   * the serialized E2E envelope. */
  body: string;
  replyToId: string | null;
  /** Applied when the message actually lands, so a message queued offline
   * for an hour doesn't arrive already expired. */
  selfDestructSeconds: number | null;
  createdAt: string;
};

export type OutboxStatus = "queued" | "sending" | "sent" | "failed";
type Listener = (entry: OutboxEntry, status: OutboxStatus) => void;

const MAX_BACKOFF_MS = 30_000;

const entries = new Map<string, OutboxEntry>(); // insertion order = send order
const failed = new Set<string>();
// Deleted by the user while a request was already in flight: if it lands
// anyway, it is removed from the server straight after.
const cancelled = new Set<string>();
const listeners = new Set<Listener>();
// One load per account; concurrent callers (chat list and a chat opened
// right at launch) share it, so neither reads the queue half-restored.
const restoring = new Map<string, Promise<void>>();
let flushing = false;
let flushRequested = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 0;

AppState.addEventListener("change", (state) => {
  if (state === "active") void flushOutbox();
});

function emit(entry: OutboxEntry, status: OutboxStatus) {
  for (const listener of listeners) {
    try {
      listener(entry, status);
    } catch {
      // a listener's bug must not stall the queue
    }
  }
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Unsent messages for one chat, oldest first, with whether each is failed. */
export function outboxEntriesFor(conversationId: string): { entry: OutboxEntry; failed: boolean }[] {
  return [...entries.values()]
    .filter((entry) => entry.conversationId === conversationId)
    .map((entry) => ({ entry, failed: failed.has(entry.id) }));
}

export function isInOutbox(id: string): boolean {
  return entries.has(id);
}

export function enqueueOutbox(entry: OutboxEntry): void {
  entries.set(entry.id, entry);
  void saveOutboxRow(entry.id, entry.senderId, entry.createdAt, JSON.stringify(entry)).catch(() => {});
  emit(entry, "queued");
  void flushOutbox();
}

/** Puts a failed message back in the queue (tap on a red bubble). */
export function retryOutboxEntry(id: string): boolean {
  const entry = entries.get(id);
  if (!entry) return false;
  failed.delete(id);
  backoffMs = 0;
  emit(entry, "queued");
  void flushOutbox();
  return true;
}

/** The user deleted a message that hasn't been confirmed yet. */
export function cancelOutboxEntry(id: string): void {
  if (!entries.has(id)) return;
  entries.delete(id);
  failed.delete(id);
  cancelled.add(id);
  void deleteOutboxRow(id).catch(() => {});
}

/** Loads this account's unsent messages from disk (after an app restart)
 * and starts sending them. Safe to call repeatedly. */
export function restoreOutbox(userId: string): Promise<void> {
  let pending = restoring.get(userId);
  if (!pending) {
    pending = (async () => {
      try {
        for (const raw of await readOutboxRows(userId)) {
          const entry = JSON.parse(raw) as OutboxEntry;
          if (!entries.has(entry.id)) entries.set(entry.id, entry);
        }
      } catch {
        restoring.delete(userId);
        return;
      }
      void flushOutbox();
    })();
    restoring.set(userId, pending);
  }
  return pending;
}

/** Forgets everything in memory (sign-out; the table is wiped with the
 * message cache). */
export function clearOutbox(): void {
  entries.clear();
  failed.clear();
  cancelled.clear();
  restoring.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  backoffMs = 0;
}

type DeliveryResult = "sent" | "retry" | "fatal";

function isTransient(status: number, code: string | undefined): boolean {
  // status 0: the request never got an HTTP answer (offline, DNS, timeout).
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return true;
  // Expired access token mid-refresh: supabase-js refreshes it, then this
  // goes through.
  if (status === 401 || code === "PGRST301" || code === "PGRST303") return true;
  return false;
}

async function deliver(entry: OutboxEntry): Promise<DeliveryResult> {
  const expiresAt = entry.selfDestructSeconds
    ? new Date(Date.now() + entry.selfDestructSeconds * 1000).toISOString()
    : null;
  const { error, status } = await supabase.from("messages").insert({
    id: entry.id,
    conversation_id: entry.conversationId,
    sender_id: entry.senderId,
    kind: "text",
    body: entry.body,
    reply_to_id: entry.replyToId,
    expires_at: expiresAt,
  });
  if (!error) return "sent";
  // unique_violation on our own id: an earlier attempt already landed and
  // only its answer was lost.
  if (error.code === "23505") return "sent";
  if (isTransient(status, error.code)) return "retry";
  console.error("[outbox] message rejected:", error.code, error.message, { conversationId: entry.conversationId });
  return "fatal";
}

function scheduleRetry() {
  if (retryTimer) return;
  backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(1000, backoffMs * 2));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushOutbox();
  }, backoffMs);
}

/** Tries everything queued, oldest first. Also the hook for "the network is
 * probably back" signals (realtime reconnected, app foregrounded). */
export async function flushOutbox(): Promise<void> {
  if (flushing) {
    flushRequested = true;
    return;
  }
  flushing = true;
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) return;

    for (const entry of [...entries.values()]) {
      if (failed.has(entry.id) || entry.senderId !== userId || !entries.has(entry.id)) continue;
      emit(entry, "sending");
      const result: DeliveryResult = await deliver(entry).catch(() => "retry" as const);

      if (cancelled.has(entry.id)) {
        cancelled.delete(entry.id);
        if (result === "sent") void supabase.from("messages").delete().eq("id", entry.id);
        continue;
      }
      if (result === "sent") {
        entries.delete(entry.id);
        void deleteOutboxRow(entry.id).catch(() => {});
        backoffMs = 0;
        emit(entry, "sent");
        continue;
      }
      if (result === "fatal") {
        failed.add(entry.id);
        emit(entry, "failed");
        continue;
      }
      // Passing failure: stop here so nothing behind it overtakes it.
      emit(entry, "queued");
      scheduleRetry();
      return;
    }
  } finally {
    flushing = false;
    if (flushRequested) {
      flushRequested = false;
      void flushOutbox();
    }
  }
}
