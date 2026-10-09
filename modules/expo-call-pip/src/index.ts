import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type CallPipEvents = {
  onPipWillStart: () => void;
  onPipDidStop: () => void;
  onPipFailedToStart: (payload: { reason: string }) => void;
};

type CallPipModuleType = {
  isSupported: () => boolean;
  isBackgroundCameraSupported: () => boolean;
  startSession: (streamReactTag: string, localStreamReactTag: string | null) => void;
  endSession: () => void;
  addListener: <E extends keyof CallPipEvents>(
    event: E,
    listener: CallPipEvents[E]
  ) => { remove: () => void };
};

/**
 * Same defensive-load reasoning as expo-callkit's own module: this is
 * imported from useCallManager, which mounts app-wide — an unguarded throw
 * from a build that hasn't picked up this native module yet would take down
 * the whole app rather than just disabling PiP.
 */
let nativeModule: CallPipModuleType | null = null;
if (Platform.OS === "ios") {
  try {
    nativeModule = requireNativeModule("CallPip");
  } catch {
    nativeModule = null;
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        "[expo-call-pip] native module missing — rebuild the app in Xcode. Backgrounding during a call will not show system Picture-in-Picture until then."
      );
    }
  }
}

const noopSubscription = { remove: () => {} };

function listen<E extends keyof CallPipEvents>(
  event: E,
  listener: CallPipEvents[E]
): { remove: () => void } {
  return nativeModule?.addListener(event, listener) ?? noopSubscription;
}

/** True on a device/OS/build that can actually show system PiP for a call
 * (real hardware only — the simulator's PictureInPictureController always
 * reports unsupported). Callers should keep the existing in-app minimize
 * widget available regardless; PiP only helps for the OUT-of-app case. */
export function isCallPipSupported(): boolean {
  return nativeModule?.isSupported() ?? false;
}

/** True when iOS keeps this device's camera streaming while the app is in
 * PiP (multitasking camera access). When false, the camera pauses in the
 * background and the peer would otherwise see a frozen frame. */
export function isBackgroundCameraSupported(): boolean {
  return nativeModule?.isBackgroundCameraSupported?.() ?? false;
}

/**
 * Arms system PiP for the CURRENT video call, given the same streamURL
 * strings already passed to <RTCView> for the peer's and this device's own
 * video (WebRtcBridge.tsx). Call this once the peer's video is actually
 * flowing (mediaConfirmed) — arming it earlier has nothing to show yet,
 * arming it late risks missing the backgrounding moment PiP is supposed to
 * catch. localStreamReactTag is optional — PiP still shows the peer
 * full-size without it, just without the FaceTime-style self thumbnail.
 *
 * Does NOT itself show PiP — canStartPictureInPictureAutomaticallyFromInline
 * (set natively) is what makes iOS start it automatically the moment the
 * app backgrounds. This only needs to be called once per call becoming
 * ready, not on every background/foreground transition.
 */
export function startCallPip(streamReactTag: string, localStreamReactTag: string | null = null): void {
  nativeModule?.startSession(streamReactTag, localStreamReactTag);
}

/** Disarms PiP and releases the native frame relay — call at the same
 * point a call's media is torn down (hangup, call ended), so a finished
 * call never leaves a stale PiP source registered for the next one. */
export function endCallPip(): void {
  nativeModule?.endSession();
}

export function onCallPipWillStart(listener: () => void): { remove: () => void } {
  return listen("onPipWillStart", listener);
}

export function onCallPipDidStop(listener: () => void): { remove: () => void } {
  return listen("onPipDidStop", listener);
}

export function onCallPipFailedToStart(
  listener: (payload: { reason: string }) => void
): { remove: () => void } {
  return listen("onPipFailedToStart", listener);
}
