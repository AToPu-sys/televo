// Shared test doubles for useCall.test.ts. Kept in its own file (not inline
// in the test) so the fake channel's subscribe/send timing — the trickiest
// part to get right, since sendSignalAndWait polls channelReadyRef — is
// documented and reusable rather than copy-pasted per test.
import type { Database } from "../../types/database";

type CallRow = Database["public"]["Tables"]["calls"]["Row"];

/** A minimal stand-in for the object supabase.channel(...) returns. Mirrors
 * exactly the subset of the real PostgREST/Realtime channel API useCall.ts
 * actually calls: .on(), .subscribe(), .send(). subscribe()'s callback is
 * invoked asynchronously (setTimeout 0), matching the real client's own
 * async join — useCall's sendSignalAndWait specifically polls
 * channelReadyRef waiting for this, so a synchronous callback here would
 * hide bugs in that polling path instead of exercising it. */
export function createFakeChannel() {
  type BroadcastHandler = (msg: { payload: unknown }) => void;
  let broadcastHandler: BroadcastHandler | null = null;
  const sent: unknown[] = [];

  const channel = {
    on(_type: "broadcast", _filter: { event: string }, handler: BroadcastHandler) {
      broadcastHandler = handler;
      return channel;
    },
    subscribe(callback?: (status: string) => void) {
      setTimeout(() => callback?.("SUBSCRIBED"), 0);
      return channel;
    },
    async send(message: { type: string; event: string; payload: unknown }) {
      sent.push(message.payload);
      return "ok";
    },
    // Test-only helpers, not part of the real channel API.
    __simulateIncoming(payload: unknown) {
      broadcastHandler?.({ payload });
    },
    __sent: sent,
  };
  return channel;
}

/** A minimal fake of the supabase.from("calls")...chain useCall.ts uses:
 * .insert().select().single(), and .update().eq() (optionally chained with
 * a second .eq() for the "only if still ringing" guard). Both resolve
 * immediately with a caller-supplied row/error, since none of the three
 * scenarios under test (hangup/decline/timeout) care about real network
 * latency — they care about PHASE ORDERING relative to these calls. */
export function createFakeCallsTable(insertedRow: CallRow) {
  const updates: Record<string, unknown>[] = [];
  return {
    insert: (_values: unknown) => ({
      select: () => ({
        single: async () => ({ data: insertedRow, error: null }),
      }),
    }),
    update: (values: Record<string, unknown>) => {
      updates.push(values);
      const builder = {
        eq: (_col: string, _val: unknown) => builder,
        then: (resolve: (result: { error: null }) => void) => resolve({ error: null }),
      };
      return builder;
    },
    __updates: updates,
  };
}

export function makeCallRow(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "call-1",
    conversation_id: "conv-1",
    caller_id: "user-caller",
    kind: "audio",
    status: "ringing",
    started_at: new Date().toISOString(),
    answered_at: null,
    ended_at: null,
    ...overrides,
  };
}
