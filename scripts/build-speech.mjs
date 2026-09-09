// 编语音识别 helper（#1176，ADR-0273）。--debug 出 dev 二进制，否则 release。
// 与 build-island / build-siminput 分开跑：三个 Swift 包互不依赖，一个编不过不该拖垮另外两个。
//
// 权限不在这里补：TCC 把授权归到进程树顶上的 GUI app（dev 下是起 dev 的终端），补谁的 plist 都
// 不对，helper 自己 exec 成责任进程（main.swift 头注，#1180）。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const pkg = join(import.meta.dirname, "../native/MrOttoSpeech");
const release = !process.argv.includes("--debug");
if (process.platform !== "darwin") {
  console.log("build-speech:非 macOS,跳过");
  process.exit(0);
}
if (!existsSync(join(pkg, "Package.swift"))) {
  console.error("build-speech:找不到 native/MrOttoSpeech/Package.swift");
  process.exit(1);
}
const args = ["build", "--package-path", pkg, ...(release ? ["-c", "release"] : [])];
console.log("build-speech:swift", args.join(" "));
execFileSync("swift", args, { stdio: "inherit" });

