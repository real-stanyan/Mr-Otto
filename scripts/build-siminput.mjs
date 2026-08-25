// 编 iOS 模拟器输入 helper(issue #401)。--debug 出 dev 二进制,否则 release。
// 与 build-island.mjs 分开跑:两个 Swift 包互不依赖,一个编不过不该拖垮另一个。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const pkg = join(import.meta.dirname, "../native/MrOttoSimInput");
const release = !process.argv.includes("--debug");
if (process.platform !== "darwin") {
  console.log("build-siminput:非 macOS,跳过");
  process.exit(0);
}
if (!existsSync(join(pkg, "Package.swift"))) {
  console.error("build-siminput:找不到 native/MrOttoSimInput/Package.swift");
  process.exit(1);
}
const args = ["build", "--package-path", pkg, ...(release ? ["-c", "release"] : [])];
console.log("build-siminput:swift", args.join(" "));
execFileSync("swift", args, { stdio: "inherit" });
