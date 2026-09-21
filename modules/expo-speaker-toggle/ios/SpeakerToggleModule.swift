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

  /// True once an automatic (non-user) route correction has already run for
  /// the CURRENT CallKit-owned session. CallKit's own configureAudioSessionForCall
  /// (CallKitDelegate.swift) always sets `.voiceChat`/earpiece — it has no
  /// idea whether the call is audio or video — so a video call answered via
  /// CallKit genuinely needs exactly ONE automatic correction to `.videoChat`/
  /// speaker afterwards. But useCall.ts fires the automatic re-assert TWICE
  /// per call ("local-ready", then again on "connection-state: connected"
  /// once ICE/DTLS finish, a couple of seconds later — to defend against iOS
  /// re-evaluating the route as the audio unit spins up). Applying BOTH while
  /// CallKit owns the session rebuilds the route a second time right as media
  /// starts flowing, which is what a route rebuild moments into an
  /// already-live call looks like from the user's side: a few seconds of
  /// audio, then silence. Reset in setCallKitOwnsSession(true) so each new
  /// CallKit-owned call gets its one correction again.
  static var callKitAutoRouteApplied = false

  /// True when the session's current output is the built-in earpiece.
  ///
  /// Used to decide whether a request for the loudspeaker still has work to
  /// do, instead of relying on a one-shot counter that cannot tell "already
  /// correct" from "never applied".
  private static func isOnEarpiece() -> Bool {
    AVAudioSession.sharedInstance().currentRoute.outputs.contains {
      $0.portType == .builtInReceiver
    }
  }

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

    // `userInitiated` distinguishes an explicit tap on the in-app speaker
    // button from the automatic re-asserts useCall.ts fires on "local-ready"
    // and on "connection-state: connected" to make sure the desired route
    // (earpiece for voice, speaker for video) is in effect. That distinction
    // is the fix for "audio for ~3 seconds then total silence" on a
    // CallKit-answered call:
    //
    // The old logic ran `applyAudioRoute()` (which calls
    // AVAudioSession.setCategory, tearing down and rebuilding whatever route
    // is currently active) whenever the requested state differed from this
    // module's `speakerEnabled` flag — regardless of who owned the session.
    // `speakerEnabled` starts `false` on every fresh launch, so the very
    // first automatic setSpeakerphoneOn call after a CallKit-driven answer —
    // "local-ready", for a VIDEO call, which wants the loudspeaker — saw
    // `changed == true` and rebuilt the route CallKit had just activated and
    // handed to WebRTC's audio unit moments earlier, before any packets had
    // even flowed. The second automatic call, at "connected" a couple of
    // seconds later once ICE/DTLS finish, rebuilt it a second time. Either
    // one leaves WebRTC's already-opened mic/speaker track bound to a route
    // the OS no longer considers current — negotiation looks fine, audio
    // dies. A real user tap on the speaker button must still always go
    // through, since the user is deliberately asking the route to move.
    Function("setSpeakerphoneOn") { (enabled: Bool, userInitiated: Bool) -> Void in
      let changed = SpeakerToggleModule.speakerEnabled != enabled
      SpeakerToggleModule.speakerEnabled = enabled
      if userInitiated {
        // Always apply: this is the one case where rebuilding CallKit's
        // route is the correct, requested behaviour.
        SpeakerToggleModule.applyAudioRoute()
      } else if !SpeakerToggleModule.callKitOwnsSession {
        // Automatic re-assert, and this device (not CallKit) owns the
        // session — safe, and still necessary for outgoing / in-app-answered
        // calls, which is the case this used to cover correctly. Applied
        // unconditionally (not just on `changed`) to match the previous
        // behaviour for this branch, since expo-audio / WebRTC renegotiation
        // can revert the route without `speakerEnabled` itself changing.
        SpeakerToggleModule.applyAudioRoute()
      } else if enabled && SpeakerToggleModule.isOnEarpiece() {
        // CallKit owns the session AND it is currently on the earpiece while
        // something is asking for the loudspeaker — i.e. a video call.
        //
        // This deliberately ignores callKitAutoRouteApplied. That counter
        // exists to stop repeated rebuilds of a route that is ALREADY
        // correct, which is a real cause of mid-call silence. But when the
        // current output is the receiver and the request is for the speaker,
        // the route is by definition not correct yet: CallKit's
        // configureAudioSessionForCall always installs .voiceChat/Receiver
        // because it cannot know the call carries video.
        //
        // Measured 2026-09-20: real video calls sat on [Receiver] with
        // media flowing and isAudioEnabled true — inaudible in practice,
        // since nobody holds a video call to their ear. useCall asks twice
        // (local-ready, then again at connection-state connected); with the
        // old counter the first ask burned the single allowance at a moment
        // iOS could still re-evaluate the route, and the second — the one
        // that exists precisely to make it stick — was dropped.
        //
        // Guarded by the actual current route rather than by a counter, so
        // it cannot loop: once the output really is the speaker,
        // isOnEarpiece() is false and this branch stops firing.
        SpeakerToggleModule.callKitAutoRouteApplied = true
        SpeakerToggleModule.applyAudioRoute()
      } else if changed && !SpeakerToggleModule.callKitAutoRouteApplied {
        // Any other automatic correction under CallKit ownership keeps the
        // original one-shot behaviour.
        SpeakerToggleModule.callKitAutoRouteApplied = true
        SpeakerToggleModule.applyAudioRoute()
      }
      // Every subsequent automatic re-assert while CallKit owns the session
      // is skipped: the route is already correct, and re-running
      // applyAudioRoute() a second time is what was rebuilding it out from
      // under WebRTC's already-flowing audio.
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

    // Reads back what enableWebRtcAudio actually achieved.
    //
    // Needed because enabling audio can FAIL silently: setActive(true)
    // throws when another call owns the session (a phone call, another VoIP
    // app), and the catch above deliberately swallows that so the call can
    // still try. Without a readback, JS has no way to tell "audio is on"
    // from "we asked and it didn't take" — which is exactly the state a
    // connected-but-silent call is in. The watchdog in WebRtcBridge polls
    // this while media is flowing and re-asserts audio when it reads false.
    Function("isWebRtcAudioEnabled") { () -> Bool in
      RTCAudioSession.sharedInstance().isAudioEnabled
    }

    // Set once CallKit's didActivate fires, cleared once a call ends —
    // mirrors the JS-side markNextCallAsAnsweredViaCallKit/
    // clearCallKitAudioSessionWait pair so the native and JS halves of "does
    // CallKit currently own the session" never disagree.
    // Full audio-route snapshot for diagnostics.
    //
    // isWebRtcAudioEnabled alone is insufficient: real calls showed
    // connected, media-flowing, isAudioEnabled=true — and still no usable
    // sound, because the route itself was wrong (earpiece on a video call,
    // or no output port at all). This surfaces category, mode, ports,
    // volume and the session-active flags so a silent-but-connected call is
    // diagnosable from its trace instead of guessed at.
    Function("audioRouteSnapshot") { () -> [String: Any] in
      let session = AVAudioSession.sharedInstance()
      let rtcSession = RTCAudioSession.sharedInstance()
      let outputs = session.currentRoute.outputs.map { output -> [String: String] in
        ["portType": output.portType.rawValue, "portName": output.portName]
      }
      let inputs = session.currentRoute.inputs.map { input -> [String: String] in
        ["portType": input.portType.rawValue, "portName": input.portName]
      }
      return [
        "category": session.category.rawValue,
        "mode": session.mode.rawValue,
        "isOtherAudioPlaying": session.isOtherAudioPlaying,
        "outputVolume": session.outputVolume,
        "outputs": outputs,
        "inputs": inputs,
        "rtcIsAudioEnabled": rtcSession.isAudioEnabled,
        "rtcIsActive": rtcSession.isActive,
        "sessionSecondaryAudioShouldBeSilencedHint": session.secondaryAudioShouldBeSilencedHint,
      ]
    }

    // Last-resort route repair for a connected call with no sound.
    //
    // Every other path here is careful NOT to rebuild a route CallKit owns,
    // because doing so at the wrong moment is itself a cause of silence.
    // That caution is right in general — but it leaves no recovery for a
    // call that is ALREADY silent. Called only by the JS watchdog, and only
    // once it has read audioRouteSnapshot() and concluded the route is
    // genuinely unusable, at which point there is no working audio to
    // disturb.
    //
    // The caller states the route it wants rather than trusting
    // speakerEnabled: that flag records what the app last ASKED for, and the
    // reason this function exists is that the request did not take effect.
    Function("forceRepairAudioRoute") { (wantSpeaker: Bool) -> Bool in
      let session = AVAudioSession.sharedInstance()
      let rtcSession = RTCAudioSession.sharedInstance()
      SpeakerToggleModule.speakerEnabled = wantSpeaker
      rtcSession.lockForConfiguration()
      defer { rtcSession.unlockForConfiguration() }
      do {
        try session.setCategory(
          .playAndRecord,
          mode: wantSpeaker ? .videoChat : .voiceChat,
          options: wantSpeaker
            ? [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
            : [.allowBluetooth, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: [])
        if wantSpeaker {
          try session.overrideOutputAudioPort(.speaker)
        } else {
          try session.overrideOutputAudioPort(.none)
        }
        rtcSession.isAudioEnabled = true
        return true
      } catch {
        NSLog("[SpeakerToggle] forceRepairAudioRoute failed: \(error)")
        return false
      }
    }

    Function("setCallKitOwnsSession") { (owns: Bool) -> Void in
      SpeakerToggleModule.callKitOwnsSession = owns
      if !owns {
        // Reset on the way OUT too, not only on the way in.
        //
        // callKitAutoRouteApplied used to be cleared only when a call became
        // CallKit-owned. A call that ended while NOT CallKit-owned (an
        // outgoing call, or one where acquireMedia threw / permission was
        // denied before ownership was ever set) therefore left it true, and
        // the NEXT CallKit-owned call found its one allowed route correction
        // already spent — landing on the earpiece with no repair.
        //
        // speakerEnabled is reset here for the same reason: its only other
        // reset is resetAudioRoute(), which runs from useCall's 3s
        // auto-dismiss timer and is skipped entirely if the app is
        // backgrounded or another call starts first, leaking a video call's
        // loudspeaker preference into the next voice call.
        SpeakerToggleModule.callKitAutoRouteApplied = false
        SpeakerToggleModule.speakerEnabled = false
      }
      if owns {
        // A fresh CallKit-owned call gets its one automatic route
        // correction again (see callKitAutoRouteApplied's comment).
        SpeakerToggleModule.callKitAutoRouteApplied = false
      }
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
