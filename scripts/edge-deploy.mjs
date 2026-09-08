// scripts/edge-deploy.mjs —— 部署 edge worker 并**核一遍线上真的动了**（#791，ADR-0257）。
//
// 为什么不是直接 `npm --prefix services/edge run deploy`：那条命令退出 0 只证明
// wrangler 把包交出去了。#790 那次坏的正是这一层——代码合了、门禁绿了、客户端发版了，
// 线上 worker 还是旧的，而唯一的症状是真机握手失败、桌面报「云端无响应」。
// 所以这个脚本把「部署成功」的判据从退出码换成：**线上那份 worker 亲口报出这次的指纹**。
//
// 指纹注入走 `wrangler deploy --var BUILD_STAMP:<戳>`（plain-text var，不是 secret，
// 不进 wrangler.jsonc——写死在那儿等于每次部署要手改一行）。worker 的 /healthz 把它
// 回出来；`npm run deploy:check` 拿它跟本地现算的比。
//
// 跑法：npm run edge:deploy
//   OTTO_EDGE_URL 可覆盖要核的地址（默认取 src/shared/edgeConfig.ts 那份，
//   与客户端读的是同一个常量——核一个客户端根本不会去打的地址没有意义）。

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployStamp, edgeBaseUrl, STAMP_TARGETS } from "./deploy-stamp.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const EDGE_DIR = join(repoRoot, "services/edge");
const BASE = edgeBaseUrl(repoRoot);

const stamp = await deployStamp({ absWorkingDir: repoRoot, ...STAMP_TARGETS.edge });
console.log(`[edge-deploy] 内容指纹：${stamp}`);

// 先问一句「你是谁」：没登录时 wrangler 会开浏览器等交互，而这个脚本可能跑在
// release 中间——那时它会挂在那儿看起来像卡死。提前失败，把话说清楚
const who = spawnSync("npx", ["wrangler", "whoami"], { cwd: EDGE_DIR, encoding: "utf8" });
if (who.status !== 0) {
  console.error(
    "[edge-deploy] wrangler 没有登录（`npx wrangler whoami` 失败）。\n" +
    "先在 services/edge 里跑一次 `npx wrangler login`，再重试。\n" +
    (who.stderr ?? "")
  );
  process.exit(2);
}

const deploy = spawnSync(
  "npx",
  ["wrangler", "deploy", "--var", `BUILD_STAMP:${stamp}`],
  { cwd: EDGE_DIR, stdio: "inherit" }
);
if (deploy.status !== 0) {
  console.error(`[edge-deploy] wrangler deploy 失败（exit ${deploy.status}）`);
  process.exit(deploy.status ?? 1);
}

// ── 自检：/healthz 报的指纹是不是这一次的 ────────────────────────────────
// Cloudflare 的全球传播不是瞬时的，所以轮询而不是打一次就下结论；超时了把最后
// 一次读到的东西打出来——「读到的是上一份的指纹」和「压根没连上」该做的事不一样
const DEADLINE = Date.now() + 90_000;
let last = "（一次都没读到）";
while (Date.now() < DEADLINE) {
  try {
    const res = await fetch(`${BASE}/healthz`, { cache: "no-store" });
    const body = await res.json();
    last = JSON.stringify(body);
    if (body?.stamp === stamp) {
      console.log(`[edge-deploy] 自检通过：${BASE}/healthz 报的指纹是 ${stamp}`);
      process.exit(0);
    }
  } catch (err) {
    last = `请求失败：${err instanceof Error ? err.message : String(err)}`;
  }
  await new Promise((r) => setTimeout(r, 3000));
}

console.error(
  `[edge-deploy] **部署没有被证实**：90 秒内 ${BASE}/healthz 没有报出 stamp=${stamp}。\n` +
  `最后读到的是：${last}\n` +
  `wrangler deploy 说它成功了，所以最可能的是这个地址前面还挂着别的东西（路由/缓存），\n` +
  `或者这份 worker 不是刚才部署的那一个（多环境/多账号）。`
);
process.exit(1);
