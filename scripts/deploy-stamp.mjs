// scripts/deploy-stamp.mjs —— 「这份服务端代码的内容指纹」（#791，ADR-0257）。
//
// 存在的理由是 #790 那次：ADR-0151/0129 给 relay 加了角色，代码合了、门禁绿了、
// 客户端发版了，**线上 worker 还是旧的**——好友代理真机握手从没成功过，而桌面那侧
// 报的是「云端无响应」，方向指向 VPS 宕机。整件事没有任何一处会响。
//
// 判据必须回答的问题是「**此刻部署上去会不会改变什么**」，所以：
//
// **不拿 git sha**。sha 答的是「仓库走到哪了」，而 app-only 的一次发版不该把 worker
// 判成陈旧；反过来，只改 `src/shared/remote/cloudSession.ts`（协议进位）的那种提交
// 一个字都没碰 `services/`，按路径去猜「谁受影响」必然漏——那正是 2026-09-08 协议
// 12→13 的形状。
//
// **拿真实模块图的内容**：esbuild 打一遍（`write: false`，只要 metafile），把它
// **实际编译进去的每一个文件**按路径排序、逐个哈希内容，再哈希一遍。改动任何一个
// 进得了 bundle 的文件（含 `src/shared/` 里那些）指纹就变；改 README、改测试、改
// 另一个服务，指纹不动。没有路径启发式，也就没有假警报——而一条会误报的警报，
// 用不了几次就没人看了。
//
// 输出取 12 位十六进制：这个数要能塞进 `wrangler deploy --var`、塞进一行日志、
// 让人肉眼比对，全长 64 位除了难读没有别的好处（碰撞对「同一份仓库的两次构建」
// 这个样本空间来说不是真实威胁）。

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{ absWorkingDir: string, entry: string, external?: string[], platform?: "node" | "neutral" | "browser", tsconfig?: string }} opts
 * @returns {Promise<string>} 12 位十六进制
 */
export async function deployStamp(opts) {
  const result = await build({
    absWorkingDir: opts.absWorkingDir,
    entryPoints: [opts.entry],
    bundle: true,
    write: false,
    metafile: true,
    // platform 决定 node 内建（`node:fs` 这类）算不算「解析得出来」：runtime 要
    // "node"，worker 那份不能用它（它没有 node 内建，误判成能解析只会让图变形）
    platform: opts.platform ?? "neutral",
    format: "esm",
    // 只为算指纹，不为产出可跑的东西：语法降级、target、minify 全都无关紧要，
    // 关键只有「哪些文件进了这张图」。**认不出的 import 一律 external**，
    // 否则 `cloudflare:workers` 这类运行时内建会让整次打包失败
    external: opts.external ?? [],
    logLevel: "silent",
    ...(opts.tsconfig ? { tsconfig: opts.tsconfig } : {}),
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  if (inputs.length === 0) throw new Error(`[deploy-stamp] ${opts.entry} 的模块图是空的，指纹算不出来`);
  const h = createHash("sha256");
  for (const rel of inputs) {
    // 路径也进哈希：同一份内容换个文件名是**另一份**代码（import 解析会变）
    h.update(rel);
    h.update("\0");
    h.update(createHash("sha256").update(readFileSync(join(opts.absWorkingDir, rel))).digest());
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/** 两个服务的入口与 external 只写这一份：deploy 那侧与 check 那侧读同一个常量，
    分家的话「部署时算的指纹」与「检查时算的指纹」永远对不上，而那个失败看起来
    像「线上是陈旧的」——一条永远喊狼来了的警报 */
export const STAMP_TARGETS = {
  edge: {
    entry: "services/edge/src/worker.ts",
    platform: "neutral",
    // Workers 运行时内建，打包器解析不了；类型来自 @cloudflare/workers-types，
    // 那份 tsconfig 只服务 tsc，esbuild 这一趟不需要
    external: ["cloudflare:*"],
  },
  runtime: {
    entry: "services/runtime/src/daemon.ts",
    platform: "node",
    // 与 runtime-deploy.mjs 的 external 同一份理由：原生绑定打不进 bundle
    external: ["better-sqlite3", "dockerode"],
  },
};

/**
 * 要核的 edge 地址。**从 `src/shared/edgeConfig.ts` 现读，不在这抄一份**：客户端打的
 * 是那个常量，核一个客户端根本不会去打的地址没有意义，而两份地址分家的那天没有
 * 任何一处会报错——只会让自检对着一个空气地址报「通过」。
 * 读不出来直接抛：常量被改名了要在这里响，不是退回一个写死的旧值继续跑。
 * `OTTO_EDGE_URL` 覆盖它（与 `edgeBaseUrl()` 认的是同一个 env 名）。
 * @param {string} repoRoot
 */
export function edgeBaseUrl(repoRoot) {
  const override = process.env.OTTO_EDGE_URL;
  if (override) return override.replace(/\/+$/, "");
  const src = readFileSync(join(repoRoot, "src/shared/edgeConfig.ts"), "utf8");
  const m = /DEFAULT_EDGE_BASE_URL\s*=\s*"([^"]+)"/.exec(src);
  if (!m) {
    throw new Error(
      "[deploy-stamp] src/shared/edgeConfig.ts 里找不到 DEFAULT_EDGE_BASE_URL —— " +
      "常量改名了？部署自检要核的地址必须与客户端读的是同一个，不在这里写死第二份"
    );
  }
  return m[1].replace(/\/+$/, "");
}
