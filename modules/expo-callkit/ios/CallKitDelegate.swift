import AVFoundation
import CallKit
import Foundation
import WebRTC

/// Anything that can deliver a CallKit event to JavaScript.
///
/// The delegate talks to this rather than to CallKitModule directly so it
/// holds no opinion about Expo at all: on a PushKit cold launch there is no
/// module, no bridge and no JS, and every path below has to keep working
/// anyway (by persisting through CallKitStore instead).
protocol CallKitEventSink: AnyObject {
  func emitCallKitEvent(_ name: String, _ payload: [String: Any])
}

/// The CXProviderDelegate: everything CallKit itself drives.
///
/// A process-wide singleton, not tied to a module instance, because a VoIP
/// push can reach `reportNewIncomingCall` before Expo has constructed any
/// module — and CallKit only ever delivers an answer action to whichever
/// delegate was attached when the user tapped Answer.
///
/// Must be NSObject: CXProviderDelegate requires it, and an Expo `Module`
/// cannot conform.
final class CallKitDelegate: NSObject, CXProviderDelegate {
  static let shared = CallKitDelegate()

  private let store = CallKitStore.shared

  /// Weak: CallKit retains this delegate for the provider's whole lifetime,
  /// while the module belongs to Expo's registry. A strong reference would
  /// pin a torn-down module and its dead bridge in memory. `nil` simply
  /// means "no JS to tell right now" — which is precisely why every action
  /// here is also persisted.
  private weak var sink: CallKitEventSink?

