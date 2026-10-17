import CryptoKit
import ExpoModulesCore
import Foundation

/// ML-KEM-768 (FIPS 203) from Apple's CryptoKit, available from iOS 26.
///
/// src/lib/e2e.ts uses it in place of the pure-JavaScript crystals-kyber-js
/// for the post-quantum half of Secret Chat key wraps and call signalling.
/// Same standard, byte-for-byte compatible keys and ciphertexts (checked
/// both ways against crystals-kyber-js), but Apple's constant-time native
/// implementation instead of JavaScript on the Hermes thread.
///
/// Private keys cross the bridge only as their 64-byte FIPS 203 seed (d‖z):
/// that is the one private form CryptoKit can import. Older Televo keys that
/// exist only as the expanded 2400-byte secret key stay on the JS path.
public class TelevoCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TelevoCrypto")

    Function("isMLKEMAvailable") { () -> Bool in
      if #available(iOS 26.0, *) {
        return true
      }
      return false
    }

    Function("mlkem768Encapsulate") { (publicKey: String) throws -> [String: String] in
      guard #available(iOS 26.0, *) else {
        throw MLKEMUnavailableException()
      }
      guard let raw = Data(base64Encoded: publicKey) else {
        throw InvalidBase64Exception("publicKey")
      }
      let result = try MLKEM768.PublicKey(rawRepresentation: raw).encapsulate()
      return [
        "ciphertext": result.encapsulated.base64EncodedString(),
        "sharedSecret": result.sharedSecret.withUnsafeBytes { Data($0) }.base64EncodedString(),
      ]
    }

    // nacl.secretbox in C (TelevoSecretBox.c: word-wise Salsa20 and 64-bit
    // Poly1305, ~700 MB/s on Apple silicon), for Secret Chat photos, videos,
    // voice notes and files. Byte-compatible with tweetnacl-js; runs off the
    // JS thread, so a large file no longer freezes the interface while it is
    // sealed or opened.
    AsyncFunction("secretboxSeal") { (message: Data, nonce: Data, key: Data) throws -> Data in
      guard nonce.count == 24, key.count == 32 else { throw SecretBoxException() }
      var out = Data(count: message.count + 16)
      let status = out.withUnsafeMutableBytes { o in
        message.withUnsafeBytes { m in
          nonce.withUnsafeBytes { n in
            key.withUnsafeBytes { k in
              televo_secretbox_seal(
                o.bindMemory(to: UInt8.self).baseAddress,
                m.count > 0 ? m.bindMemory(to: UInt8.self).baseAddress : Self.emptyInput,
                UInt64(m.count),
                n.bindMemory(to: UInt8.self).baseAddress,
                k.bindMemory(to: UInt8.self).baseAddress
              )
            }
          }
        }
      }
      guard status == 0 else { throw SecretBoxException() }
      return out
    }

    // nil when the key is wrong or the data was tampered with.
    AsyncFunction("secretboxOpen") { (box: Data, nonce: Data, key: Data) throws -> Data? in
      guard nonce.count == 24, key.count == 32 else { throw SecretBoxException() }
      guard box.count >= 16 else { return nil }
      var out = Data(count: box.count - 16)
      let status = out.withUnsafeMutableBytes { o in
        box.withUnsafeBytes { b in
          nonce.withUnsafeBytes { n in
            key.withUnsafeBytes { k in
              televo_secretbox_open(
                o.count > 0 ? o.bindMemory(to: UInt8.self).baseAddress : Self.emptyOutput,
                b.bindMemory(to: UInt8.self).baseAddress,
                UInt64(b.count),
                n.bindMemory(to: UInt8.self).baseAddress,
                k.bindMemory(to: UInt8.self).baseAddress
              )
            }
          }
        }
      }
      return status == 0 ? out : nil
    }

    // publicKey is optional: when given, CryptoKit checks the key rebuilt
    // from the seed against it and refuses a mismatch instead of silently
    // decapsulating with the wrong key.
    Function("mlkem768Decapsulate") { (seed: String, ciphertext: String, publicKey: String?) throws -> String in
      guard #available(iOS 26.0, *) else {
        throw MLKEMUnavailableException()
      }
      guard let seedData = Data(base64Encoded: seed) else {
        throw InvalidBase64Exception("seed")
      }
      guard let ciphertextData = Data(base64Encoded: ciphertext) else {
        throw InvalidBase64Exception("ciphertext")
      }
      var expectedPublicKey: MLKEM768.PublicKey? = nil
      if let publicKey {
        guard let raw = Data(base64Encoded: publicKey) else {
          throw InvalidBase64Exception("publicKey")
        }
        expectedPublicKey = try MLKEM768.PublicKey(rawRepresentation: raw)
      }
      let privateKey = try MLKEM768.PrivateKey(seedRepresentation: seedData, publicKey: expectedPublicKey)
      let secret = try privateKey.decapsulate(ciphertextData)
      return secret.withUnsafeBytes { Data($0) }.base64EncodedString()
    }
  }
}

extension TelevoCryptoModule {
  // C wants a valid pointer even for zero-length data.
  fileprivate static let emptyInput: UnsafePointer<UInt8> = UnsafePointer(UnsafeMutablePointer<UInt8>.allocate(capacity: 1))
  fileprivate static let emptyOutput: UnsafeMutablePointer<UInt8> = UnsafeMutablePointer<UInt8>.allocate(capacity: 1)
}

final class SecretBoxException: Exception {
  override var reason: String {
    "secretbox failed"
  }
}

final class MLKEMUnavailableException: Exception {
  override var reason: String {
    "ML-KEM in CryptoKit needs iOS 26 or later"
  }
}

final class InvalidBase64Exception: GenericException<String> {
  override var reason: String {
    "\(param) is not valid base64"
  }
}
