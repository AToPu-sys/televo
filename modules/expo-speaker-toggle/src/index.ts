import { setAudioModeAsync } from "expo-audio";
import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type SpeakerToggleModuleType = {
  setSpeakerphoneOn: (enabled: boolean, userInitiated: boolean) => void;
  configureForVoiceCall: () => void;
  resetAudioRoute: () => void;
  setCallKitOwnsSession: (owns: boolean) => void;
  enableWebRtcAudio: (enabled: boolean) => void;
  isWebRtcAudioEnabled: () => boolean;
  audioRouteSnapshot: () => Record<string, unknown>;
  forceRepairAudioRoute: (wantSpeaker: boolean) => boolean;
  getAudioRoutes: () => AudioRoutes;
  setAudioRoute: (id: string) => boolean;
  addListener?: (event: string, listener: (payload: AudioRouteChange) => void) => { remove: () => void };
};

export type AudioRouteKind = "receiver" | "speaker" | "bluetooth" | "headphones" | "car" | "usb" | "airplay";
export type AudioRoute = { id: string; name: string; kind: AudioRouteKind };
export type AudioRoutes = { routes: AudioRoute[]; current: string };
export type AudioRouteChange = AudioRoutes & { reason: "newDevice" | "deviceRemoved" | "override" | "category" | "other" };

// requireNativeModule THROWS at import time if the native binary hasn't been
// rebuilt yet (a fresh JS install always runs before the matching Xcode
// build lands on device). That throw happens at module-graph load, before
// any component even renders — so it doesn't fail gracefully inside one
// feature, it took down the entire app (every provider below it in the
// import graph, including ThemeProvider, failed to initialize). Caught here
// so a stale binary just means the speaker toggle silently no-ops instead of
// crashing app launch.
let nativeModule: SpeakerToggleModuleType | null = null;
if (Platform.OS === "ios") {
  try {
    nativeModule = requireNativeModule("SpeakerToggle");
  } catch {
    nativeModule = null;
    if (__DEV__) {
      // Silence here once cost hours: the speaker button toggled its icon
      // while the audio route never moved, which reads as "the speaker
      // doesn't work" rather than "this binary predates the module".
      // eslint-disable-next-line no-console
      console.warn(
        "[expo-speaker-toggle] native module missing — rebuild the app in Xcode. Speaker toggle is a no-op until then."
      );
    }
  }
}

/** Switches the active call's audio route between the earpiece and the
 * loudspeaker. No-op on platforms other than iOS. Safe to call even if no
 * call/mic session is active — the native side just swallows the error.
 *
 * `userInitiated` MUST be true only for a direct response to the user tapping
 * the in-app speaker button, and false for every automatic re-assert (on
 * "local-ready", and again on "connection-state: connected"). The native side
 * uses this to allow at most one automatic route correction per CallKit-owned
 * call — CallKit's own audio session setup always configures the earpiece
 * profile with no idea whether the call is video, so exactly one correction
 * is genuinely needed, but a second one moments later (once media is already
 * flowing) is what was silently killing audio a few seconds into a
 * CallKit-answered call. A real user tap always goes through regardless. */
export function setSpeakerphoneOn(enabled: boolean, userInitiated: boolean = false): void {
  if (Platform.OS === "android") {
    // Android has no CallKit-equivalent concept to race against here — there
    // is no second system component that can also own the audio session —
    // so this can apply unconditionally on every call, automatic or not.
    // expo-audio's shouldRouteThroughEarpiece is exactly the "move audio
    // between the earpiece and loudspeaker" primitive this module exists
    // for; a real native module (ConnectionService/AudioManager, matching
    // the iOS CallKit module's depth) is still the right long-term answer
    // for the system-incoming-call UI, but the actual audio route for a
    // call in progress needs nothing more than this.
    void setAudioModeAsync({ shouldRouteThroughEarpiece: !enabled }).catch(() => {});
    return;
  }
  nativeModule?.setSpeakerphoneOn(enabled, userInitiated);
}

/** Applies the call audio session (category + the mode matching the current
 * speaker route). Call before opening the mic AND again once the call
 * connects — the session is reconfigured by expo-audio, WebRTC and CallKit
 * at different points, and each reset drops the route. No-op off iOS. */
export function configureForVoiceCall(): void {
  if (Platform.OS === "android") {
    // allowsRecording/interruptionMode matter here for the same reason as
    // useRinger.ts's own setAudioModeAsync call: without 'doNotMix' the
    // session can stay in whatever ducked/mixed mode a previous call left
    // it in, and without allowsRecording a call connects with an open mic
    // track but no audio actually captured.
    void setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
    }).catch(() => {});
    return;
  }
  nativeModule?.configureForVoiceCall();
}

