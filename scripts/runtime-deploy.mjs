// scripts/runtime-deploy.mjs —— 云 runtime 部署链（ADR-0199，task-11）。
//
// 四步：① esbuild 把 daemon.ts 打成单文件 ESM bundle（原生绑定 external 出去）
// ② 生成瘦身版 deploy-package.json（只含 better-sqlite3 + dockerode 两个原生件，
// 版本从根 package.json 现读，不在这再手抄一遍） ③ rsync 推送 dist/ +
// deploy-package.json + Dockerfile 到 $RUNTIME_SSH:/opt/otto-runtime/ ④ 远端
// npm install --omit=dev（只装两个原生件）+ docker build 沙箱镜像 + 重启 systemd。
//
// RUNTIME_SSH 是唯一必需的 env（形如 user@host）：这是一次会真的连真机、真的
// 重启线上服务的操作，没有目标地址直接打印用法退出 2，不往下走半步。
//
// 跑法：RUNTIME_SSH=otto@1.2.3.4 npm run runtime:deploy
//   （或直接 node scripts/runtime-deploy.mjs）

import { build } from "esbuild";
import { deployStamp, STAMP_TARGETS } from "./deploy-stamp.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const RUNTIME_SSH = process.env.RUNTIME_SSH;
if (!RUNTIME_SSH) {
  console.error("用法：RUNTIME_SSH=<user>@<host> npm run runtime:deploy");
  console.error("（RUNTIME_SSH 缺失——这一步会真的连真机、真的重启线上服务，没有目标地址不往下走）");
  process.exit(2);
}

const SSH_PORT = "2222";
const REMOTE_DIR = "/opt/otto-runtime";

const RUNTIME_SRC_DIR = join(repoRoot, "services/runtime");
const DIST_DIR = join(RUNTIME_SRC_DIR, "dist");
const OUTFILE = join(DIST_DIR, "runtime.mjs");
const DEPLOY_PKG = join(RUNTIME_SRC_DIR, "deploy-package.json");
const DOCKERFILE = join(RUNTIME_SRC_DIR, "sandbox", "Dockerfile");

/** 跑一个子进程，非 0 退出码直接把这次部署收场（继续下去只会在更远的地方
    以更难懂的方式失败——rsync 都没推上去，远端跑 npm install 没有意义）。 */
