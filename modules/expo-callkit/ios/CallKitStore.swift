import Foundation

/// UserDefaults keys that carry a call across a process boundary.
///
/// A VoIP push can launch this app from terminated, run CallKit's answer
/// action, and be killed again — all before any JavaScript exists. Events
/// emitted into a dead bridge reach nobody, so every such action is ALSO
/// written here, and JS drains these on startup.
enum CallKitStorageKey {
  static let pendingVoipToken = "televo.callkit.pendingVoipToken"
  static let pendingIncomingCall = "televo.callkit.pendingIncomingCall"
  static let answeredCall = "televo.callkit.answeredCall"
}

/// All mutable CallKit state, behind one lock.
///
/// Two threads touch this concurrently and always have: Expo `Function`
/// bodies run on the JS thread, while `CXProviderDelegate` callbacks arrive
/// on the main queue. Keeping every field private and reachable only through
/// the methods below means a caller cannot accidentally read one unguarded —
/// the previous design exposed the flags directly and relied on each call
/// site remembering to take the lock.
final class CallKitStore {
  static let shared = CallKitStore()

  private let lock = NSLock()

  /// Calls answered from INSIDE the app. `reportIncomingCallAnswered`
  /// requests a CXAnswerCallAction purely to move CallKit's own UI out of
  /// "ringing" — that action must not be forwarded back to JS as if the user
  /// had tapped Answer on the system screen, or JS rebuilds a peer
  /// connection over the live one and the call dies on answer.
  private var answeredInApp = Set<UUID>()

  /// Calls answered from CallKit's OWN system UI. Kept so a late-arriving
  /// in-app `reportIncomingCallAnswered` for the same call cannot arm the
  /// `answeredInApp` suppression above and swallow a real answer.
  private var answeredInCallKitUI = Set<UUID>()

  /// Calls whose pending mute action came from the in-app mute button.
  /// Consumed (removed) rather than merely checked: mute is toggled many
  /// times per call, and each in-app toggle must suppress exactly the one
  /// CXSetMutedCallAction it caused.
  private var mutedInApp = Set<UUID>()

  /// True between CallKit's `didActivate` and `didDeactivate`.
  ///
  /// Exposed as readable STATE, not just the one-shot `onAudioSessionActivated`
  /// event, because that event fires when CallKit activates the session —
  /// routinely before JS has subscribed to it. A subscriber even slightly
  /// late misses it permanently and falls through to a timeout that assumes
  /// CallKit was never involved, which is the intermittent "answer from the
  /// lock screen, call connects, total silence" bug.
  private var audioSessionActive = false

  /// Calls CallKit currently considers live on this device.
  ///
  /// Exists so didDeactivate can tell a genuine end-of-call teardown from a
  /// transient session handover. iOS pairs each didActivate with a matching
  /// didDeactivate, and for an OUTGOING call didActivate fires twice (see
  /// CallKitDelegate) — so the first session gets handed back while the call
  /// is still live. didDeactivate used to disable WebRTC's audio unit
  /// unconditionally, which killed the mic and speaker a few seconds into a
  /// call that was otherwise perfectly connected: audio for the first
  /// moments, then silence.
  private var liveCalls = Set<UUID>()

