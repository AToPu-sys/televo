require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoCallKit'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = package['author']
  s.homepage       = 'https://github.com/AToPu-sys/televo-app'
  s.license        = package['license']
  s.platforms      = { ios: '15.1' }
  s.source         = { git: 'https://github.com/AToPu-sys/televo-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Needed for RTCAudioSession. WebRTC's audio device module owns
  # AVAudioSession by default and re-activates it on its own worker thread
  # after getUserMedia resolves — which silently tore down the route CallKit
  # had just handed over, and is why a call answered from the lock screen
  # connected with no audio. Handing CallKit's didActivate to RTCAudioSession
  # requires linking against WebRTC here.
  s.dependency 'JitsiWebRTC'

  # Relative to this podspec's own directory (ios/), which is where the
  # autolinker requires the podspec to live — it only scans a package's
  # SUBDIRECTORIES for podspecs, never the package root, so a podspec at the
  # module root is silently ignored and the whole module never reaches the
  # generated ExpoModulesProvider.
  s.source_files = '**/*.{h,m,mm,swift}'
end
