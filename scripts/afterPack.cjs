// electron-builder afterPack:把 release 版 helper 拷进 .app 并 ad-hoc 签
const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const bin = join(__dirname, "../native/MrOttoIsland/.build/release/MrOttoIsland");
  if (!existsSync(bin)) throw new Error("afterPack:helper release 二进制缺失,先跑 build-island");
  const appName = ctx.packager.appInfo.productFilename;
  const dest = join(ctx.appOutDir, `${appName}.app`, "Contents", "Resources", "MrOttoIsland");
  copyFileSync(bin, dest);
  execFileSync("codesign", ["--force", "--sign", "-", dest], { stdio: "inherit" }); // ad-hoc
  console.log("afterPack:helper 已拷入并 ad-hoc 签");
};