  var hasLiveCall: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !liveCalls.isEmpty
  }

  func markCallLive(_ uuid: UUID) {
    lock.lock()
    defer { lock.unlock() }
    liveCalls.insert(uuid)
  }

  var isAudioSessionActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return audioSessionActive
  }

  func setAudioSessionActive(_ active: Bool) {
    lock.lock()
    defer { lock.unlock() }
    audioSessionActive = active
  }

  // MARK: Answer bookkeeping

  func markAnsweredInApp(_ uuid: UUID) {
    lock.lock()
    defer { lock.unlock() }
    // If CallKit's UI already answered this call, an in-app report is stale
    // bookkeeping arriving late — recording it would suppress a genuine
    // CXAnswerCallAction that still needs to reach JS.
    guard !answeredInCallKitUI.contains(uuid) else { return }
    answeredInApp.insert(uuid)
  }

  func clearAnsweredInApp(_ uuid: UUID) {
    lock.lock()
    defer { lock.unlock() }
    answeredInApp.remove(uuid)
  }

  /// Returns true if this answer action was caused by the app itself, and
  /// consumes that record. Single locked read-modify-write: checking and
  /// then clearing as two calls would let a second answer action slip
  /// between them.
  func consumeAnsweredInApp(_ uuid: UUID) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return answeredInApp.remove(uuid) != nil
  }

  func markAnsweredInCallKitUI(_ uuid: UUID) {
    lock.lock()
    defer { lock.unlock() }
    answeredInCallKitUI.insert(uuid)
  }

  // MARK: Mute bookkeeping

  func markMutedInApp(_ uuid: UUID) {
    lock.lock()
    defer { lock.unlock() }
    mutedInApp.insert(uuid)
  }

  func clearMutedInApp(_ uuid: UUID) {
    lock.lock()
    defer { lock.unlock() }
    mutedInApp.remove(uuid)
  }

  func consumeMutedInApp(_ uuid: UUID) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return mutedInApp.remove(uuid) != nil
  }

  // MARK: Forgetting a call

  /// Drops only the in-memory records for one call.
  ///
  /// This is what the JS `endCall` path needs. `endCall` uses
  /// `CXProvider.reportCall(with:endedAt:reason:)`, which does NOT run the
  /// delegate's `CXEndCallAction` handler (that fires only for a hangup
  /// started from CallKit's own UI) — so without this, nothing bounds these
  /// sets on the most common case of all: the other party hanging up.
  ///
  /// Deliberately leaves UserDefaults alone: `endCall` can run while a
  /// cold-launch answer is still in flight toward `consumeAnsweredCall`, and
  /// clearing the persisted record here would destroy the only copy of it.
  func forgetInMemory(_ uuid: UUID) {
    lock.lock()
    defer { lock.unlock() }
    answeredInApp.remove(uuid)
    answeredInCallKitUI.remove(uuid)
    mutedInApp.remove(uuid)
    liveCalls.remove(uuid)

    // Clearing the audio-session flag here is what makes calls after the
    // FIRST one audible again.
    //
    // audioSessionActive is set in didActivate and cleared in
    // didDeactivate — but didDeactivate is not guaranteed: when the remote
    // party hangs up, the call ends via reportCall(with:endedAt:), which
    // does not route through the delegate at all, so iOS may never send a
    // deactivation for it. The flag then stayed true for the rest of the
    // process, and waitForCallKitAudioSession (WebRtcBridge.tsx) reads it
    // as "CallKit already owns the session" on the NEXT call. acquireMedia
    // therefore skipped its own enableWebRtcAudio(true), waiting for a
    // didActivate that never comes for a call CallKit considers already
    // handled — and with useManualAudio = true, nothing else turns the
    // audio unit on. Result: the connection is perfect (relay candidate,
    // RTP flowing, video visible) and there is no sound at all, which is
    // exactly the "I can see but I can't hear" report.
    //
    // Both end paths converge here (forgetEverywhere calls this), so one
    // reset covers a hangup from CallKit's UI and one reported by the app.
    audioSessionActive = false
  }

  /// Full forget, persisted records included. Only correct when the user
  /// genuinely ended the call from CallKit's own UI — after that there is no
  /// pending answer for JS to reconnect to, and a leftover record would make
  /// the next foregrounding try to rejoin a call that is already over.
  func forgetEverywhere(_ uuid: UUID) {
    forgetInMemory(uuid)

    // Lowercased on both sides. Stored values are written lowercased (see
    // CallKitDelegate), while Foundation's `uuidString` is always uppercase
    // — comparing them raw never matches, so a stale record would survive.
    let lowered = uuid.uuidString.lowercased()
    let defaults = UserDefaults.standard

    if defaults.string(forKey: CallKitStorageKey.answeredCall) == lowered {
      defaults.removeObject(forKey: CallKitStorageKey.answeredCall)
    }
    if let pending = defaults.dictionary(forKey: CallKitStorageKey.pendingIncomingCall)
      as? [String: String],
      pending["callId"]?.lowercased() == lowered
    {
      defaults.removeObject(forKey: CallKitStorageKey.pendingIncomingCall)
    }
  }

  func reset() {
    lock.lock()
    answeredInApp.removeAll()
    answeredInCallKitUI.removeAll()
    mutedInApp.removeAll()
    liveCalls.removeAll()
    audioSessionActive = false
    lock.unlock()

    UserDefaults.standard.removeObject(forKey: CallKitStorageKey.answeredCall)
    UserDefaults.standard.removeObject(forKey: CallKitStorageKey.pendingIncomingCall)
  }

  // MARK: Persisted records drained by JS on startup

  func persistAnsweredCall(_ uuid: UUID) {
    UserDefaults.standard.set(
      uuid.uuidString.lowercased(), forKey: CallKitStorageKey.answeredCall)
    // A PushKit cold launch runs on a short budget and can be killed moments
    // from now, before the automatic write-back would have run.
    UserDefaults.standard.synchronize()
  }

  func consumeAnsweredCall() -> String? {
    let value = UserDefaults.standard.string(forKey: CallKitStorageKey.answeredCall)
    UserDefaults.standard.removeObject(forKey: CallKitStorageKey.answeredCall)
    return value
  }

  func persistPendingIncomingCall(callId: String, conversationId: String) {
    UserDefaults.standard.set(
      ["callId": callId, "conversationId": conversationId],
      forKey: CallKitStorageKey.pendingIncomingCall
    )
    UserDefaults.standard.synchronize()
  }

  func consumePendingIncomingCall() -> [String: String]? {
    guard
      let pending = UserDefaults.standard.dictionary(forKey: CallKitStorageKey.pendingIncomingCall)
        as? [String: String]
    else { return nil }
    UserDefaults.standard.removeObject(forKey: CallKitStorageKey.pendingIncomingCall)
    return pending
  }

  func persistVoipToken(_ token: String) {
    UserDefaults.standard.set(token, forKey: CallKitStorageKey.pendingVoipToken)
  }

  func peekVoipToken() -> String? {
    UserDefaults.standard.string(forKey: CallKitStorageKey.pendingVoipToken)
  }

  func consumeVoipToken() -> String? {
    let token = UserDefaults.standard.string(forKey: CallKitStorageKey.pendingVoipToken)
    // Cleared on read: PushKit re-delivers the token unprompted on every
    // launch, so nothing is lost — and leaving it meant two accounts sharing
    // one phone took ownership back and forth on every relaunch, with
    // whichever lost simply never ringing again.
    UserDefaults.standard.removeObject(forKey: CallKitStorageKey.pendingVoipToken)
    return token
  }

  func clearVoipToken() {
    UserDefaults.standard.removeObject(forKey: CallKitStorageKey.pendingVoipToken)
  }
}
