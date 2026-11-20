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
      Prop("quality") { (view: TelevoCallNativeView, value: Int) in view.model.quality = value }
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

  // The hosting controller must be a real child of the view controller that
  // shows this view. Its view used to be added on its own, outside the view
  // controller hierarchy; when the call's Modal was dismissed, UIKit met that
  // orphaned controller's view in the middle of the dismissal transition and
  // aborted with an assertion in UIViewControllerBuiltinTransitionViewAnimator
  // ("the app crashes after every call", build 90 onward).
  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard let host = host else { return }
    if window != nil {
      if host.parent == nil, let parent = owningViewController() {
        parent.addChild(host)
        host.didMove(toParent: parent)
      }
    } else if host.parent != nil {
      host.willMove(toParent: nil)
      host.removeFromParent()
    }
  }

  override func removeFromSuperview() {
    if let host = host, host.parent != nil {
      host.willMove(toParent: nil)
      host.removeFromParent()
    }
    super.removeFromSuperview()
  }

  private func owningViewController() -> UIViewController? {
    var responder: UIResponder? = self.next
    while let current = responder {
      if let controller = current as? UIViewController, controller !== host { return controller }
      responder = current.next
    }
    return nil
  }
}
