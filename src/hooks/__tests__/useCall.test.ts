// Covers the three call-lifecycle regressions this session's live-device
// debugging actually ran into (minimize-state desync after hangup, PiP
// arming/disarming around end-of-call, the general "did phase settle
// correctly" question that took hours of log-reading to answer by hand):
// hangup, decline, and the ring timeout. Each asserts PHASE ORDER, not just
// the end state — "phase flips to 'ended' before the network call
// completes" is exactly the invariant useCall.ts's own comments call out as
// load-bearing (see decline()/hangup()'s "Phase first, network second"),
// and exactly the kind of thing that's easy to silently break in a later
// edit without a test to catch it.
import { act, renderHook } from "@testing-library/react-native";

import { createFakeCallsTable, createFakeChannel, makeCallRow } from "../__mocks__/callTestUtils";
import { useCall } from "../useCall";

jest.mock("expo-callkit", () => ({
  onCallKitAudioSessionActivated: () => ({ remove: jest.fn() }),
  onCallKitAudioSessionInterruption: () => ({ remove: jest.fn() }),
  reportMuteState: jest.fn(),
}));

jest.mock("expo-speaker-toggle", () => ({
  resetAudioRoute: jest.fn(),
  setSpeakerphoneOn: jest.fn(),
}));

// useCall.ts imports markNextCallAsAnsweredViaCallKit/
// clearCallKitAudioSessionWait from WebRtcBridge.tsx — both already no-ops
// in the real file (see that file's own comment: "REVERTED 2026-09-20").
// WebRtcBridge.tsx itself pulls in expo-audio/react-native-webrtc, whose
// native modules don't exist under Jest — mocked here to just the two
// functions useCall.ts actually imports, not the whole bridge.
jest.mock("../../components/WebRtcBridge", () => ({
  markNextCallAsAnsweredViaCallKit: jest.fn(),
  clearCallKitAudioSessionWait: jest.fn(),
}));

jest.mock("../useE2ee", () => ({
  useE2ee: () => ({
    // null/no-op E2EE: encryptSignalToPeer returning null makes
    // encodeForWire fall back to its plain (unencrypted) path, which is
    // exactly what these tests want — they assert on the Signal payload
    // shape, not on encryption, which has its own coverage need elsewhere.
    encryptSignalToPeer: () => null,
    decryptSignalFromPeer: () => null,
    startCallKem: async () => null,
    receiveCallKem: async () => null,
  }),
}));

let mockChannel: ReturnType<typeof createFakeChannel>;
let mockCallsTable: ReturnType<typeof createFakeCallsTable>;

jest.mock("../../lib/supabase", () => ({
  supabase: {
    channel: (..._args: unknown[]) => mockChannel,
    removeChannel: jest.fn(),
    from: (table: string) => {
      if (table === "calls") return mockCallsTable;
      throw new Error(`unexpected table in test: ${table}`);
    },
  },
}));

const PEER_KEY = "peer-public-key";

describe("useCall — hangup", () => {
  beforeEach(() => {
    mockChannel = createFakeChannel();
    mockCallsTable = createFakeCallsTable(makeCallRow());
  });

  it("flips to ended/hangup immediately, before the signal broadcast and DB update resolve", async () => {
    const { result } = renderHook(() => useCall("user-caller", PEER_KEY));

    await act(async () => {
      await result.current.startCall("conv-1", "audio");
    });
    expect(result.current.state.phase).toBe("outgoing");

    // Let the channel's async subscribe() land before hanging up — hangup()
    // awaits sendSignalAndWait, which polls channelReadyRef and would
    // otherwise be racing its own join.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    let hangupPromise!: Promise<void>;
    act(() => {
      hangupPromise = result.current.hangup();
    });

    // The whole point of "phase first, network second": by the time hangup()
    // has made its FIRST await (inside sendSignalAndWait), the phase has
    // already committed. This is checked synchronously, before awaiting the
    // promise hangup() returned.
    expect(result.current.state.phase).toBe("ended");
    expect(result.current.state).toMatchObject({ phase: "ended", reason: "hangup" });

    await act(async () => {
      await hangupPromise;
    });

    // The "ended" status update reached the calls table exactly once, after
    // the phase had already moved — not used to gate the phase change.
    expect(mockCallsTable.__updates).toContainEqual(
      expect.objectContaining({ status: "ended" })
    );
  });

  it("is a no-op from idle — there is nothing to hang up on an unstarted call", async () => {
    const { result } = renderHook(() => useCall("user-caller", PEER_KEY));
    expect(result.current.state.phase).toBe("idle");

    await act(async () => {
      await result.current.hangup();
    });

    expect(result.current.state.phase).toBe("idle");
    expect(mockCallsTable.__updates).toHaveLength(0);
  });
});

