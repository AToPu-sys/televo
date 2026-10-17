import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type TelevoAudioModuleType = {
  isNoiseSuppressionEnabled: () => boolean;
  setNoiseSuppressionEnabled: (enabled: boolean) => void;
  isCustomDeviceEnabled: () => boolean;
  setCustomDeviceEnabled: (enabled: boolean) => void;
  diagnostics: () => Record<string, unknown>;
  currentNetwork?: () => NetworkPath;
  addListener?: (event: string, listener: (path: NetworkPath) => void) => { remove: () => void };
};

export type NetworkPath = {
  status: "satisfied" | "unsatisfied" | "satisfiable" | "unknown";
  interface: "wifi" | "cellular" | "wired" | "other" | "none";
  /** First gateway address — tells two Wi-Fi networks apart. */
  gateway: string;
  expensive: boolean;
  constrained: boolean;
  ipv4: boolean;
  ipv6: boolean;
};

// Same guard as expo-speaker-toggle: a binary built before this module
// existed must not crash app launch.
let nativeModule: TelevoAudioModuleType | null = null;
if (Platform.OS === "ios") {
  try {
    nativeModule = requireNativeModule("TelevoAudio");
  } catch {
    nativeModule = null;
  }
}

/** Neural noise suppression (rnnoise) on the call microphone. Toggling takes
 * effect immediately, mid-call, and is remembered. */
export function isNoiseSuppressionEnabled(): boolean {
  return nativeModule?.isNoiseSuppressionEnabled() ?? false;
}

export function setNoiseSuppressionEnabled(enabled: boolean): void {
  nativeModule?.setNoiseSuppressionEnabled(enabled);
}

/** Televo's own call audio device. Turning it off falls back to WebRTC's
 * stock audio from the next app launch — the escape hatch if a phone ever
 * misbehaves with it. */
export function isCustomAudioDeviceEnabled(): boolean {
  return nativeModule?.isCustomDeviceEnabled() ?? false;
}

export function setCustomAudioDeviceEnabled(enabled: boolean): void {
  nativeModule?.setCustomDeviceEnabled(enabled);
}

export function audioDiagnostics(): Record<string, unknown> {
  return nativeModule?.diagnostics() ?? {};
}

/** Every real change of the network path (Wi-Fi <-> cellular, another Wi-Fi,
 * lost / regained). iOS only; a no-op subscription elsewhere. */
export function addNetworkChangeListener(listener: (path: NetworkPath) => void): { remove: () => void } {
  return nativeModule?.addListener?.("onNetworkChange", listener) ?? { remove: () => {} };
}

export function currentNetwork(): NetworkPath | null {
  return nativeModule?.currentNetwork?.() ?? null;
}

export { TelevoCallView, isNativeCallScreenAvailable } from "./TelevoCallView";
export type { CallScreenAction, TelevoCallViewProps } from "./TelevoCallView";
