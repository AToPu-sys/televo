import ExpoModulesCore

/// Runs before React Native starts, which is when react-native-webrtc builds
/// its peer connection factory from WebRTCModuleOptions.
public class TelevoAudioAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    TelevoAudioInstaller.installAtLaunch()
    return true
  }
}