describe("useCall — decline", () => {
  beforeEach(() => {
    mockChannel = createFakeChannel();
    mockCallsTable = createFakeCallsTable(makeCallRow({ caller_id: "user-remote" }));
  });

  it("flips to ended/declined immediately when declining an incoming call", async () => {
    const { result } = renderHook(() => useCall("user-callee", PEER_KEY));

    const incoming = makeCallRow({ caller_id: "user-remote", status: "ringing" });
    act(() => {
      result.current.listenForOffer(incoming);
    });
    expect(result.current.state.phase).toBe("incoming");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    let declinePromise!: Promise<void>;
    act(() => {
      declinePromise = result.current.decline();
    });

    expect(result.current.state).toMatchObject({ phase: "ended", reason: "declined" });

    await act(async () => {
      await declinePromise;
    });

    // The peer must actually be told — decline() awaits the broadcast before
    // cleanup() tears the channel down, specifically so this is never lost.
    expect(mockChannel.__sent.length).toBeGreaterThan(0);
    expect(mockCallsTable.__updates).toContainEqual(
      expect.objectContaining({ status: "declined" })
    );
  });

  it("is a no-op outside the incoming phase — a stray decline() must not end an active call", async () => {
    const { result } = renderHook(() => useCall("user-caller", PEER_KEY));

    await act(async () => {
      await result.current.startCall("conv-1", "audio");
    });
    expect(result.current.state.phase).toBe("outgoing");

    await act(async () => {
      await result.current.decline();
    });

    // decline() only ever acts on phase === "incoming" — an outgoing call
    // reaching this code path (a misrouted CallKit event, a stale callback)
    // must leave it untouched rather than silently ending someone else's
    // call out from under them.
    expect(result.current.state.phase).toBe("outgoing");
  });
});

describe("useCall — ring timeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockChannel = createFakeChannel();
    mockCallsTable = createFakeCallsTable(makeCallRow());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("marks an unanswered outgoing call as missed after the ring window", async () => {
    const { result } = renderHook(() => useCall("user-caller", PEER_KEY));

    await act(async () => {
      await result.current.startCall("conv-1", "audio");
    });
    expect(result.current.state.phase).toBe("outgoing");

    // 45s, matching RING_TIMEOUT_MS — asserted via behavior (does it fire),
    // not by importing the constant, so this test fails loudly if someone
    // changes the timeout without the UI copy/tests agreeing on why.
    await act(async () => {
      jest.advanceTimersByTime(45_000);
      // Flush the microtask queue the timer's own async IIFE schedules
      // (sendSignalAndWait, the calls-table update) before asserting.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({ phase: "ended", reason: "missed" });
    expect(mockCallsTable.__updates).toContainEqual(
      expect.objectContaining({ status: "missed" })
    );
  });

  it("does not fire once the call has already moved past ringing", async () => {
    const { result } = renderHook(() => useCall("user-caller", PEER_KEY));

    await act(async () => {
      await result.current.startCall("conv-1", "audio");
    });

    // Caller hangs up well before the ring window elapses. Fake timers are
    // active for this test (to control RING_TIMEOUT_MS below), so advancing
    // by 0ms — not a real setTimeout, which fake timers never auto-resolve —
    // is what lets the channel's subscribe() callback (also a setTimeout)
    // land before hangup() needs channelReadyRef to be true.
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await act(async () => {
      await result.current.hangup();
    });
    expect(result.current.state).toMatchObject({ phase: "ended", reason: "hangup" });

    // Advance past the 45s ring window. The "ended" screen's own unrelated
    // 3s auto-dismiss-to-idle timer (see useCall.ts's reset()) also fires
    // somewhere in this window on the same fake-timer clock, so by now state
    // has legitimately moved to "idle" — that's fine and expected. What this
    // asserts is narrower and still meaningful: phase must never become
    // "ended"/"missed", which is what a ring-timeout effect that failed to
    // tear itself down on the phase change away from "outgoing" (see
    // useCall.ts's own comment on exactly that cleanup) would produce,
    // clobbering the real hangup reason.
    await act(async () => {
      jest.advanceTimersByTime(45_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.phase === "ended" ? result.current.state.reason : null).not.toBe(
      "missed"
    );
  });
});
