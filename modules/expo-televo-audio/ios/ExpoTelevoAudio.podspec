require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoTelevoAudio'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = package['author']
  s.homepage       = 'https://github.com/AToPu-sys/televo'
  s.license        = package['license']
  s.platforms      = { ios: '15.1' }
  s.source         = { git: 'https://github.com/AToPu-sys/televo.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'JitsiWebRTC'
  # WebRTCModuleOptions: where the custom audio device and field trials go.
  s.dependency 'react-native-webrtc'

  s.source_files = '*.{h,m,mm,swift}', 'rnnoise/include/*.h', 'rnnoise/src/**/*.{c,h}'
  s.public_header_files = 'TelevoAudioInstaller.h'
  s.resource_bundles = { 'TelevoAudioResources' => ['Resources/rnnoise_weights.bin'] }

  s.pod_target_xcconfig = {
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) USE_WEIGHTS_FILE=1',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/rnnoise/include" "$(PODS_TARGET_SRCROOT)/rnnoise/src" "$(PODS_ROOT)/Headers/Public/react-native-webrtc"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    # rnnoise is third-party C: keep its warnings out of the build log.
    'WARNING_CFLAGS' => '$(inherited) -Wno-shorten-64-to-32 -Wno-comma -Wno-unused-function -Wno-conditional-uninitialized',
  }
end
