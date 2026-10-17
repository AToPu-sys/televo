import type { RealtimeChannel } from "@supabase/supabase-js";

import type { Database } from "../types/database";
import { supabase } from "./supabase";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type CallRow = Database["public"]["Tables"]["calls"]["Row"];

/**
 * The one live connection a signed-in user needs: a private Realtime
 * channel "user:<id>" that the database pushes into
 * (scripts/sql/077_realtime_user_channels.sql) — new, edited and deleted
 * messages in every chat, read receipts, membership changes and calls.
 *
 * It replaces a postgres_changes subscription per screen (the chat list
 * alone watched every message inserted anywhere), which made the Realtime
 * server poll the database and re-check RLS per subscriber per row — 69% of
 * all database time. Message rows arrive complete (storage-layer decrypted,
 * a Secret Chat body still its E2E envelope), so nothing is re-fetched.
 *
 * Screens register listeners; the channel opens with the first and closes a
 * moment after the last. Realtime has no replay, so whenever the channel
 * (re)joins after having been joined before, resync listeners run and each
 * screen refetches what it shows.
 */

export type UserEvent =
  | { type: "message_insert"; message: MessageRow }
  | { type: "message_update"; message: MessageRow }
  | { type: "message_delete"; id: string; conversation_id: string }
  | { type: "participant_update"; conversation_id: string; user_id: string; last_read_at: string | null }
  | { type: "membership"; conversation_id: string; user_id: string; op: "join" | "leave" | "update" }
  | { type: "call_insert"; call: CallRow }
  | { type: "call_update"; call: CallRow };

type Listener = (event: UserEvent) => void;

const EVENTS = [
  "message_insert",
  "message_update",
  "message_delete",
  "participant_update",
  "membership",
  "call_insert",
  "call_update",
] as const;

const CLOSE_DELAY_MS = 3000;
const MAX_RETRY_MS = 15_000;

const listeners = new Set<Listener>();
const resyncListeners = new Set<() => void>();
let channel: RealtimeChannel | null = null;
let channelUserId: string | null = null;
let joinedBefore = false;
let retryMs = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function toEvent(event: (typeof EVENTS)[number], payload: Record<string, unknown>): UserEvent | null {
  switch (event) {
    case "message_insert":
    case "message_update":
      return { type: event, message: payload as unknown as MessageRow };
    case "call_insert":
    case "call_update":
      return { type: event, call: payload as unknown as CallRow };
    case "message_delete":
      return { type: event, id: String(payload.id), conversation_id: String(payload.conversation_id) };
    case "participant_update":
      return {
        type: event,
        conversation_id: String(payload.conversation_id),
        user_id: String(payload.user_id),
        last_read_at: (payload.last_read_at as string | null) ?? null,
      };
    case "membership":
      return {
        type: event,
        conversation_id: String(payload.conversation_id),
        user_id: String(payload.user_id),
        op: (payload.op as "join" | "leave" | "update") ?? "update",
      };
  }
}

function dispatch(event: UserEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[userChannel] listener failed", error);
    }
  }
}

function resync() {
  for (const listener of resyncListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[userChannel] resync listener failed", error);
    }
  }
}

function open(userId: string) {
  channelUserId = userId;
  // private: the join is checked against the realtime.messages policy, so
  // only this user can listen on this topic.
  let next = supabase.channel(`user:${userId}`, { config: { private: true } });
  for (const name of EVENTS) {
    next = next.on("broadcast", { event: name }, (message) => {
      const event = toEvent(name, (message.payload ?? {}) as Record<string, unknown>);
      if (event) dispatch(event);
    });
  }
  channel = next;
  next.subscribe((status) => {
    if (channel !== next) return;
    if (status === "SUBSCRIBED") {
      retryMs = 0;
      if (joinedBefore) resync();
      joinedBefore = true;
      return;
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      // Typically a join attempted before the restored session's token
      // reached the Realtime socket (cold launch). Rebuild after a short,
      // growing pause; the eventual SUBSCRIBED triggers a resync.
      joinedBefore = true;
      scheduleReopen();
    }
  });
}

function scheduleReopen() {
  if (retryTimer || !channelUserId) return;
  retryMs = Math.min(MAX_RETRY_MS, Math.max(800, retryMs * 2));
  const userId = channelUserId;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!channel || channelUserId !== userId) return;
    const stale = channel;
    channel = null;
    void supabase.removeChannel(stale);
    open(userId);
  }, retryMs);
}

function close() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  channelUserId = null;
  joinedBefore = false;
  retryMs = 0;
}

function ensure(userId: string) {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (channelUserId === userId && channel) return;
  close();
  open(userId);
}

function release() {
  if (listeners.size > 0 || resyncListeners.size > 0 || closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (listeners.size === 0 && resyncListeners.size === 0) close();
  }, CLOSE_DELAY_MS);
}

/** Live events for the signed-in user. Returns an unsubscribe function. */
export function subscribeUserEvents(userId: string, listener: Listener): () => void {
  listeners.add(listener);
  ensure(userId);
  return () => {
    listeners.delete(listener);
    release();
  };
}

/** Runs after the channel rejoins following a drop — time to refetch,
 * since anything sent meanwhile was not delivered. */
export function onUserChannelResync(userId: string, listener: () => void): () => void {
  resyncListeners.add(listener);
  ensure(userId);
  return () => {
    resyncListeners.delete(listener);
    release();
  };
}
