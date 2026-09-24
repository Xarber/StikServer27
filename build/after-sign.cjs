const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = async function afterSign(context) {
  if (process.platform !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign", "-",
    "--identifier", "com.xarber.stikserver",
    appPath
  ], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit"
  });
};