/** Clears the remembered loudspeaker preference so the next call starts on
 * the earpiece. Call when a call ends. */
export function resetAudioRoute(): void {
  if (Platform.OS === "android") {
    void setAudioModeAsync({ shouldRouteThroughEarpiece: true }).catch(() => {});
    return;
  }
  nativeModule?.resetAudioRoute();
}

/** Tells the native module whether CallKit currently owns the shared audio
 * session for this call. While true, setSpeakerphoneOn skips re-applying a
 * route that already matches the requested state instead of unconditionally
 * calling setCategory — a category change tears down and rebuilds whatever
 * route is live, which is what silently killed audio on a CallKit-answered
 * call even after the mic-open path was fixed. Set true once
 * waitForCallKitAudioSession resolves true in WebRtcBridge's getMedia, and
 * cleared in releaseMedia so it never leaks into the next call. */
export function setCallKitOwnsSession(owns: boolean): void {
  nativeModule?.setCallKitOwnsSession(owns);
}

/** Turns WebRTC's audio unit on or off for calls CallKit does not drive.
 *
 * WebRTC runs in manual-audio mode so it cannot hijack the session CallKit
 * hands over. The cost is that outgoing and in-app-answered calls must enable
 * audio explicitly — miss this and such a call connects with no sound. */
export function enableWebRtcAudio(enabled: boolean): void {
  nativeModule?.enableWebRtcAudio(enabled);
}

/** True when WebRTC's audio unit is actually running.
 *
 * Distinct from "we called enableWebRtcAudio(true)": that can fail silently
 * when another call owns the audio session, leaving a connected call with
 * no sound. Read it to verify rather than assume. Returns false when the
 * native module is unavailable (Expo Go), which callers treat as "nothing
 * to repair" rather than as a fault. */
export function isWebRtcAudioEnabled(): boolean {
  try {
    return nativeModule?.isWebRtcAudioEnabled() ?? false;
  } catch {
    // A binary that predates this function throws rather than returning —
    // treated as "cannot tell", which the watchdog reads as nothing to fix.
    return false;
  }
}

/** A full snapshot of the current audio route, for diagnosing a call that is
 * connected and carrying RTP but produces no sound.
 *
 * isWebRtcAudioEnabled() only reports whether WebRTC's audio unit is
 * running. That was true throughout real silent calls on 2026-09-20, so the
 * fault lies elsewhere in the route — this returns the category, mode,
 * current input/output ports, system volume and session-active flags so the
 * actual cause is visible in the call trace. Returns an empty object when
 * the native module is unavailable or predates this function. */
export function audioRouteSnapshot(): Record<string, unknown> {
  try {
    return nativeModule?.audioRouteSnapshot() ?? {};
  } catch {
    return {};
  }
}

/** Rebuilds the audio session and route from scratch for a call that is
 * connected but silent.
 *
 * Deliberately ignores the callKitOwnsSession guard every other route path
 * respects: that guard exists to avoid BREAKING working audio, and this is
 * only ever called once the watchdog has confirmed from audioRouteSnapshot()
 * that the audio is already broken. Returns false if the repair itself
 * failed (another call owns the session), or when the native module is
 * unavailable. */
export function forceRepairAudioRoute(wantSpeaker: boolean): boolean {
  try {
    return nativeModule?.forceRepairAudioRoute(wantSpeaker) ?? false;
  } catch {
    return false;
  }
}

/** Where the call's sound can go right now (iPhone, speaker, AirPods…) and
 * which one is active. Off iOS: just the two built-in routes. */
export function getAudioRoutes(): AudioRoutes {
  const fallback: AudioRoutes = {
    routes: [
      { id: "receiver", name: "iPhone", kind: "receiver" },
      { id: "speaker", name: "Speaker", kind: "speaker" },
    ],
    current: "receiver",
  };
  try {
    return nativeModule?.getAudioRoutes?.() ?? fallback;
  } catch {
    return fallback;
  }
}

/** Sends the call's sound to `id` from getAudioRoutes(). Returns false when
 * the device is gone or the native module predates this feature. */
export function setAudioRoute(id: string): boolean {
  try {
    return nativeModule?.setAudioRoute?.(id) ?? false;
  } catch {
    return false;
  }
}

/** Called whenever the route changes — including iOS moving the call to
 * AirPods on its own when they connect, or off them when they're removed. */
export function addAudioRouteListener(listener: (change: AudioRouteChange) => void): () => void {
  const subscription = nativeModule?.addListener?.("onAudioRouteChange", listener);
  return () => subscription?.remove();
}