function runOrDie(cmd, args, label) {
  console.log(`[runtime-deploy] ${label}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`[runtime-deploy] ${label} 起不来：`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[runtime-deploy] ${label} 失败（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

// ── ① esbuild：daemon.ts 打成单文件 ESM bundle ────────────────────────────
// better-sqlite3 / dockerode 是原生绑定（.node 二进制），打不进 bundle——
// external 出去，靠远端 npm install 装它们自己的原生件（本机 arm64 打出来的
// 二进制在 VPS 的 x86_64 上跑不了，这也是 deploy-package.json 存在的理由）。
// banner 补 createRequire：bundle 是 ESM，但 esbuild 转译 CJS 依赖的某些
// 互操作细节时会摸 require——Node ESM 模块本身没有全局 require。
//
// entryPoints/outfile 用 brief 给的原样相对路径字符串（逐字照用），
// absWorkingDir 钉死成 repoRoot 只是让这份配置不依赖调用者的 cwd。
// 内容指纹先算（#791，ADR-0257）：它 define 进 bundle，daemon 起来时打进那行
// 「就绪」，收尾那一步再从 journal 里把它读回来核。指纹算的是**真实模块图的内容**
// 不是 git sha —— 理由写在 deploy-stamp.mjs 的文件头
const stamp = await deployStamp({ absWorkingDir: repoRoot, ...STAMP_TARGETS.runtime });
console.log(`[runtime-deploy] 内容指纹：${stamp}`);

console.log("[runtime-deploy] esbuild 打包 daemon.ts …");
mkdirSync(DIST_DIR, { recursive: true });
await build({
  define: { __OTTO_BUILD_STAMP__: JSON.stringify(stamp) },
  absWorkingDir: repoRoot,
  entryPoints: ["services/runtime/src/daemon.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "services/runtime/dist/runtime.mjs",
  external: ["better-sqlite3", "dockerode"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log(`[runtime-deploy] 写好 ${OUTFILE}`);

// ── ② deploy-package.json：只含两个原生件，版本从根 package.json 现读 ──────
// 现读而不是写死：根 package.json 升级 better-sqlite3/dockerode 版本时，
// 这份瘦身清单不该在这再手动同步一遍——同一个事实只留一处（根 package.json）。
//
// **dependencies 与 devDependencies 都认**（issue #820）：桌面一行都不 import
// dockerode，而 electron-builder 隐式把生产依赖整个打进 DMG——只认
// dependencies 的话，这个脚本就成了「dockerode 必须留在 dependencies 里」的
// 硬约束，逼着桌面安装包一直背着 dockerode/docker-modem/ssh2。这台 VPS 的
// `npm install` 只看这份生成出来的清单，dep 在根里挂哪一栏与它无关。
const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const NATIVE_DEPS = ["better-sqlite3", "dockerode"];
const deployDeps = {};
for (const dep of NATIVE_DEPS) {
  const version = rootPkg.dependencies?.[dep] ?? rootPkg.devDependencies?.[dep];
  if (!version) {
    console.error(`[runtime-deploy] 根 package.json 里没有 ${dep}（dependencies/devDependencies 都没有），deploy-package.json 生不出来`);
    process.exit(1);
  }
  deployDeps[dep] = version;
}
writeFileSync(
  DEPLOY_PKG,
  `${JSON.stringify({ name: "otto-runtime-deploy", private: true, dependencies: deployDeps }, null, 2)}\n`
);
console.log(`[runtime-deploy] 写好 ${DEPLOY_PKG}：${JSON.stringify(deployDeps)}`);

// ── ③ rsync 推送到 VPS ─────────────────────────────────────────────────
// 三次分开推，理由都不一样：
//   - dist/ 带尾斜杠 = 推"内容"不推目录本身，runtime.mjs 直接落在 REMOTE_DIR
//     根下（systemd unit 的 ExecStart 写死 /opt/otto-runtime/runtime.mjs，
//     不是 /opt/otto-runtime/dist/runtime.mjs）
//   - deploy-package.json 落地时改名成 package.json：远端要跑 `npm install`，
//     npm 认的文件名只有 package.json 一个
//   - Dockerfile 落进 sandbox/ 子目录：远端 `docker build ./sandbox` 找的
//     就是这里；先用 ssh mkdir -p 确保这个子目录存在（旧版 rsync 不会自动
//     建出目标路径里缺的父目录，--mkpath 是较新版本才有的 flag，不依赖它）
const sshOpt = ["-e", `ssh -p ${SSH_PORT}`];
runOrDie("ssh", ["-p", SSH_PORT, RUNTIME_SSH, `mkdir -p ${REMOTE_DIR}/sandbox`], "远端建目录");
runOrDie("rsync", ["-avz", ...sshOpt, `${DIST_DIR}/`, `${RUNTIME_SSH}:${REMOTE_DIR}/`], "rsync runtime.mjs");
runOrDie("rsync", ["-avz", ...sshOpt, DEPLOY_PKG, `${RUNTIME_SSH}:${REMOTE_DIR}/package.json`], "rsync deploy-package.json→package.json");
runOrDie("rsync", ["-avz", ...sshOpt, DOCKERFILE, `${RUNTIME_SSH}:${REMOTE_DIR}/sandbox/Dockerfile`], "rsync Dockerfile");

// ── ④ 远端：装原生件 + 建沙箱镜像 + 重启服务（brief 给的命令逐字照用）──────
const remoteCmd = `cd ${REMOTE_DIR} && npm install --omit=dev && docker build -t otto-sandbox ./sandbox && sudo systemctl restart otto-runtime`;
runOrDie("ssh", ["-p", SSH_PORT, RUNTIME_SSH, remoteCmd], "远端部署命令");

// ── ⑤ 自检：跑着的那个进程真的是这一份吗（#791，ADR-0257）────────────────
// #790 那次坏的不是部署，是**证据层**：命令打印了成功，没有任何一处核过线上真的
// 动了。这一步把「部署成功」从「命令退出码是 0」换成「那台机器上跑着的进程亲口
// 报出了这次的指纹」。判据故意不落在磁盘上那个文件——rsync 成功而 systemd 起不来
// （或起的是崩溃重启循环里的上一份）时，文件说的话是假的。
//
// 重启是异步的，systemd 起进程 + daemon 建两条中继连接要几秒；轮询而不是睡死一个
// 数，超时了就把 journal 尾巴打出来——那时最需要的正是它。
const READY_RE = new RegExp(`就绪：.*stamp=${stamp}\\b`);
const DEADLINE = Date.now() + 60_000;
let verified = false;
let lastTail = "";
while (Date.now() < DEADLINE) {
  const probe = spawnSync(
    "ssh",
    ["-p", SSH_PORT, RUNTIME_SSH, "sudo journalctl -u otto-runtime --since '-2 min' --no-pager | tail -40"],
    { encoding: "utf8" }
  );
  lastTail = String(probe.stdout ?? "") + String(probe.stderr ?? "");
  if (READY_RE.test(lastTail)) { verified = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!verified) {
  console.error(
    `[runtime-deploy] **部署没有被证实**：60 秒内没在 journal 里看到 stamp=${stamp} 的「就绪」行。
` +
    `rsync 与远端命令都成功了，所以最可能的是 daemon 起不来（配置缺项 fail fast / 原生件装错架构），
` +
    `或者它起来了但报的是另一份指纹（推上去的不是刚打的这个 bundle）。journal 尾巴：

${lastTail}`
  );
  process.exit(1);
}
console.log(`[runtime-deploy] 自检通过：线上进程报的指纹是 ${stamp}`);
console.log("[runtime-deploy] 完成");
