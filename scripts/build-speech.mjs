// 编语音识别 helper（#1176，ADR-0273）。--debug 出 dev 二进制，否则 release。
// 与 build-island / build-siminput 分开跑：三个 Swift 包互不依赖，一个编不过不该拖垮另外两个。
//
// --debug 还顺手给 node_modules 里的 Electron.app 补一句 NSSpeechRecognitionUsageDescription：
// 麦克风 / 语音识别的 TCC 授权归到**责任进程**（helper 是主进程 spawn 的，责任进程是它爹），
// 爹的 Info.plist 少这一句时 TCC 直接把 helper 杀掉（EXC_CRASH，namespace TCC）。Electron 出厂
// 带 NSMicrophoneUsageDescription、不带语音识别那句；打包后走 electron-builder.yml 的 extendInfo，
// 开发时只能改 node_modules 里那份（幂等；重装 electron 会丢，下次 npm run dev 再补）。
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

if (!release) {
  const plist = join(import.meta.dirname, "../node_modules/electron/dist/Electron.app/Contents/Info.plist");
  if (!existsSync(plist)) {
    console.log("build-speech:没找到 Electron.app 的 Info.plist,跳过 usage description 补丁");
  } else {
    const KEY = "NSSpeechRecognitionUsageDescription";
    let has = false;
    try {
      execFileSync("plutil", ["-extract", KEY, "raw", "-o", "-", plist], { stdio: ["ignore", "ignore", "ignore"] });
      has = true;
    } catch {
      has = false;
    }
    if (!has) {
      execFileSync("plutil", ["-replace", KEY, "-string", "群语音通话里把你说的话转成文字。识别在本机完成,不上传录音。", plist], { stdio: "inherit" });
      console.log(`build-speech:给 Electron.app 补了 ${KEY}(dev 下 TCC 的责任进程是它)`);
    }
  }
}
