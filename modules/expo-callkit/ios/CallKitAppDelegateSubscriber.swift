import CallKit
import ExpoModulesCore
import Foundation
import PushKit
import WebRTC

/// Registers for VoIP pushes as early in the app lifecycle as possible.
///
/// An ExpoAppDelegateSubscriber (the same pattern expo-notifications uses for
/// its own delegate) specifically so this runs without editing the generated
/// AppDelegate.swift — `expo prebuild` regenerates that file from scratch and
/// would silently discard any hand edit to it.
///
/// PKPushRegistry, unlike an ordinary remote-notification registration, is
/// what actually wakes the app from fully terminated: iOS launches the
/// process and calls `pushRegistry(_:didReceiveIncomingPushWith:for:)` before
/// any JS can run. That is why this path reports the incoming call directly
/// in Swift rather than round-tripping through the bridge — there may be no
/// bridge yet.
public class CallKitAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private var registry: PKPushRegistry?
  private let store = CallKitStore.shared

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    takeManualControlOfWebRtcAudio()

    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
    return true
  }

  /// Stops WebRTC from owning AVAudioSession, before anything can start a
  /// call.
  ///
  /// This is the fix for "answer from CallKit, call connects, total silence".
  /// By default `RTCAudioSession.useManualAudio` is NO, which means WebRTC's
  /// audio device module owns the session: when a track starts it takes its
  /// own configuration lock, applies its own category, and calls
  /// `setActive(true)` — asynchronously, on the audio worker thread, AFTER
  /// the JS `await getUserMedia` has already resolved. Every attempt to fix
  /// that from JS, or by pre-setting the category, lost a race it could not
  /// even observe: CallKit handed over an activated session and WebRTC then
  /// rebuilt the route underneath it, leaving the voice-processing unit bound
  /// to a route that no longer existed.
  ///
  /// With manual audio, WebRTC never touches activation on its own. Audio is
  /// enabled explicitly — from CallKit's `didActivate` for CallKit calls, and
  /// from `enableWebRtcAudio()` for outgoing / in-app-answered ones.
  ///
  /// Done at launch rather than per call because a PushKit cold launch
  /// reaches `didActivate` before any JS exists to configure it.
  private func takeManualControlOfWebRtcAudio() {
    let session = RTCAudioSession.sharedInstance()
    session.useManualAudio = true
    session.isAudioEnabled = false
  }
}

extension CallKitAppDelegateSubscriber: PKPushRegistryDelegate {
  public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()

    // Stored because the bridge may not exist yet (the app can be launched
    // purely for push registration, before the user ever opened it), and
    // there is no reliable "wait for the bridge" hook this early.
    store.persistVoipToken(token)

    // Emitted as well. Storing alone is not enough: useCallManager reads the
    // stored value ONCE, from an effect that frequently runs before PushKit
    // has delivered the token — and that read clears it. The token was then
    // gone until iOS next issued one, which for an existing install can take
    // a very long time. That is why a freshly reinstalled app could stop
    // ringing entirely: the database kept a token the reinstall had already
    // invalidated.
    CallKitDelegate.shared.emitVoipToken(token)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    store.clearVoipToken()
  }

  /// The incoming-call wakeup.
  ///
  /// iOS requires `reportNewIncomingCall` to be called synchronously from
  /// within this method — Apple enforces it, and an app that takes a VoIP
  /// push without immediately reporting a call to CallKit gets killed. That
  /// is the "PushKit misuse" rejection risk, so every branch below reports
  /// something, even a malformed payload.
  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }

    let data = payload.dictionaryPayload
    let callerName = data["callerName"] as? String ?? "Televo"
    let hasVideo = (data["kind"] as? String) == "video"

    guard
      let callId = data["callId"] as? String,
      let callUUID = UUID(uuidString: callId)
    else {
      reportUnidentifiedCall(callerName: callerName, completion: completion)
      return
    }

    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerName)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    // Carried in the push so useCallManager can find the matching call row
    // once JS starts, instead of needing a synchronous round trip back into
    // Swift for it.
    let conversationId = data["conversationId"] as? String

    CallKitProvider.shared().reportNewIncomingCall(with: callUUID, update: update) { error in
      if let error {
        NSLog("[CallKit] reportNewIncomingCall failed for call \(callId): \(error)")
      } else if let conversationId {
        // Written only AFTER CallKit accepts the report. APNs retries VoIP
        // pushes, and a duplicate delivery for a call that was already
        // answered and finished is refused here with a duplicate-UUID error
        // — but this record used to be written regardless, so the retry
        // silently resurrected the finished call, and the next foregrounding
        // consumed it and tore down the signalling channel of the call
        // actually in progress.
        self.store.persistPendingIncomingCall(callId: callId, conversationId: conversationId)
      }
      completion()
    }
  }

  /// Reports a placeholder call for a push whose payload could not be
  /// parsed. It can never be answered meaningfully (JS has no matching call
  /// row to look up), but reporting *something* is what keeps this path
  /// compliant with PushKit's contract instead of getting the app killed.
  private func reportUnidentifiedCall(callerName: String, completion: @escaping () -> Void) {
    let update = CXCallUpdate()
    update.localizedCallerName = callerName
    CallKitProvider.shared().reportNewIncomingCall(with: UUID(), update: update) { error in
      if let error {
        NSLog("[CallKit] reportNewIncomingCall (malformed payload) failed: \(error)")
      }
      completion()
    }
  }
}
