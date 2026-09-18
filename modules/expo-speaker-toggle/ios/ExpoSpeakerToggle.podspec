require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoSpeakerToggle'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = package['author']
  s.homepage       = 'https://github.com/AToPu-sys/televo-app'
  s.license        = package['license']
  s.platforms      = { ios: '15.1' }
  s.source         = { git: 'https://github.com/AToPu-sys/televo-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # RTCAudioSession: mid-call route changes must be made under WebRTC's own
  # configuration lock now that the app runs WebRTC in manual-audio mode.
  s.dependency 'JitsiWebRTC'

  # Relative to this podspec's own directory (ios/) — see the same note in
  # ExpoCallKit.podspec for why the podspec must live here and not at the
  # module root.
  s.source_files = '**/*.{h,m,mm,swift}'
end
