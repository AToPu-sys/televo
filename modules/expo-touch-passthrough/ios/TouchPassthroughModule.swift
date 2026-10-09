import ExpoModulesCore

public class TouchPassthroughModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TouchPassthrough")

    View(TouchPassthroughView.self) {
      // See TouchPassthroughView's own doc comment for exactly what this
      // does and why it has to live here rather than being handled by RN's
      // own pointerEvents prop.
      Prop("passthroughEnabled") { (view: TouchPassthroughView, enabled: Bool?) in
        view.passthroughEnabled = enabled ?? false
      }
    }
  }
}
