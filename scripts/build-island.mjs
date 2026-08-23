// 编 Swift helper。--debug 出 dev 二进制(swift build 默认 debug),否则 release。
// 打包时由 afterPack 调 release 分支并拷进 .app + ad-hoc 签。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const pkg = join(import.meta.dirname, "../native/MrOttoIsland");
const release = !process.argv.includes("--debug");
if (process.platform !== "darwin") {
  console.log("build-island:非 macOS,跳过");
  process.exit(0);
}
if (!existsSync(join(pkg, "Package.swift"))) {
  console.error("build-island:找不到 native/MrOttoIsland/Package.swift");
  process.exit(1);
}
const args = ["build", "--package-path", pkg, ...(release ? ["-c", "release"] : [])];
console.log("build-island:swift", args.join(" "));
execFileSync("swift", args, { stdio: "inherit" });
