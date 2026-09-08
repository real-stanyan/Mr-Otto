// scripts/deploy-check.mjs —— 「线上那两个服务此刻是不是当前这份代码」（#791，ADR-0258）。
//
// 这是 #790 那次唯一缺的东西：能问出这个问题的地方。当时代码合了、门禁绿了、
// 客户端发版了，线上 worker 还是旧的——没有任何一处会响，症状只在真机上、而且
// 长得像「云端无响应」（方向指向 VPS 宕机，实际是一次没做的部署）。
//
// 判据是**内容指纹**（deploy-stamp.mjs）不是 git sha：一次 app-only 的发版不该把
// 服务端判成陈旧，而只改 `src/shared/remote/cloudSession.ts` 的协议进位一个字都没碰
// `services/`——按路径猜「谁受影响」两个方向都错，2026-09-08 协议 12→13 就是后者。
//
// 三态，缺一不可（同 ADR-0243 / ADR-0251 那条纪律）：
//   current  线上报的指纹 = 本地现算的
//   stale    线上报的是另一个指纹 —— 确凿的「该部署了」
//   unknown  **问不出来**（没登录 / 没配 RUNTIME_SSH / 打不通 / 那份线上代码还没有
//            报指纹的能力）。它不许并进 current —— 「没有证据」被读成「没有问题」
//            正是这条 issue 的病根；也不许并进 stale —— 那会让一次网络抖动看起来
//            像一次漏掉的部署，喊几次狼来了之后这条检查就没人看了。
//
// 跑法：npm run deploy:check          （RUNTIME_SSH 缺席时 runtime 那行报 unknown）
//      RUNTIME_SSH=user@host npm run deploy:check
// 退出码：全 current = 0；有 stale = 1；只有 unknown = 2（「没查成」不是「没问题」，
// 也不是「确认落后了」）。

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deployStamp, edgeBaseUrl, STAMP_TARGETS } from "./deploy-stamp.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SSH_PORT = "2222";

/** @typedef {{ target: string, state: "current"|"stale"|"unknown", want: string, got: string, note: string }} Row */

/** @returns {Promise<Row>} */
async function checkEdge() {
  const want = await deployStamp({ absWorkingDir: repoRoot, ...STAMP_TARGETS.edge });
  const base = edgeBaseUrl(repoRoot);
  try {
    const res = await fetch(`${base}/healthz`, { cache: "no-store" });
    const body = await res.json();
    const got = typeof body?.stamp === "string" ? body.stamp : "";
    if (got === "") return { target: "edge", state: "unknown", want, got: "（没报）", note: `${base} 回的 /healthz 里没有 stamp —— 线上那份 worker 比这次改动旧，或者是手跑的 wrangler deploy 没带 --var` };
    if (got === "unknown") return { target: "edge", state: "unknown", want, got, note: `${base} 报的是 "unknown" —— 部署时没注指纹（手跑过 wrangler deploy？），线上是哪一份查不出来` };
    return { target: "edge", state: got === want ? "current" : "stale", want, got, note: base };
  } catch (err) {
    return { target: "edge", state: "unknown", want, got: "（打不通）", note: `${base}/healthz：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** @returns {Promise<Row>} */
async function checkRuntime() {
  const want = await deployStamp({ absWorkingDir: repoRoot, ...STAMP_TARGETS.runtime });
  const ssh = process.env.RUNTIME_SSH;
  if (!ssh) {
    return { target: "runtime", state: "unknown", want, got: "（没查）", note: "RUNTIME_SSH 没设 —— 这一格要 ssh 进 VPS 读 journal 才答得出来" };
  }
  // 判据落在**跑着的那个进程**报的那行「就绪」上，不落在磁盘上那个 bundle：
  // rsync 成功而 systemd 起不来（或崩溃重启循环里跑的还是上一份）时文件会撒谎
  const probe = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-p", SSH_PORT, ssh,
     "sudo journalctl -u otto-runtime --no-pager | grep -F '就绪：' | tail -1"],
    { encoding: "utf8" }
  );
  if (probe.status !== 0) {
    return { target: "runtime", state: "unknown", want, got: "（打不通）", note: `ssh ${ssh}：${(probe.stderr ?? "").trim() || `exit ${probe.status}`}` };
  }
  const line = String(probe.stdout ?? "").trim();
  const m = /stamp=([0-9a-f]+)/.exec(line);
  if (!m) {
    return { target: "runtime", state: "unknown", want, got: "（没报）", note: `线上最后一行「就绪」里没有 stamp —— 那份 runtime 比这次改动旧：${line || "（journal 里一行都没有）"}` };
  }
  const got = m[1];
  return { target: "runtime", state: got === want ? "current" : "stale", want, got, note: line };
}

const rows = await Promise.all([checkEdge(), checkRuntime()]);

const MARK = { current: "✓ 当前", stale: "✗ 落后", unknown: "? 问不出来" };
console.log("");
for (const r of rows) {
  console.log(`${MARK[r.state]}  ${r.target}`);
  console.log(`        本地 ${r.want}   线上 ${r.got}`);
  console.log(`        ${r.note}`);
}
console.log("");

if (rows.some((r) => r.state === "stale")) {
  console.error("有服务落后于仓库。部署：npm run edge:deploy / RUNTIME_SSH=… npm run runtime:deploy");
  process.exit(1);
}
if (rows.some((r) => r.state === "unknown")) {
  console.error("有一格问不出来 —— 这不是「没问题」，只是没查成。");
  process.exit(2);
}
console.log("两个服务都是当前这份代码。");
