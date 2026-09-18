import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type SpeakerToggleModuleType = {
  setSpeakerphoneOn: (enabled: boolean) => void;
  configureForVoiceCall: () => void;
  resetAudioRoute: () => void;
  setCallKitOwnsSession: (owns: boolean) => void;
  enableWebRtcAudio: (enabled: boolean) => void;
};

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
 * call/mic session is active — the native side just swallows the error. */
export function setSpeakerphoneOn(enabled: boolean): void {
  nativeModule?.setSpeakerphoneOn(enabled);
}

/** Applies the call audio session (category + the mode matching the current
 * speaker route). Call before opening the mic AND again once the call
 * connects — the session is reconfigured by expo-audio, WebRTC and CallKit
 * at different points, and each reset drops the route. No-op off iOS. */
export function configureForVoiceCall(): void {
  nativeModule?.configureForVoiceCall();
}

/** Clears the remembered loudspeaker preference so the next call starts on
 * the earpiece. Call when a call ends. */
export function resetAudioRoute(): void {
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
