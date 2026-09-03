import Constants, { ExecutionEnvironment } from "expo-constants";

/**
 * `react-native-webrtc` is a native module, so it exists only in a development
 * or production build — never in Expo Go. A plain top-level import therefore
 * crashes the whole app in Expo Go with "Unable to resolve
 * react-native-webrtc", taking chats and everything else down with it.
 *
 * The module is loaded lazily through require() so Expo Go keeps working
 * (with calls unavailable) instead of failing to start at all.
 */
export const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

type WebRtcModule = typeof import("react-native-webrtc");

let cached: WebRtcModule | null = null;

/** Returns the native WebRTC module, or null when it isn't available. */
export function getWebRtc(): WebRtcModule | null {
  if (isExpoGo) return null;
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("react-native-webrtc") as WebRtcModule;
    return cached;
  } catch {
    // A build that somehow lacks the module should degrade the same way Expo
    // Go does rather than crash.
    return null;
  }
}

/** Whether calls can actually run in this runtime. */
export function callsSupported(): boolean {
  return getWebRtc() !== null;
}
