import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type CallEndReason = "hangup" | "declined" | "failed" | "missed";

type CallKitEvents = {
  onAnswerCall: (payload: { uuid: string }) => void;
  onEndCall: (payload: { uuid: string }) => void;
  onMuteChanged: (payload: { uuid: string; muted: boolean }) => void;
  onAudioSessionActivated: () => void;
  onVoipToken: (payload: { token: string }) => void;
  onProviderReset: () => void;
};

type CallKitModuleType = {
  reportIncomingCall: (uuid: string, displayName: string, hasVideo: boolean) => void;
  reportIncomingCallAnswered: (uuid: string) => void;
  reportOutgoingCallStarted: (uuid: string, displayName: string) => void;
  reportOutgoingCallConnected: (uuid: string) => void;
  reportMuteState: (uuid: string, muted: boolean) => void;
  endCall: (uuid: string, reason: CallEndReason) => void;
  consumePendingVoipToken: () => string | null;
  consumePendingIncomingCall: () => { callId: string; conversationId: string } | null;
  consumeAnsweredCall: () => string | null;
  isCallKitAudioSessionActive: () => boolean;
  addListener: <E extends keyof CallKitEvents>(
    event: E,
    listener: CallKitEvents[E]
  ) => { remove: () => void };
};

/**
 * requireNativeModule THROWS at import time when the native binary hasn't
 * been rebuilt yet — and this module is imported from the app's root layout,
 * so an unguarded throw takes down the entire app rather than just disabling
 * calls. Caught here so a stale build degrades to "no system call UI"
 * instead of "nothing launches at all".
 */
let nativeModule: CallKitModuleType | null = null;
if (Platform.OS === "ios") {
  try {
    nativeModule = requireNativeModule("CallKit");
  } catch {
    nativeModule = null;
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        "[expo-callkit] native module missing — rebuild the app in Xcode. Calls fall back to the in-app overlay only until then."
      );
    }
  }
}

const noopSubscription = { remove: () => {} };

function listen<E extends keyof CallKitEvents>(
  event: E,
  listener: CallKitEvents[E]
): { remove: () => void } {
  return nativeModule?.addListener(event, listener) ?? noopSubscription;
}

/** True once the native module is actually present in this binary. Callers
 * should keep using the in-app CallOverlay regardless — CallKit augments the
 * overlay with the system call UI, it never replaces it. */
export function isCallKitAvailable(): boolean {
  return nativeModule !== null;
}

// MARK: Reporting call state to CallKit

/** Shows iOS's native incoming-call screen (works over the lock screen and
 * above other apps). The same uuid must be reused in endCallKitCall to close
 * out this report. No-op off iOS, or on a build predating this module. */
export function reportIncomingCall(uuid: string, displayName: string, hasVideo: boolean): void {
  nativeModule?.reportIncomingCall(uuid, displayName, hasVideo);
}

/** Tells CallKit an incoming call was answered from INSIDE the app, so it
 * stops showing its own banner over a call that is already running.
 *
 * Not needed when the call was answered from CallKit's own UI — that path
 * already went through CXAnswerCallAction, and the native side recognises
 * and ignores a duplicate report for it. */
export function reportIncomingCallAnswered(uuid: string): void {
  nativeModule?.reportIncomingCallAnswered(uuid);
}

/** Reports that this device is placing an outgoing call, so it appears
 * correctly in Recents and in the lock-screen "call in progress" UI. */
export function reportOutgoingCallStarted(uuid: string, displayName: string): void {
  nativeModule?.reportOutgoingCallStarted(uuid, displayName);
}

/** Marks an outgoing call connected. Call this on WebRTC's "connected"
 * state, not when ringing starts — CallKit uses it to start the call timer. */
export function reportOutgoingCallConnected(uuid: string): void {
  nativeModule?.reportOutgoingCallConnected(uuid);
}

/** Mirrors the in-app mute button into CallKit, so the system call screen
 * and Dynamic Island show the right state. No-op for a mute that originated
 * in CallKit's own UI — that already updated CallKit's state. */
export function reportMuteState(uuid: string, muted: boolean): void {
  nativeModule?.reportMuteState(uuid, muted);
}

/** Tells CallKit a call it is tracking has ended, for any reason OTHER than
 * the user ending it from the CallKit UI itself (that path fires onCallKitEnd
 * and needs no report back). */
export function endCallKitCall(uuid: string, reason: CallEndReason): void {
  nativeModule?.endCall(uuid, reason);
}

