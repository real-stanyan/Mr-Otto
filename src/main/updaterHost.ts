// OTA 更新器的真实依赖（ADR-0075，win 席位见 ADR-0081 / issue #314）：
// 网络、磁盘、解包、换包脚本。逻辑一概不在这——流程和分支都在 updater.ts，
// 这里只把 Node/系统能力接上插座，并按 process.platform 提供三个平台席位
// （preflight / stage / installAndQuit）的本地实现。
//
// mac 换包为什么要 detached 脚本：app 不能删着自己的 .app 还继续跑。流程是
// spawn 脚本 → app.quit() → 脚本轮询等本进程退干净 → 旧 .app 改名 .app.bak
// →新 .app 移入原路径 → open 拉起新版。失败时把 .bak 挪回去，最坏也有一份能跑的。
// .bak 留着不删——没签名没公证，新版首启炸了用户还能手动改名回滚。
//
// win 换包不用脚本：下载产物本身就是 NSIS 安装器，直接 detached 起它
// `/S --force-run`（静默重装 + 装完拉起新版），关掉在跑的旧版和文件替换/回滚
// 全是 NSIS 自己的活。为什么不能像 mac 那样套一层等待脚本，见 winSwapSpawn
// 的注释（issue #662：detached 的 cmd 没有控制台，批处理里的控制台子进程
// 只好各自新建一个，屏幕上每秒弹三个黑框）。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { app, shell } from "electron";
import { join } from "node:path";
import type { UpdaterDeps } from "./updater.js";
import {
  UPDATE_ASSET_SUFFIX,
  appBundlePathFromExe,
  isTranslocated,
  winSwapSpawn,
} from "./updaterCore.js";
import type { UpdaterState } from "../shared/shellBridge.js";

/** GitHub API/下载都带上 UA——GitHub 对无 UA 请求直接 403 */
const USER_AGENT = "mr-otto-updater";

const SWAP_SCRIPT_MAC = `#!/bin/sh
# Mr Otto OTA 换包脚本（updaterHost.ts 生成）。参数：pid 旧app路径 新app路径
PID="$1"; APP="$2"; NEW="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
rm -rf "$APP.bak"
mv "$APP" "$APP.bak" || exit 1
if mv "$NEW" "$APP"; then
  open "$APP"
else
  mv "$APP.bak" "$APP"
  open "$APP"
  exit 1
fi
`;

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}：${stderr.trim().slice(0, 300)}`));
    });
  });
}

function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function findAppBundle(dir: string): Promise<string | null> {
  const entries = await readdir(dir);
  const name = entries.find((e) => e.endsWith(".app"));
  return name === undefined ? null : join(dir, name);
}

/** detached spawn 换包程序 + app.quit()。mac 起的是等本进程退干净再动文件的脚本，
    win 起的是 NSIS 安装器本身（等待与替换都是它自己的活，见 winSwapSpawn） */
function spawnDetachedAndQuit(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  app.quit();
}

/** mac 席位：Translocation/可写预检，ditto 解 zip 找 .app，sh 脚本换包 */
function macPlatformDeps(updatesDir: string) {
  return {
    assetSuffix: UPDATE_ASSET_SUFFIX.darwin,

    preflight(): string | null {
      const bundle = appBundlePathFromExe(process.execPath);
      if (bundle === null || isTranslocated(process.execPath)) {
        return "app 运行在受限路径（App Translocation），只能手动更新";
      }
      const parentDir = bundle.slice(0, bundle.lastIndexOf("/")) || "/";
      if (!canWrite(parentDir)) {
        return `${parentDir} 不可写，只能手动更新`;
      }
      return null;
    },

    // ditto 是系统自带、Apple 自家拿来打包 .app 的工具：符号链接、执行位、
    // extended attributes 全保。Node 解压库在这三样上全都翻过车
    async stage(downloadedPath: string): Promise<string> {
      const extractDir = join(updatesDir, "extracted");
      await runCommand("/usr/bin/ditto", ["-xk", downloadedPath, extractDir]);
      const appPath = await findAppBundle(extractDir);
      if (appPath === null) {
        throw new Error("zip 解开后没找到 .app——发布产物形状不对");
      }
      return appPath;
    },

    installAndQuit(stagedPath: string): void {
      const bundle = appBundlePathFromExe(process.execPath);
      if (bundle === null) return; // preflight 已挡过；防御性再挡一次
      const scriptPath = join(updatesDir, "swap.sh");
      void (async () => {
        await writeFile(scriptPath, SWAP_SCRIPT_MAC);
        await chmod(scriptPath, 0o755);
        spawnDetachedAndQuit("/bin/sh", [scriptPath, String(process.pid), bundle, stagedPath]);
      })();
    },
  };
}

/** win 席位：无预检（NSIS per-user 装机目录本用户可写；没有 Translocation 对应物），
    免解包（产物即安装器），直接跑安装器静默重装换包 */
function winPlatformDeps() {
  return {
    assetSuffix: UPDATE_ASSET_SUFFIX.win32,

    preflight: (): string | null => null,

    stage: async (downloadedPath: string): Promise<string> => downloadedPath,

    installAndQuit(stagedPath: string): void {
      const { cmd, args } = winSwapSpawn(stagedPath);
      spawnDetachedAndQuit(cmd, args);
    },
  };
}

export function createUpdaterHostDeps(onState: (state: UpdaterState) => void): UpdaterDeps {
  const updatesDir = join(app.getPath("userData"), "updates");
  const platform =
    process.platform === "win32" ? winPlatformDeps() : macPlatformDeps(updatesDir);
  return {
    currentVersion: app.getVersion(),
    updatesDir,
    onState,
    ...platform,

    async fetchText(url) {
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      return res.text();
    },

    async downloadFile(url, dest, onProgress) {
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      if (!res.ok || res.body === null) throw new Error(`下载失败：HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? 0);
      let received = 0;
      // 进度节流到 ~10 帧/秒——每个 chunk 都推 IPC 的话下载 100MB 要推几千次
      let lastPush = 0;
      const reader = res.body.getReader();
      const out = createWriteStream(dest);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          const now = Date.now();
          if (now - lastPush > 100) {
            lastPush = now;
            onProgress(received, total);
          }
          if (!out.write(value)) {
            await new Promise<void>((r) => out.once("drain", r));
          }
        }
        await new Promise<void>((resolve, reject) => {
          out.end(() => resolve());
          out.on("error", reject);
        });
        onProgress(received, total);
      } catch (e) {
        out.destroy();
        throw e;
      }
    },

    async fileSha256(path) {
      const hash = createHash("sha256");
      await pipeline(createReadStream(path), hash);
      return hash.digest("hex");
    },

    async resetDir(dir) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    },

    openExternal: (url) => shell.openExternal(url),
  };
}
