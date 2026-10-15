import ExpoModulesCore

public class TelevoAudioModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TelevoAudio")

    Function("isNoiseSuppressionEnabled") { () -> Bool in
      TelevoAudioInstaller.noiseSuppressionEnabled()
    }

    Function("setNoiseSuppressionEnabled") { (enabled: Bool) -> Void in
      TelevoAudioInstaller.setNoiseSuppressionEnabled(enabled)
    }

    Function("isCustomDeviceEnabled") { () -> Bool in
      TelevoAudioInstaller.customDeviceEnabled()
    }

    Function("setCustomDeviceEnabled") { (enabled: Bool) -> Void in
      TelevoAudioInstaller.setCustomDeviceEnabled(enabled)
    }

    Function("diagnostics") { () -> [String: Any] in
      TelevoAudioInstaller.diagnostics()
    }
  }
}