// MARK: Events from CallKit's own UI

/** Fires when the user answers from the CallKit UI (lock screen, system call
 * screen). Returns a no-op unsubscribe when the native module is absent. */
export function onCallKitAnswer(
  listener: (payload: { uuid: string }) => void
): { remove: () => void } {
  return listen("onAnswerCall", listener);
}

/** Fires when the user ends the call FROM the CallKit UI — the red hang-up
 * button, or the lock-screen decline. */
export function onCallKitEnd(
  listener: (payload: { uuid: string }) => void
): { remove: () => void } {
  return listen("onEndCall", listener);
}

/** Fires when the user toggles mute from the CallKit UI. */
export function onCallKitMuteChanged(
  listener: (payload: { uuid: string; muted: boolean }) => void
): { remove: () => void } {
  return listen("onMuteChanged", listener);
}

/** Fires when iOS tears down every call CallKit was tracking (a provider
 * reset). Any call the app still believes is active is gone, and continuing
 * to hold the mic open for it would be a bug the user cannot escape. */
export function onCallKitProviderReset(listener: () => void): { remove: () => void } {
  return listen("onProviderReset", listener);
}

// MARK: Audio session

/** Fires once CallKit has activated the shared AVAudioSession for a
 * CallKit-reported call.
 *
 * WebRTC's getUserMedia should wait for this before opening the mic on a
 * CallKit call, or the two fight over the audio route — which is why calls
 * answered from the lock screen could connect with no audio at all. */
export function onCallKitAudioSessionActivated(listener: () => void): { remove: () => void } {
  return listen("onAudioSessionActivated", listener);
}

/** Synchronous read of whether CallKit has ALREADY activated the shared
 * audio session right now.
 *
 * onCallKitAudioSessionActivated fires exactly once, at the moment
 * didActivate runs natively — and a subscription set up even slightly late
 * (the common case: the event has to reach JS, flow through React state, and
 * arrive at the mic-opening code, while didActivate fires independently and
 * usually earlier) misses it permanently, then falls through to a timeout
 * that wrongly assumes CallKit is not involved. Checking current state first
 * removes the race entirely. */
export function isCallKitAudioSessionActive(): boolean {
  return nativeModule?.isCallKitAudioSessionActive() ?? false;
}

// MARK: Cold-launch records

/** Reads (and clears) the VoIP push token PushKit obtained — possibly before
 * this JS runtime existed, on a launch driven purely by push registration.
 *
 * DOES clear the stored value. Nothing is lost: PushKit re-delivers the
 * token unprompted on every launch, and leaving it meant two accounts
 * sharing one phone took ownership back and forth on each restart, with
 * whichever lost simply never ringing. The caller must therefore retry a
 * failed upload in-process rather than relying on the next launch to re-read
 * it — see the retry loop in useCallManager. */
export function consumePendingVoipToken(): string | null {
  return nativeModule?.consumePendingVoipToken() ?? null;
}

/** Fires whenever iOS issues a VoIP token, including the stored one replayed
 * when the bridge comes up.
 *
 * Subscribing is what makes a REINSTALLED app register its new token: the
 * old consume-once read raced PushKit and, when it lost, discarded the token
 * permanently — leaving the database pointing at a token iOS had already
 * invalidated, so calls silently never rang. */
export function onVoipToken(listener: (token: string) => void): { remove: () => void } {
  const subscription = nativeModule?.addListener("onVoipToken", ({ token }) => listener(token));
  return { remove: () => subscription?.remove() };
}

/** Reads (and clears) the call this launch was woken to handle — set when a
 * VoIP push reported an incoming call to CallKit before any JS was running.
 *
 * Call once on startup; when non-null, reconnect call state to the named
 * CallRow instead of waiting for a Realtime "ringing" row that already
 * exists and was already reported. */
export function consumePendingIncomingCall(): {
  callId: string;
  conversationId: string;
} | null {
  return nativeModule?.consumePendingIncomingCall() ?? null;
}

/** Reads (and clears) the id of a call the user already answered from
 * CallKit's own UI before this JS runtime existed.
 *
 * When non-null, the app must skip its own Accept/Decline screen for that
 * call and go straight to connecting — otherwise the phone shows the call as
 * connected while the app is still asking whether to answer it. */
export function consumeAnsweredCall(): string | null {
  return nativeModule?.consumeAnsweredCall() ?? null;
}
