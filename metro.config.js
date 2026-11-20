// Expo's default Metro config, plus web-only stand-ins for native modules
// that have no browser implementation. iOS and Android builds are unchanged.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const WEB_SHIMS = {
  "expo-secure-store": path.resolve(__dirname, "src/shims/secureStore.web.ts"),
};

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && WEB_SHIMS[moduleName]) {
    return { type: "sourceFile", filePath: WEB_SHIMS[moduleName] };
  }
  return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
