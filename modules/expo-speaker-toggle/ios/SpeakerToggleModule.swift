import AVFoundation
import ExpoModulesCore
import WebRTC

// Owns the call's audio route on iOS. There is no JS-reachable way to switch
// between the earpiece and the loudspeaker — expo-audio's
// shouldRouteThroughEarpiece is Android-only and react-native-webrtc has no
// equivalent — so without this a call always comes out of the earpiece and is
// inaudible unless the phone is against your face.
//
// Route and MODE are managed together on purpose. They are not independent:
//
//   .voiceChat  — tuned for a phone at the ear. iOS applies earpiece-oriented
//                 leveling, so output is deliberately quiet. Forcing the
//                 loudspeaker while in this mode is exactly the "speaker is
//                 on but I can barely hear them" complaint: the route moves,
//                 the leveling doesn't.
//   .videoChat  — the loudspeaker profile. Same voice-processing I/O unit
//                 (echo cancellation, automatic gain) but leveled for a
//                 device at arm's length.
//
// Keeping the desired route in `speakerEnabled` matters because the session
// gets reconfigured more than once per call — expo-audio sets a category
// before the mic opens, WebRTC re-negotiates on reconnect, and CallKit
// reactivates the session when a call is answered from the lock screen. Every
// one of those paths calls back in here, and each must re-apply the SAME
// mode, or the route silently reverts to the quiet profile mid-call.
public class SpeakerToggleModule: Module {
  private static var speakerEnabled = false

  /// True once CallKit has configured and activated the session for the
  /// current call (see CallKitModule's didActivate). While true, a request
  /// for the route CallKit already set is a no-op instead of re-running
  /// setCategory: a category change tears down and rebuilds the active
  /// route, and WebRTC's just-opened mic track stays bound to the route that
  /// existed a moment ago — negotiation succeeds, but nobody hears anything.
  /// This is what "answer from CallKit, connect, dead silence" actually was:
  /// JS still called setSpeakerphoneOn(false) for a plain voice call right
  /// after answering, undoing the very session CallKit had just handed over.
  static var callKitOwnsSession = false

  /// Applies the category, the mode implied by the current route, and the
  /// route itself, in that order. Order is load-bearing: the override is
  /// cleared by a category change, so it has to be re-asserted afterwards.
  private static func applyAudioRoute() {
    // Under manual audio, a mid-call route change must go through WebRTC's
    // configuration lock — otherwise it races the audio unit and can drop
    // the route entirely. The lock is held across both calls so the category
    // and the port override are applied as one change.
    let rtcSession = RTCAudioSession.sharedInstance()
    rtcSession.lockForConfiguration()
    defer { rtcSession.unlockForConfiguration() }

    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: speakerEnabled ? .videoChat : .voiceChat,
        options: [.allowBluetooth, .allowBluetoothA2DP]
      )
      try session.overrideOutputAudioPort(speakerEnabled ? .speaker : .none)
    } catch {
      // Non-fatal: fails when the session isn't in a call-capable state yet
      // (toggled before the mic opened). The next call into here — there is
      // always one, on connect — applies it.
    }
  }

  public func definition() -> ModuleDefinition {
    Name("SpeakerToggle")

    Function("setSpeakerphoneOn") { (enabled: Bool) -> Void in
      let changed = SpeakerToggleModule.speakerEnabled != enabled
      SpeakerToggleModule.speakerEnabled = enabled
      // Skip re-applying a route CallKit already set to this exact state —
      // see callKitOwnsSession's comment. A genuine change (e.g. the user
      // taps the speaker button mid-call) still goes through regardless of
      // who set the session up, because the route really does need to move.
      if changed || !SpeakerToggleModule.callKitOwnsSession {
        SpeakerToggleModule.applyAudioRoute()
      }
    }

    // Enables or disables WebRTC's audio unit for calls CallKit does NOT
    // drive: outgoing calls, and calls answered inside the app.
    //
    // Required because WebRTC now runs with useManualAudio = true (see
    // CallKitAppDelegateSubscriber). That stops WebRTC hijacking the session
    // out from under CallKit, but it also means WebRTC will never enable
    // audio by itself — so without this call every outgoing call would
    // connect and be silent, which is the same bug moved to a different path.
    Function("enableWebRtcAudio") { (enabled: Bool) -> Void in
      let session = RTCAudioSession.sharedInstance()
      if enabled {
        session.lockForConfiguration()
        do {
          try session.setActive(true)
        } catch {
          // Non-fatal: an active call elsewhere on the device can refuse
          // activation. isAudioEnabled below still lets WebRTC try.
        }
        session.unlockForConfiguration()
      }
      session.isAudioEnabled = enabled
    }

    // Set once CallKit's didActivate fires, cleared once a call ends —
    // mirrors the JS-side markNextCallAsAnsweredViaCallKit/
    // clearCallKitAudioSessionWait pair so the native and JS halves of "does
    // CallKit currently own the session" never disagree.
    Function("setCallKitOwnsSession") { (owns: Bool) -> Void in
      SpeakerToggleModule.callKitOwnsSession = owns
    }

    // Called before getUserMedia opens the mic, and again once the call
    // connects. Deliberately does NOT setActive(true): activating the
    // session rebuilds the audio route, and WebRTC's already-captured track
    // stays bound to the old one — the call connects, video flows, and the
    // microphone is silently dead. WebRTC and CallKit activate the session
    // themselves; this only declares what kind of session it should be.
    Function("configureForVoiceCall") { () -> Void in
      SpeakerToggleModule.applyAudioRoute()
    }

    // Resets to the earpiece for the next call. Without this the loudspeaker
    // preference leaks from one call into the next, so a call started by
    // raising the phone to your ear would blast out of the speaker.
    Function("resetAudioRoute") { () -> Void in
      SpeakerToggleModule.speakerEnabled = false
    }
  }
}
