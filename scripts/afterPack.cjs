// electron-builder afterPack:把 release 版 helper 拷进 .app 并 ad-hoc 签
const { execFileSync } = require("node:child_process");
const { copyFileSync, cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const buildDir = join(__dirname, "../native/MrOttoIsland/.build/release");
  const bin = join(buildDir, "MrOttoIsland");
  if (!existsSync(bin)) throw new Error("afterPack:helper release 二进制缺失,先跑 build-island");
  const appName = ctx.packager.appInfo.productFilename;
  const resources = join(ctx.appOutDir, `${appName}.app`, "Contents", "Resources");
  copyFileSync(bin, join(resources, "MrOttoIsland"));
  // SPM 资源 bundle(otto.png 等,#201):Bundle.module 按"二进制同目录"找它,
  // 缺了 helper 会兜底键盘图标不至于崩,但 logo 就没了——所以缺 bundle 也算打包失败
  const bundle = join(buildDir, "MrOttoIsland_MrOttoIsland.bundle");
  if (!existsSync(bundle)) throw new Error("afterPack:helper 资源 bundle 缺失,先跑 build-island");
  cpSync(bundle, join(resources, "MrOttoIsland_MrOttoIsland.bundle"), { recursive: true });
  execFileSync("codesign", ["--force", "--sign", "-", join(resources, "MrOttoIsland")], { stdio: "inherit" }); // ad-hoc

  // iOS 模拟器输入 helper(issue #401)。它没有资源 bundle,一个裸二进制。
  // 缺了不算打包失败的理由与岛不同:岛缺了 app 少一整块功能,这个缺了只是
  // 模拟器面板退化成"只能看不能点"——但既然 dist:mac 前置跑了 build-siminput,
  // 缺席就意味着那一步出了事,还是拦下来
  const simBin = join(__dirname, "../native/MrOttoSimInput/.build/release/MrOttoSimInput");
  if (!existsSync(simBin)) throw new Error("afterPack:模拟器输入 helper 缺失,先跑 build-siminput");
  copyFileSync(simBin, join(resources, "MrOttoSimInput"));
  execFileSync("codesign", ["--force", "--sign", "-", join(resources, "MrOttoSimInput")], { stdio: "inherit" });
  console.log("afterPack:helper + 资源 bundle 已拷入并 ad-hoc 签");
};
