// services/runtime/checks/smoke.mjs —— 云 runtime 装配冒烟（ADR-0199，task-11）。
// 跑法：node services/runtime/checks/smoke.mjs
//
// 为什么是两个文件：真正的装配验证要 import 真实的 frameHandler.ts / sessionService.ts
// （TypeScript 源码，NodeNext 风格的 .js 后缀指向 .ts 文件）——plain node 的 ESM
// loader 解不开这层，得靠 tsx 转译。这份 .mjs 本身保持零 TS 语法，`node` 能直接
// 跑；它只做一件事：spawn 一个 `npx tsx` 子进程去跑 smokeAssembly.ts（真正的断言
// 全在那份文件里），原样转发它的 stdout/stderr 与 exit code。
//
// 与 services/edge/checks/relay.mjs 的对照：那份脚本刻意手抄了一遍协议编解码，
// 为的是能不装 tsx、单独 node 跑（"这个脚本要能单独 node 跑，不走打包"）。这里
// 反过来——冒烟测的正是 frameHandler.ts/sessionService.ts 这两份真实装配代码
// 本身，手抄一份等于验了个假的，所以必须驱动真 TS 源码，tsx 是必需品不是可选项。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const target = join(here, "smokeAssembly.ts");

const result = spawnSync("npx", ["tsx", target], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error("[smoke] 起不来 `npx tsx`：", result.error);
  process.exit(1);
}
// 被信号杀掉时 status 是 null——统一收敛成 1，不让冒烟脚本自己看起来像"通过"
process.exit(result.status ?? 1);
