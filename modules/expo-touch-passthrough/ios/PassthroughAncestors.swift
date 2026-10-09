import ObjectiveC
import UIKit

/// Per-instance hitTest override for container views this module doesn't
/// own (the modal view controller's root view, UIKit's presentation
/// container), done by swapping the instance's class for a runtime subclass
/// — the same isa-swizzling technique KVO uses, through public ObjC runtime
/// API only. The override changes exactly one answer: when the container
/// would claim a touch for ITSELF (no subview wanted it) while a
/// TouchPassthroughView is active, it returns nil so UIKit keeps looking in
/// the window underneath. Every other result passes through unchanged, and
/// with no active passthrough the subclass behaves identically to the
/// original class.
enum PassthroughAncestors {
  /// Touched only on the main thread (view lifecycle and hit testing).
  static var activeCount = 0

  private static let prefix = "TelevoPassthrough_"

  static func install(on view: UIView) {
    guard let original = object_getClass(view) else { return }
    let originalName = String(cString: class_getName(original))
    // Already ours, or a KVO-generated class (subclassing those is fragile).
    if originalName.hasPrefix(prefix) || originalName.hasPrefix("NSKVONotifying_") { return }

    let subclassName = prefix + originalName
    if let existing = NSClassFromString(subclassName) {
      object_setClass(view, existing)
      return
    }

    let selector = #selector(UIView.hitTest(_:with:))
    guard
      let method = class_getInstanceMethod(original, selector),
      let subclass = objc_allocateClassPair(original, subclassName, 0)
    else { return }

    typealias HitTest = @convention(c) (UIView, Selector, CGPoint, UIEvent?) -> UIView?
    let callOriginal = unsafeBitCast(method_getImplementation(method), to: HitTest.self)
    let override: @convention(block) (UIView, CGPoint, UIEvent?) -> UIView? = { me, point, event in
      let hit = callOriginal(me, selector, point, event)
      if hit === me && PassthroughAncestors.activeCount > 0 { return nil }
      return hit
    }
    class_addMethod(subclass, selector, imp_implementationWithBlock(override), method_getTypeEncoding(method))
    objc_registerClassPair(subclass)
    object_setClass(view, subclass)
  }
}
