const nativeName = process.platform === "win32" ? "stikserver-native.exe" : "stikserver-native";

module.exports = {
  appId: "com.xarber.stikserver",
  productName: "StikServer",
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
    target: ["zip"]
  },
  win: { target: ["portable"] },
  linux: {
    category: "Development",
    target: ["AppImage"]
  }
};
