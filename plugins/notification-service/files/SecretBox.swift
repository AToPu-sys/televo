import Foundation

/// nacl.secretbox.open (XSalsa20-Poly1305) — the inverse of the tweetnacl-js
/// nacl.secretbox that src/lib/e2e.ts encrypts Secret Chat messages with,
/// via the C TweetNaCl both libraries come from.
enum SecretBox {
  static let keyLength = 32
  static let nonceLength = 24
  private static let boxZeroBytes = 16 // crypto_secretbox_BOXZEROBYTES
  private static let zeroBytes = 32 // crypto_secretbox_ZEROBYTES

  /// nil when the key or nonce is malformed, or the box was not sealed with
  /// this key (Poly1305 authentication fails).
  static func open(_ box: Data, nonce: Data, key: Data) -> Data? {
    guard key.count == keyLength, nonce.count == nonceLength, box.count >= 16 else { return nil }
    // The C API wants 16 zero bytes in front of the box and returns 32 zero
    // bytes in front of the plaintext; tweetnacl-js strips both.
    let padded = Data(count: boxZeroBytes) + box
    var out = Data(count: padded.count)
    let status = out.withUnsafeMutableBytes { m in
      padded.withUnsafeBytes { c in
        nonce.withUnsafeBytes { n in
          key.withUnsafeBytes { k in
            crypto_secretbox_xsalsa20poly1305_tweet_open(
              m.bindMemory(to: UInt8.self).baseAddress,
              c.bindMemory(to: UInt8.self).baseAddress,
              UInt64(padded.count),
              n.bindMemory(to: UInt8.self).baseAddress,
              k.bindMemory(to: UInt8.self).baseAddress
            )
          }
        }
      }
    }
    guard status == 0 else { return nil }
    return out.subdata(in: zeroBytes..<out.count)
  }
}