  private override init() {
    super.init()
    // Diagnostic only — added 2026-09-21 while chasing calls that connect,
    // report audio flowing for several seconds, and then produce no new RTP
    // with no route/session/ICE event anywhere in the trace to explain it.
    //
    // The one thing that CAN silently stop a live AVAudioSession without
    // touching isAudioEnabled, the track's enabled/readyState/muted flags,
    // or firing CXProviderDelegate's own didDeactivate is a system audio
    // interruption: another app requesting audio, Siri, a system alert
    // sound, a real phone call. WebRTC.framework's RTCAudioSession
    // subscribes to this notification internally and may or may not
    // reactivate afterward depending on iOS's own arbitration — but nothing
    // in this app was listening for it, so if that is what happened here it
    // was completely invisible in call_diagnostics. This makes it visible.
    NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: nil
    ) { [weak self] notification in
      guard
        let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: typeValue)
      else { return }
      let reasonValue = notification.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
      let wasSuspended =
        (notification.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool) ?? false
      let shouldResume =
        type == .ended
          && (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map {
            AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume)
          } ?? false
      self?.sink?.emitCallKitEvent(
        "onAudioSessionInterruption",
        [
          "type": type == .began ? "began" : "ended",
          "reason": reasonValue.map(String.init) ?? "unknown",
          "wasSuspended": wasSuspended,
          "shouldResume": shouldResume,
        ]
      )
    }
  }

  func attach(_ sink: CallKitEventSink) {
    self.sink = sink
  }

  func detach(_ sink: CallKitEventSink) {
    if self.sink === sink { self.sink = nil }
  }

  func emitVoipToken(_ token: String) {
    sink?.emitCallKitEvent("onVoipToken", ["token": token])
  }

  // MARK: Audio session

  /// Puts the shared audio session into a two-way call configuration before
  /// CallKit activates it.
  ///
  /// CallKit activates the session immediately after `fulfill()` and hands
  /// it over via `didActivate`. A session still in the ringtone's
  /// playback-only category at that moment yields a call that negotiates
  /// perfectly and carries no audio in either direction. Configured THROUGH
  /// RTCAudioSession, not a bare `AVAudioSession.setCategory`, so WebRTC's
  /// own view of the configuration agrees and it doesn't quietly revert it.
  private func configureAudioSessionForCall() {
    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    defer { session.unlockForConfiguration() }
    do {
      let config = RTCAudioSessionConfiguration.webRTC()
      config.category = AVAudioSession.Category.playAndRecord.rawValue
      config.mode = AVAudioSession.Mode.voiceChat.rawValue
      config.categoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
      try session.setConfiguration(config)
    } catch {
      // Non-fatal: WebRtcBridge re-declares the session before opening the
      // mic, so a failure here costs setup latency, not the call.
      NSLog("[CallKit] audio session configuration failed: \(error)")
    }
  }

  // MARK: CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    // The system tore down every call this provider tracked. Persisted
    // records have to go with them — they would otherwise name calls CallKit
    // no longer knows about — and JS must hear about it directly, since a
    // call the app still believes is active would hold the mic open with no
    // way to hang up.
    store.reset()
    RTCAudioSession.sharedInstance().isAudioEnabled = false
    sink?.emitCallKitEvent("onProviderReset", [:])
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    if store.consumeAnsweredInApp(action.callUUID) {
      // Live for didDeactivate's purposes either way — an in-app answer is
      // still a call whose audio must survive a transient session handover.
      store.markCallLive(action.callUUID)
      // Answered inside the app; this action exists only to move CallKit's
      // own UI out of ringing. Fulfil silently — telling JS again would make
      // it answer a second time, rebuilding the peer connection over the one
      // already negotiating.
      action.fulfill()
      return
    }

    configureAudioSessionForCall()

    let lowered = action.callUUID.uuidString.lowercased()
    // Persisted as well as emitted: answering from the lock screen on a
    // terminated app runs this before any JS exists, so the emit reaches
    // nobody and the stored record is the only thing that survives.
    store.persistAnsweredCall(action.callUUID)
    store.markAnsweredInCallKitUI(action.callUUID)
    store.markCallLive(action.callUUID)

    // fulfil() BEFORE emit, deliberately. CallKit allows a delegate only a
    // few seconds to fulfil an action and hard-fails the call otherwise,
    // while `emit` reaches into a bridge that may be mid-launch, torn down,
    // or absent. Fulfilling first makes the answer succeed regardless of
    // whether JS is alive at all.
    action.fulfill()
    sink?.emitCallKitEvent("onAnswerCall", ["uuid": lowered])
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    // Declined or hung up from CallKit's own UI, possibly before JS exists.
    // Clearing the persisted answer matters specifically here: without it,
    // answering and immediately hanging up from the lock screen leaves a
    // stale record that the next foregrounding tries to reconnect to.
    store.forgetEverywhere(action.callUUID)
    action.fulfill()
    sink?.emitCallKitEvent(
      "onEndCall", ["uuid": action.callUUID.uuidString.lowercased()])
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    let wasInApp = store.consumeMutedInApp(action.callUUID)
    action.fulfill()
    // This device's own mute button caused the action purely to update
    // CallKit's displayed state — JS already knows, since JS caused it.
    guard !wasInApp else { return }
    sink?.emitCallKitEvent(
      "onMuteChanged",
      ["uuid": action.callUUID.uuidString.lowercased(), "muted": action.isMuted]
    )
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    // Without this handler CallKit has nowhere to deliver the action
    // requested by reportOutgoingCallStarted: it times the action out and
    // the call becomes invisible to CallKit from then on — no Recents entry,
    // no lock-screen "call in progress" UI, and reportOutgoingCallConnected
    // / endCall for this uuid silently do nothing afterwards.
    configureAudioSessionForCall()
    store.markCallLive(action.callUUID)
    action.fulfill()
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
  }

  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    // .fail(), never .fulfill(): CallKit has already given up. Reporting
    // success would strand the system call screen in a permanently
    // "connected" state that nothing backs and the user cannot end.
    NSLog("[CallKit] action timed out: \(action)")
    action.fail()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    // REVERTED 2026-09-20 along with useManualAudio (see
    // CallKitAppDelegateSubscriber.takeManualControlOfWebRtcAudio).
    //
    // This used to hand the session to RTCAudioSession explicitly —
    // session.audioSessionDidActivate(audioSession) + isAudioEnabled = true
    // — because with manual audio WebRTC's unit would otherwise never turn
    // on. With manual audio OFF, RTCAudioSession manages activation itself
    // as soon as a track needs it. Calling audioSessionDidActivate here too
    // meant TWO activations racing for the same session on a call already
    // carrying live audio: WebRTC had already activated its own session and
    // started sending RTP, and this handover re-activated/rebuilt the
    // route out from under that already-live audio unit — which is exactly
    // the "I can hear them for about a second, then nothing" report,
    // confirmed by call_diagnostics showing audioPkts=1 on the caller leg
    // of a call whose other leg received 47 packets normally.
    //
    // Only bookkeeping remains: CallKit still needs to know a session is
    // active for its own state, and JS still gets the event for anything
    // that reads it (e.g. UI).
    store.setAudioSessionActive(true)
    sink?.emitCallKitEvent("onAudioSessionActivated", [:])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    // Mirror of didActivate — see its comment. No longer touches
    // RTCAudioSession.isAudioEnabled or calls audioSessionDidDeactivate:
    // with manual audio off, WebRTC's own audio session lifecycle handles
    // deactivation, and forcing isAudioEnabled = false here could silence a
    // still-live call the same way the activate-side double-handover did.
    store.setAudioSessionActive(false)
  }
}

/// Owns the single process-wide CXProvider.
///
/// CallKit tracks calls per provider, so every path that talks to it — a
/// live JS bridge, or a PushKit cold launch with no JS yet — must resolve to
/// the SAME instance, or a call reported through one is invisible to the
/// other.
enum CallKitProvider {
  private static var instance: CXProvider?

  static func shared() -> CXProvider {
    if let instance { return instance }

    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = true
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]

    let provider = CXProvider(configuration: configuration)
    // The delegate is attached at creation, never later: CallKit delivers a
    // CXAnswerCallAction only to whichever delegate was set when the user
    // tapped Answer, and never replays it to one attached afterwards. A
    // provider left delegate-less even briefly could report a call that is
    // then impossible to answer.
    provider.setDelegate(CallKitDelegate.shared, queue: nil)
    instance = provider
    return provider
  }
}
