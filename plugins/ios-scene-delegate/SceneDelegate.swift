import Expo
import React
import UIKit

/// Fixes the iOS 27 launch crash: "App Store build 87 crashes immediately
/// on iPhone 15 Pro / iOS 27, every time, before any of our own code runs"
/// — traced to a crash report whose entire stack was UIKitCore frames
/// around performCATransactionCommit, with no symbol of ours in it at all.
///
/// The root cause has nothing to do with our code: iOS 27 (and its Xcode
/// 27 SDK) expects every app to adopt the UIScene lifecycle. An app that
/// still creates its window the old way — AppDelegate builds a bare
/// `UIWindow` directly in `application:didFinishLaunchingWithOptions:`,
/// which is exactly what Expo's generated AppDelegate.swift does — hits
/// `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` and gets
/// torn down during the very first CoreAnimation commit, which is why the
/// crash report showed nothing but UIKitCore frames: the window RN built
/// was already invalid by the time UIKit tried to render it. It only
/// reproduced on this exact iOS/device combination because that's where
/// the OS actually started enforcing it — iOS 26 and earlier tolerate the
/// legacy path.
///
/// This file and withIosSceneLifecycle.js (the config plugin that wires
/// it up, since `expo prebuild` regenerates AppDelegate.swift and
/// Info.plist from scratch every time) are the fix: the window is now
/// built from a proper UIWindowScene handed to us by
/// `scene:willConnectToSession:options:`, exactly the shape iOS 27 expects.
/// AppDelegate.swift still exists and still runs first — this only takes
/// over the one piece of it (window creation) that iOS 27 no longer
/// tolerates done the old way.
///
/// Not a version-gated workaround: UIWindowScene/UISceneDelegate have been
/// part of UIKit since iOS 13, four major versions below this app's own
/// minimum (ios.deploymentTarget in the Podfile is 15.1), so this is simply
/// the correct way to build a window on every iOS version this app ever
/// runs on — not an iOS-27-only branch living alongside the old path. No
/// `@available` gate or legacy fallback is needed or present here.
public class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  public var window: UIWindow?

  public func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }

    guard
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      // Should be unreachable — AppDelegate's own didFinishLaunching always
      // runs before any scene connects — but failing open to a blank
      // window is safer than crashing if that assumption is ever wrong.
      return
    }

    let newWindow = UIWindow(windowScene: windowScene)
    factory.startReactNative(
      withModuleName: "main",
      in: newWindow,
      launchOptions: connectionOptions.urlContexts.isEmpty
        ? nil
        : ["UIApplicationLaunchOptionsURLKey": connectionOptions.urlContexts.first?.url as Any]
    )
    window = newWindow
    // Keep AppDelegate.window pointing at the same window other code
    // (deep-link handlers, CallKit's own window lookups) may still read.
    appDelegate.window = newWindow
    newWindow.makeKeyAndVisible()
  }

  // Universal Links / deep links opened while the app is already running
  // arrive here, not through AppDelegate, once a scene owns the window.
  public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }
}
