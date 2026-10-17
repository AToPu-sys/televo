import Foundation
import Security
import UserNotifications

/// Shows the real text of Secret Chat pushes.
///
/// send-push-notification sends those with generic text ("sent a message")
/// plus the message's E2E envelope — the same ciphertext the server stores
/// and cannot read. This extension opens it on the phone with the
/// conversation's session key, which the app copies into a keychain group
/// shared with this target (src/lib/notificationKeys.ts). Any failure — no
/// key shared yet, keychain still locked after a reboot, a tampered envelope
/// — leaves the generic text in place. Also groups every chat's pushes into
/// its own thread in Notification Center.
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    original = request.content
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      finish(with: request.content)
      return
    }

    let data = Self.televoData(from: request.content.userInfo)
    if let conversationId = data["conversationId"] as? String {
      content.threadIdentifier = conversationId
      if let envelope = data["e2e"] as? String,
         let text = Self.decrypt(envelope: envelope, conversationId: conversationId) {
        content.body = ((data["e2ePrefix"] as? String) ?? "") + text
      }
    }
    finish(with: content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let original {
      finish(with: original)
    }
  }

  private func finish(with content: UNNotificationContent) {
    contentHandler?(content)
    contentHandler = nil
  }

  /// The sender's `data` object. Expo's push service puts it under "body" in
  /// the APNs payload (a dictionary, or a JSON string on some versions).
  private static func televoData(from userInfo: [AnyHashable: Any]) -> [String: Any] {
    if let body = userInfo["body"] as? [String: Any] {
      return body
    }
    if let body = userInfo["body"] as? String,
       let json = body.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: json) as? [String: Any] {
      return parsed
    }
    var flat: [String: Any] = [:]
    for (key, value) in userInfo {
      if let key = key as? String { flat[key] = value }
    }
    return flat
  }

  /// Opens a serialized envelope ({"ciphertext","nonce"}, base64 — see
  /// serializeEnvelope in src/lib/e2e.ts) with the conversation's key.
  private static func decrypt(envelope: String, conversationId: String) -> String? {
    guard let json = envelope.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
          let ciphertextB64 = parsed["ciphertext"] as? String,
          let nonceB64 = parsed["nonce"] as? String,
          let ciphertext = Data(base64Encoded: ciphertextB64),
          let nonce = Data(base64Encoded: nonceB64),
          let key = sessionKey(for: conversationId),
          let plaintext = SecretBox.open(ciphertext, nonce: nonce, key: key) else {
      return nil
    }
    return String(data: plaintext, encoding: .utf8)
  }

  /// Reads the item the app wrote with expo-secure-store: service
  /// "televo.nse" + ":no-auth", account and generic = the key name's UTF-8
  /// bytes, value = the base64 session key as UTF-8.
  private static func sessionKey(for conversationId: String) -> Data? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "TelevoSharedKeychainGroup") as? String else {
      return nil
    }
    let account = Data("nse.sk.\(conversationId)".utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "televo.nse:no-auth",
      kSecAttrAccount as String: account,
      kSecAttrGeneric as String: account,
      kSecAttrAccessGroup as String: group,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let stored = result as? Data,
          let encoded = String(data: stored, encoding: .utf8),
          let key = Data(base64Encoded: encoded),
          key.count == SecretBox.keyLength else {
      return nil
    }
    return key
  }
}
