// 把线上版（mr-otto）的用户数据同步到 dev 目录（mr-otto-dev）。
// dev 版默认走独立目录（不然和生产版抢单实例锁），首次 `npm run dev` 前跑一次这个，
// dev 里就有你现在的账户和数据了。增量同步（rsync -u），可以反复跑。
//
// 同步的是数据文件；浏览器缓存/锁文件/更新包这些不搬（不该搬、也搬不动——
// SingletonLock 指向生产实例，updates/ 是生产版的自更新包）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const appData = join(homedir(), "Library", "Application Support");
const src = join(appData, "mr-otto");
const dst = join(appData, "mr-otto-dev");

if (!existsSync(src)) {
  console.error(`找不到线上版数据目录：${src}`);
  console.error("先跑一次安装版的 Mr. Otto 再同步。");
  process.exit(1);
}
mkdirSync(dst, { recursive: true });

// 数据文件与目录的白名单。缺席的（新装还没产生的）跳过，不报错。
const entries = [
  // SQLite 三件套必须一起搬（WAL 里可能有还没 checkpoint 的提交）
  "sessions.db",
  "sessions.db-wal",
  "sessions.db-shm",
  "otter.db",
  "otter.db-wal",
  "otter.db-shm",
  // 登录态 / 密钥 / 远程配对
  "auth.json",
  "keys.json",
  "remote-identity.bin",
  // 各 store
  "trustedWorkspaces.json",
  "auto-compact.json",
  "mcp-auth.json",
  "helper-model.json",
  "vision-model.json",
  "island.json",
  // 内容目录
  "attachments",
  "blob_storage",
  // 浏览器持久层（Supabase 刷新令牌等在 Local Storage 里——不搬 dev 就要重新登录）
  "Local Storage",
  "Local State",
];

const copied = [];
for (const entry of entries) {
  const from = join(src, entry);
  if (!existsSync(from)) continue;
  // -a 保属性递归，-u 只覆盖更新的（增量，反复跑不重拷）
  execFileSync("rsync", ["-au", from, dst + "/"], { stdio: "pipe" });
  copied.push(entry);
}

console.log(`已同步 ${copied.length} 项 → ${dst}`);
console.log(copied.map((e) => `  ${e}`).join("\n"));
console.log("\n现在 npm run dev 起的就是带这份数据的 dev 版。");
