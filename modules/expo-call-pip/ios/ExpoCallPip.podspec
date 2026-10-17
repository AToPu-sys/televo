require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoCallPip'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = package['author']
  s.homepage       = 'https://github.com/AToPu-sys/televo-app'
  s.license        = package['license']
  s.platforms      = { ios: '15.1' }
  s.source         = { git: 'https://github.com/AToPu-sys/televo-app.git' }

  s.frameworks = 'VideoToolbox', 'AVKit'
  s.dependency 'ExpoModulesCore'
  # For RTCVideoRenderer/RTCVideoFrame/RTCMediaStream — this module reads
  # raw decoded video frames directly off the remote track react-native-webrtc
  # already negotiated, rather than duplicating any WebRTC/media logic of
  # its own.
  s.dependency 'JitsiWebRTC'
  # For WebRTCModule.streamForReactTag: — the exact same lookup RTCView
  # (react-native-webrtc's own JS component) uses to resolve a streamURL to
  # a real RTCMediaStream. Reusing this public method means this module
  # never has to duplicate react-native-webrtc's own stream bookkeeping —
  # it just asks the same authority WebRtcBridge.tsx's <RTCView> already
  # asks, for the same streamURL string. react-native-webrtc's own pod
  # already ships a generated Clang module (react_native_webrtc, umbrella
  # header includes WebRTCModule.h) — `import react_native_webrtc` in
  # Swift reaches it directly. A bridging header was tried first and
  # failed: Expo modules are always built as framework targets regardless
  # of the static_framework podspec flag, and Swift bridging headers are
  # unsupported on framework targets ("Using bridging headers with
  # framework targets is unsupported" — a hard compiler error).
  s.dependency 'react-native-webrtc'

  s.source_files = '**/*.{h,m,mm,swift}'
end
