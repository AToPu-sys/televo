const { withPodfile } = require("@expo/config-plugins");

// Some Pods hardcode an IPHONEOS_DEPLOYMENT_TARGET below this app's own
// 15.1 (RNCAsyncStorage's resources target, RNSVGFilters, and others that
// haven't caught up) — Xcode refuses to archive at all once that's below
// its own supported floor ("the range of supported deployment target
// versions is 15.0 to 27.0.x" as of Xcode 27). This used to be a hand edit
// directly in ios/Podfile, which `expo prebuild --clean` silently discards
// every time (regenerates ios/ from scratch) — hence a config plugin, the
// same fix applied the same way every other native change in this app is.
const HOOK_MARKER = "IPHONEOS_DEPLOYMENT_TARGET'].to_f < 15.0";

const POST_INSTALL_HOOK = `
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |bc|
        if bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < 15.0
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
        end
      end
    end
`;

module.exports = function withPodsDeploymentTarget(config) {
  return withPodfile(config, (config) => {
    if (config.modResults.contents.includes(HOOK_MARKER)) {
      return config;
    }
    // Inserted right after react_native_post_install's own call, inside
    // the same `post_install do |installer| ... end` block the Expo
    // template already generates.
    const marker = /(react_native_post_install\(\s*installer,[\s\S]*?\)\n)/;
    if (!marker.test(config.modResults.contents)) {
      throw new Error(
        "withPodsDeploymentTarget: couldn't find react_native_post_install(...) in the generated Podfile to anchor on — the Expo template must have changed shape."
      );
    }
    config.modResults.contents = config.modResults.contents.replace(
      marker,
      `$1${POST_INSTALL_HOOK}`
    );
    return config;
  });
};
