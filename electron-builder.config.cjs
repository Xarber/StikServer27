const nativeName = process.platform === "win32" ? "stikserver-native.exe" : "stikserver-native";

module.exports = {
  afterSign: "build/after-sign.cjs",
  appId: "com.xarber.stikserver",
  productName: "StikServer",
  icon: "build/StikDebug.png",
  directories: { output: "dist" },
  files: [
    "battery-history.mjs",
    "desktop/**/*",
    "discovery.mjs",
    "native-manager.mjs",
    "public/**/*",
    "server.mjs",
    "package.json"
  ],
  extraResources: [{
    from: `native/target/release/${nativeName}`,
    to: `native/${nativeName}`
  }],
  asarUnpack: ["node_modules/ffmpeg-static/**/*"],
  artifactName: "StikServer-${version}-${os}-${arch}.${ext}",
  mac: {
    category: "public.app-category.developer-tools",
    identity: "-",
    hardenedRuntime: false,
    extendInfo: {
      NSLocalNetworkUsageDescription: "StikServer discovers and controls nearby iPhone and iPad devices over your private local network.",
      NSBonjourServices: ["_remotepairing._tcp"]
    },
    target: ["zip"]
  },
  win: { target: ["portable"] },
  linux: {
    category: "Development",
    target: ["AppImage"]
  }
};
