// The caller must always produce an SDP offer: without one the callee's
// Accept (in-app or CallKit) waits forever while Decline still works.
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

jest.mock("../../components/WebRtcBridge", () => ({
  markNextCallAsAnsweredViaCallKit: jest.fn(),
  clearCallKitAudioSessionWait: jest.fn(),
}));

jest.mock("../useE2ee", () => ({
  useE2ee: () => ({
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
    removeChannel: jest.fn(async () => "ok"),
    from: (table: string) => {
      if (table === "calls") return mockCallsTable;
      throw new Error(`unexpected table in test: ${table}`);
    },
  },
}));

type MockIce = { servers: { urls: string }[]; source: "server" | "fallback" };
const mockServerIce: MockIce = { servers: [{ urls: "turn:relay.test:3478" }], source: "server" };
let mockWarmIce: MockIce | null = null;
let mockColdIce: Promise<MockIce> = Promise.resolve(mockServerIce);

jest.mock("../../lib/iceServers", () => ({
  peekIceServers: () => mockWarmIce,
  getIceServers: () => mockColdIce,
  warmIceServers: () => undefined,
  penalizeRelayForUrl: () => null,
  setRelayProbingAllowed: () => undefined,
}));

function attachBridge(result: { current: ReturnType<typeof useCall> }) {
  const commands: { type: string; iceServers?: unknown }[] = [];
  result.current.setBridgeRef({ send: (command: object) => commands.push(command as { type: string }) } as never);
  return commands;
}

describe("useCall — caller offer", () => {
  beforeEach(() => {
    mockChannel = createFakeChannel();
    mockCallsTable = createFakeCallsTable(makeCallRow({ kind: "video" }));
    mockWarmIce = null;
    mockColdIce = Promise.resolve(mockServerIce);
  });

  it("creates the offer when TURN credentials are already cached", async () => {
    mockWarmIce = mockServerIce;
    const { result } = renderHook(() => useCall("user-caller", "peer-public-key"));
    const commands = attachBridge(result);

    await act(async () => {
      await result.current.startCall("conv-1", "video");
    });

    expect(result.current.state.phase).toBe("outgoing");
    const offer = commands.find((c) => c.type === "create-offer");
    expect(offer).toBeDefined();
    expect(offer?.iceServers).toEqual(mockServerIce.servers);
  });

  it("creates the offer on a second call placed while the first one's ended screen is up", async () => {
    mockWarmIce = mockServerIce;
    const { result } = renderHook(() => useCall("user-caller", "peer-public-key"));
    const commands = attachBridge(result);

    await act(async () => {
      await result.current.startCall("conv-1", "video");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await result.current.hangup();
    });
    expect(result.current.state.phase).toBe("ended");

    mockCallsTable = createFakeCallsTable(makeCallRow({ id: "call-2", kind: "video" }));
    commands.length = 0;
    await act(async () => {
      await result.current.startCall("conv-1", "video");
    });

    expect(commands.some((c) => c.type === "create-offer")).toBe(true);
  });

  it("creates the offer after waiting for credentials on a cold cache", async () => {
    const { result } = renderHook(() => useCall("user-caller", "peer-public-key"));
    const commands = attachBridge(result);

    await act(async () => {
      await result.current.startCall("conv-1", "video");
    });

    expect(commands.map((c) => c.type)).toEqual(expect.arrayContaining(["prepare-peer", "create-offer"]));
  });

  it("does not create an offer for a call hung up while credentials were loading", async () => {
    let release!: (ice: MockIce) => void;
    mockColdIce = new Promise<MockIce>((resolve) => {
      release = resolve;
    });
    const { result } = renderHook(() => useCall("user-caller", "peer-public-key"));
    const commands = attachBridge(result);

    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.startCall("conv-1", "video");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.state.phase).toBe("outgoing");

    let hangingUp!: Promise<void>;
    act(() => {
      hangingUp = result.current.hangup();
    });
    await act(async () => {
      release(mockServerIce);
      await starting;
      await hangingUp;
    });

    expect(commands.some((c) => c.type === "create-offer")).toBe(false);
  });
});
