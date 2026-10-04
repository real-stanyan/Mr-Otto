// 手机端发一次热更新（#1463，ADR-0340）：`npm --prefix mobile run ota -- "这次改了什么"`。
//
// 热更新只能换 JS，换不了原生。往一个缺原生模块的包里推一份要那个模块的 JS，打开就崩。所以这里**宁可拒也不猜**
// （同 Mandy 的 publish.yml）：上一次打原生包（TestFlight）那个提交记在 mobile/native-build.json，
// 从那之后只要动过下面这几处任何一个文件，就拒绝发热更新——去打一个新的原生包，把 runtimeVersion 往上加一，
// 再更新 native-build.json。
//
// 发之前先跑一遍手机端的 tsc。发到 EAS Update 的 production 分支（app.json 里 requestHeaders 的
// expo-channel-name 指着它）。凭据是本机 eas-cli 的登录（账号 real_stanyan）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = join(dirname(fileURLToPath(import.meta.url)), "..");
const message = process.argv.slice(2).join(" ").trim();
if (message === "") {
  console.error('用法：npm --prefix mobile run ota -- "这次改了什么"');
  process.exit(2);
}

/** 动了就得出原生包的那几处（相对仓库根） */
export const NATIVE_PATHS = ["mobile/package.json", "mobile/package-lock.json", "mobile/app.json", "mobile/modules/", "mobile/plugins/"];

const native = JSON.parse(readFileSync(join(mobile, "native-build.json"), "utf8"));
const app = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8"));
if (native.runtimeVersion !== app.expo.runtimeVersion) {
  console.error(`app.json 的 runtimeVersion（${app.expo.runtimeVersion}）和最近一次原生包（${native.runtimeVersion}）对不上：先打原生包，再更新 native-build.json`);
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { cwd: mobile, encoding: "utf8" }).trim();
// Windows 上 npx / eas 是 .cmd 垫片：Node 不带 shell 根本不肯 spawn .cmd（CVE-2024-27980 之后是 EINVAL，再早是
// ENOENT），只能经 cmd.exe 起；参数自己加引号（消息里有空格、分号、中文）。git 是真 exe 不用管（2026-10-04 在
// Windows 发第一、二次热更新时各踩一次）
const win = process.platform === "win32";
const quote = (a) => (win ? `"${String(a).replace(/"/g, '""')}"` : a);
const run = (name, args, opts) =>
  win
    ? execFileSync("cmd.exe", ["/d", "/s", "/c", [`${name}.cmd`, ...args.map(quote)].join(" ")], { ...opts, windowsVerbatimArguments: true })
    : execFileSync(name, args, opts);
const changed = git("diff", "--name-only", native.commit, "HEAD", "--", ...NATIVE_PATHS.map((p) => join("..", p)))
  .split("\n")
  .filter((l) => l !== "");
if (changed.length > 0) {
  console.error(`从上一次原生包（${native.commit.slice(0, 8)}）以来动过原生那几处，不能走热更新：\n  ${changed.join("\n  ")}`);
  console.error("去打一个新的 TestFlight 包（runtimeVersion +1），再更新 mobile/native-build.json。");
  process.exit(1);
}
const dirty = git("status", "--porcelain");
if (dirty !== "") {
  console.error("工作区不干净：热更新要发的是提交过的东西");
  process.exit(1);
}

run("npx", ["tsc", "--noEmit", "-p", "."], { cwd: mobile, stdio: "inherit" });
// 手机按 production **频道**来要更新（app.json 的 requestHeaders），频道再指向同名分支。只发到分支、频道却不在，
// 更新就躺在服务器上谁也收不到——而 eas update 不会替你建频道，也不报错（2026-10-04 第一次发热更新时踩到）
try {
  run("eas", ["channel:view", "production", "--non-interactive"], { cwd: mobile, stdio: "ignore" });
} catch {
  console.log("production 频道不在，先建（指向同名分支）");
  run("eas", ["channel:create", "production", "--non-interactive"], { cwd: mobile, stdio: "inherit" });
}
run("eas", ["update", "--branch", "production", "--platform", "ios", "--environment", "production", "--non-interactive", "--message", message], { cwd: mobile, stdio: "inherit" });
console.log("热更新已发：用户下次打开 App（或在后台待够 30 分钟回来）就会换上。");
