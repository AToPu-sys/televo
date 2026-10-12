const { withAppDelegate, withInfoPlist, withXcodeProject, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Fixes the iOS 27 crash-on-launch: see SceneDelegate.swift's own doc
// comment for the full "why". This plugin exists because `expo prebuild`
// regenerates AppDelegate.swift, Info.plist and the Xcode project from
// scratch every time — a hand edit to any of them is silently discarded on
// the next prebuild, so the three changes below have to be made here
// instead, the same way every other native fix in this app (CallKit,
// touch-passthrough, etc.) already is.

/** AppDelegate.swift still runs first on every launch — this only stops it
 * from building the window itself, which is the one thing iOS 27 no longer
 * tolerates done outside a UIWindowScene. SceneDelegate takes over exactly
 * that piece once iOS hands it a scene. */
function patchAppDelegate(contents) {
  const windowBlock = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;
  if (!windowBlock.test(contents)) {
    // Already patched (re-running prebuild without --clean), or the
    // generated template changed shape — leave it alone rather than
    // silently producing a broken file in the second case.
    return contents;
  }
  contents = contents.replace(
    windowBlock,
    "// Window creation moved to SceneDelegate.swift — iOS 27 crashes at launch\n" +
      "    // (UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption) if\n" +
      "    // AppDelegate builds the UIWindow itself instead of a UIWindowScene\n" +
      "    // handing one to scene:willConnectToSession:options:. See that file's\n" +
      "    // own doc comment for the full trace.\n"
  );

  // Tells UIKit which scene configuration to use when it connects a scene
  // — the configuration named in Info.plist's UIApplicationSceneManifest
  // below, which points at SceneDelegate. Without this override UIKit
  // falls back to a default/unnamed configuration that never resolves to
  // our delegate class, and scene:willConnectToSession:options: never
  // fires at all.
  if (!contents.includes("configurationForConnecting")) {
    // No `override`: ExpoAppDelegate doesn't implement this itself, so
    // it's a plain UIApplicationDelegate protocol conformance, not an
    // override of a superclass method — `override` here fails to compile
    // ("method does not override any method from its superclass").
    contents = contents.replace(
      /\}\n\nclass ReactNativeDelegate/,
      "\n" +
        "  public func application(\n" +
        "    _ application: UIApplication,\n" +
        '    configurationForConnecting connectingSceneSession: UISceneSession,\n' +
        "    options: UIScene.ConnectionOptions\n" +
        "  ) -> UISceneConfiguration {\n" +
        '    return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)\n' +
        "  }\n" +
        "}\n\nclass ReactNativeDelegate"
    );
  }

  return contents;
}

module.exports = function withIosSceneLifecycle(config) {
  config = withAppDelegate(config, (config) => {
    config.modResults.contents = patchAppDelegate(config.modResults.contents);
    return config;
  });

  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return config;
  });

  // Copies SceneDelegate.swift into the generated ios/ project. A
  // withDangerousMod (not withXcodeProject's file-adding API) because the
  // Xcode project edit below needs the file to already exist on disk at
  // the path it references.
  config = withDangerousMod(config, [
    "ios",
    (config) => {
      const target = path.join(config.modRequest.platformProjectRoot, config.modRequest.projectName, "SceneDelegate.swift");
      fs.copyFileSync(path.join(__dirname, "SceneDelegate.swift"), target);
      return config;
    },
  ]);

  config = withXcodeProject(config, (config) => {
    const project = config.modResults;
    const groupKey = project.findPBXGroupKey({ name: config.modRequest.projectName });
    project.addSourceFile(
      `${config.modRequest.projectName}/SceneDelegate.swift`,
      null,
      groupKey
    );
    return config;
  });

  return config;
};
