require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoTelevoCrypto'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = package['author']
  s.homepage       = 'https://github.com/AToPu-sys/televo-app'
  s.license        = package['license']
  s.platforms      = { ios: '15.1' }
  s.source         = { git: 'https://github.com/AToPu-sys/televo-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # MLKEM768 is new in iOS 26; every use is behind #available, and Swift
  # weak-links the symbols, so the deployment target stays 15.1.
  s.frameworks = 'CryptoKit'

  # TelevoSecretBox.c: XSalsa20-Poly1305 (nacl.secretbox) in plain C; only
  # its small header is visible to Swift.
  s.source_files = '*.{h,c,swift}'
  s.public_header_files = 'TelevoSecretBox.h'
end
