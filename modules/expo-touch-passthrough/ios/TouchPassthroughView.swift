import ExpoModulesCore
import UIKit

/// Fixes "chat screens underneath are frozen while a call is minimized".
///
/// RN's `<Modal>` presents its content inside a brand-new `UIViewController`
/// (`RCTModalHostViewComponentView`'s `viewController`, see
/// node_modules/react-native/.../RCTModalHostViewComponentView.mm). React
/// Native DOES correctly implement `pointerEvents="none"`/`"box-none"` at the
/// native layer for every `RCTView`/Fabric view it renders (see RCTView.m's
/// own `hitTest:withEvent:` override — `box-none` returns `nil`, not `self`,
/// when no subview claims the touch). CallOverlay.tsx already sets those
/// correctly throughout its tree while minimized, and that part has
/// genuinely worked all along.
///
/// What nothing overrides is the ROOT of that modal view controller's own
/// view — a bare `UIView` UIKit creates for the controller, sitting ABOVE
/// every RN view this module's children live inside. A bare `UIView`'s
/// default `hitTest` returns `self` whenever a point is inside its bounds
/// and no subview claimed it — which is exactly what happens every time a
/// touch over the minimized call UI's transparent/box-none areas correctly
/// finds nothing to claim it: the "nobody wants this touch" signal correctly
/// propagates out of CallOverlay's own RN tree, then gets silently
/// swallowed by this one plain UIKit view that was never RN's to control in
/// the first place. The modal's native window therefore keeps "owning" the
/// touch and the screens underneath never see it, no matter how carefully
/// pointerEvents is set in JS.
///
/// The fix: wrap the single child CallOverlay.tsx puts inside <Modal> in
/// THIS view, and give it a `hitTest` override with the same semantics as
/// RCTView's own `box-none` (used by `passthroughEnabled`) — if none of our
/// subviews (i.e. none of CallOverlay's own RN views, which already do the
/// right thing all the way down) claim the touch, return `nil` here too
/// instead of `self`. `nil` returned from a hitTest that is reached through
/// a *presented* UIViewController's view does what it does everywhere else
/// in UIKit: the system keeps looking, finds nothing further in this
/// window, and — because this modal's window is not the key/opaque-covering
/// window in the way a non-transparent, non-passthrough modal's is —
/// delivers the touch to the main app window underneath instead.
///
/// `passthroughEnabled` is driven straight from CallOverlay's own
/// `minimized` boolean. While NOT minimized this behaves like an ordinary
/// passthrough UIView (full interaction, nothing changes) — the full-screen
/// call UI must keep exclusively owning all touches exactly as before.
public class TouchPassthroughView: ExpoView {
  var passthroughEnabled = false {
    didSet { syncAncestors() }
  }
  private var countedAsActive = false

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    syncAncestors()
  }

  /// Returning nil from THIS view was not enough (still reported 2026-10-04:
  /// "minimized video call, can't type or tap anything in the chat"). Above
  /// this view sit containers RN and UIKit own — the modal view controller's
  /// root view and UIKit's presentation container — and both are plain
  /// UIViews whose default hitTest claims any point inside their bounds that
  /// no subview wanted. So the "nobody wants this touch" answer from here was
  /// swallowed one and two levels up. While passthrough is on, those
  /// ancestors are made to answer nil instead of themselves too.
  private func syncAncestors() {
    let shouldCount = passthroughEnabled && window != nil
    if shouldCount && !countedAsActive {
      PassthroughAncestors.activeCount += 1
      countedAsActive = true
    } else if !shouldCount && countedAsActive {
      PassthroughAncestors.activeCount -= 1
      countedAsActive = false
    }
    guard shouldCount, let window else { return }
    var ancestor = superview
    while let view = ancestor, view !== window {
      PassthroughAncestors.install(on: view)
      ancestor = view.superview
    }
  }

  public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard passthroughEnabled else {
      return super.hitTest(point, with: event)
    }
    guard isUserInteractionEnabled, !isHidden, alpha > 0.01 else {
      return nil
    }
    // Mirrors RCTView's own RCTPointerEventsBoxNone branch (see RCTView.m):
    // test children in front-to-back order and return whichever of OUR
    // subviews claims the point, but never `self` — so a point that lands
    // on empty space here (which is everywhere outside whatever
    // CallOverlay itself left interactive, e.g. the minimized widget's own
    // hitbox) is reported as unclaimed all the way out, instead of this
    // view silently absorbing it the way a default UIView would.
    for subview in subviews.reversed() {
      let convertedPoint = subview.convert(point, from: self)
      if let hit = subview.hitTest(convertedPoint, with: event) {
        return hit
      }
    }
    return nil
  }
}
