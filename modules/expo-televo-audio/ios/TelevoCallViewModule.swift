import ExpoModulesCore
import SwiftUI

/// Exposes the SwiftUI voice-call screen (TelevoCallScreen.swift) to React
/// Native as <TelevoCallView>. React Native keeps owning the call itself; the
/// view only draws it and reports taps through `onAction`.
public class TelevoCallViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TelevoCallView")

    View(TelevoCallNativeView.self) {
      Events("onAction")

      Prop("peerName") { (view: TelevoCallNativeView, value: String) in view.model.peerName = value }
      Prop("avatarUrl") { (view: TelevoCallNativeView, value: String?) in
        view.model.avatarURL = value.flatMap(URL.init(string:))
      }
      Prop("statusText") { (view: TelevoCallNativeView, value: String) in view.model.statusText = value }
      Prop("phase") { (view: TelevoCallNativeView, value: String) in view.model.phase = value }
      Prop("connected") { (view: TelevoCallNativeView, value: Bool) in view.model.connected = value }
      Prop("reconnecting") { (view: TelevoCallNativeView, value: Bool) in view.model.reconnecting = value }
      Prop("muted") { (view: TelevoCallNativeView, value: Bool) in view.model.muted = value }
      Prop("routeKind") { (view: TelevoCallNativeView, value: String) in view.model.routeKind = value }
      Prop("routeLabel") { (view: TelevoCallNativeView, value: String) in view.model.routeLabel = value }
      Prop("routeIsPicker") { (view: TelevoCallNativeView, value: Bool) in view.model.routeIsPicker = value }
      Prop("canMinimize") { (view: TelevoCallNativeView, value: Bool) in view.model.canMinimize = value }
    }
  }
}

final class TelevoCallNativeView: ExpoView {
  let model = CallScreenModel()
  let onAction = EventDispatcher()
  private var host: UIHostingController<CallScreen>?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let screen = CallScreen(model: model) { [weak self] action in
      self?.onAction(["action": action])
    }
    let controller = UIHostingController(rootView: screen)
    controller.view.backgroundColor = .clear
    controller.view.frame = bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(controller.view)
    host = controller
  }
}
