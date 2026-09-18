import CallKit
import ExpoModulesCore
import Foundation

/// The JS-facing surface of CallKit: Functions and Events, nothing else.
///
/// All behaviour lives elsewhere on purpose — CallKitDelegate owns the
/// CXProviderDelegate callbacks and the audio-session handoff, CallKitStore
/// owns every piece of mutable state. This class only translates between
/// JavaScript and those two, so the parts that must keep working with no JS
/// alive (a PushKit cold launch) have no dependency on it existing.
public class CallKitModule: Module, CallKitEventSink {
  private let callController = CXCallController()
  private let store = CallKitStore.shared

  public func definition() -> ModuleDefinition {
    Name("CallKit")

    Events(
      "onAnswerCall",
      "onEndCall",
      "onMuteChanged",
      "onAudioSessionActivated",
      "onVoipToken",
      "onProviderReset"
    )

    OnCreate {
      // Force the provider (and therefore its delegate) into existence, and
      // register as the current event target. CallKitDelegate looks this up
      // lazily rather than holding a permanent reference, so a JS reload
      // that recreates the module takes over event delivery cleanly.
      _ = CallKitProvider.shared()
      CallKitDelegate.shared.attach(self)

      // A VoIP token issued before this bridge existed is still sitting in
      // storage — the live PushKit event fired into nothing. Replay it, or a
      // reinstalled app keeps advertising a token iOS already invalidated
      // and simply never rings again.
      //
      // Peeked, not consumed: `consumePendingVoipToken` is a separate
      // explicit call JS makes when it is ready to own the value. Clearing
      // it here would race that read and lose the token entirely.
      if let stored = self.store.peekVoipToken() {
        self.sendEvent("onVoipToken", ["token": stored])
      }
    }

    OnDestroy {
      CallKitDelegate.shared.detach(self)
    }

    // MARK: Cold-launch records

    Function("consumePendingVoipToken") { () -> String? in
      self.store.consumeVoipToken()
    }

    Function("consumeAnsweredCall") { () -> String? in
      self.store.consumeAnsweredCall()
    }

    Function("consumePendingIncomingCall") { () -> [String: String]? in
      self.store.consumePendingIncomingCall()
    }

    // MARK: Audio session state

    Function("isCallKitAudioSessionActive") { () -> Bool in
      self.store.isAudioSessionActive
    }

    // MARK: Reporting calls to CallKit

    Function("reportIncomingCall") { (uuid: String, displayName: String, hasVideo: Bool) in
      guard let callUUID = UUID(uuidString: uuid) else { return }
      let update = CXCallUpdate()
      update.remoteHandle = CXHandle(type: .generic, value: displayName)
      update.localizedCallerName = displayName
      update.hasVideo = hasVideo
      update.supportsHolding = false
      update.supportsGrouping = false
      update.supportsUngrouping = false
      update.supportsDTMF = false

      CallKitProvider.shared().reportNewIncomingCall(with: callUUID, update: update) { error in
        if let error {
          // CallKit can refuse a report (rate-limited after prior
          // over-reporting, or a duplicate UUID) with no other signal
          // anywhere in this pipeline. Logging it is the only way a "no
          // CallKit screen appeared" report is not a dead end.
          NSLog("[CallKit] reportNewIncomingCall failed: \(error)")
        }
      }
    }

    Function("reportIncomingCallAnswered") { (uuid: String) in
      guard let callUUID = UUID(uuidString: uuid) else { return }
      // Recorded BEFORE requesting the action: the delegate can run the
      // resulting CXAnswerCallAction before this closure returns, and it
      // must find the record already there to know the answer came from the
      // app rather than the system UI.
      self.store.markAnsweredInApp(callUUID)
      let action = CXAnswerCallAction(call: callUUID)
      self.callController.request(CXTransaction(action: action)) { error in
        if error != nil {
          // The action never ran, so nothing will consume the record —
          // leaving it armed would suppress a genuine CallKit-UI answer for
          // this same call later.
          self.store.clearAnsweredInApp(callUUID)
        }
      }
    }

    Function("reportOutgoingCallStarted") { (uuid: String, displayName: String) in
      guard let callUUID = UUID(uuidString: uuid) else { return }
      let handle = CXHandle(type: .generic, value: displayName)
      let action = CXStartCallAction(call: callUUID, handle: handle)
      self.callController.request(CXTransaction(action: action)) { error in
        if let error {
          NSLog("[CallKit] reportOutgoingCallStarted failed: \(error)")
        }
      }
    }

    Function("reportOutgoingCallConnected") { (uuid: String) in
      guard let callUUID = UUID(uuidString: uuid) else { return }
      CallKitProvider.shared().reportOutgoingCall(with: callUUID, connectedAt: nil)
    }

    Function("reportMuteState") { (uuid: String, muted: Bool) in
      guard let callUUID = UUID(uuidString: uuid) else { return }
      // Same ordering requirement as reportIncomingCallAnswered above.
      self.store.markMutedInApp(callUUID)
      let action = CXSetMutedCallAction(call: callUUID, muted: muted)
      self.callController.request(CXTransaction(action: action)) { error in
        if error != nil {
          self.store.clearMutedInApp(callUUID)
        }
      }
    }

    Function("endCall") { (uuid: String, reason: String) in
      guard let callUUID = UUID(uuidString: uuid) else { return }

      let endReason: CXCallEndedReason
      switch reason {
      case "declined": endReason = .declinedElsewhere
      case "failed": endReason = .failed
      case "missed": endReason = .unanswered
      default: endReason = .remoteEnded
      }

      CallKitProvider.shared().reportCall(with: callUUID, endedAt: nil, reason: endReason)

      // reportCall does not route through the delegate's CXEndCallAction
      // handler — that fires only for a hangup started FROM CallKit's own UI
      // — so nothing else prunes the store on this path, which is the one
      // taken every time the OTHER party ends the call. In-memory only: a
      // cold-launch answer may still be in flight toward
      // consumeAnsweredCall, and clearing the persisted record here would
      // destroy the only copy of it.
      self.store.forgetInMemory(callUUID)
    }
  }

  // MARK: CallKitEventSink

  func emitCallKitEvent(_ name: String, _ payload: [String: Any]) {
    sendEvent(name, payload)
  }
}
