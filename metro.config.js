// Expo's default Metro config, plus web-only stand-ins for native modules
// that have no browser implementation. iOS and Android builds are unchanged.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Swapped in for every importer on the web.
const WEB_SHIMS = {
  // babel-plugin-react-native-web turns `import { Alert } from "react-native"`
  // into these deep paths; react-native-web's own Alert is a no-op.
  "react-native-web/dist/exports/Alert": path.resolve(__dirname, "src/shims/alert.web.ts"),
  "react-native-web/dist/cjs/exports/Alert": path.resolve(__dirname, "src/shims/alert.web.ts"),
  "expo-secure-store": path.resolve(__dirname, "src/shims/secureStore.web.ts"),
  "expo-sharing": path.resolve(__dirname, "src/shims/sharing.web.ts"),
};
// Swapped in only for the app's own code: libraries may rely on parts of
// these modules the shim doesn't cover.
const WEB_APP_SHIMS = {
  "expo-file-system": path.resolve(__dirname, "src/shims/fileSystem.web.ts"),
};

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web") {
    if (WEB_SHIMS[moduleName]) return { type: "sourceFile", filePath: WEB_SHIMS[moduleName] };
    const fromApp = !context.originModulePath.includes(`${path.sep}node_modules${path.sep}`);
    if (fromApp && WEB_APP_SHIMS[moduleName]) return { type: "sourceFile", filePath: WEB_APP_SHIMS[moduleName] };
  }
  return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
