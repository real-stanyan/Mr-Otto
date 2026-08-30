// accountScope —— 本机数据按登录账号分家（issue #749，ADR-0187）。
//
// 在这之前，一台机器上的本地存储只按 `OTTO_PROFILE` 分（userData），或者干脆
// 一台机器一份（`~/.mr-otto/`）。于是「退出账号 1、登录账号 2」之后，账号 2
// 看到的是账号 1 的会话、记忆、审批记忆，还能直接用账号 1 的模型 key 和已授权
// 的 MCP 令牌 —— 登出不清任何本地状态，`AccountManager.signOut` 只动内存里的
// account 和服务端 session。0600 挡的是别的 macOS 用户，挡不住同一个 macOS
// 用户下的第二个 Mr Otto 账号。
//
// ## 先有鸡还是先有蛋，答案在 auth.json 里
//
// `app.setPath("userData")` 跑在 `ready` 之前，那时 `AccountManager` 还没造出来，
// uid 看起来要等 `restore()` 的网络往返。但不必：supabase 落在 auth.json 里的
// 那份 session **自带 `user.id`**，和 ADR-0183 的进门闸读同一个文件、同样是
// 同步的、同样离线答得出。所以「这次开机打开谁的抽屉」在 `whenReady` 的第一行
// 就能定下来（`sessionUserId`），装配根照旧一次成型，不必拆成两阶段。
//
// ## 换号靠重启，不靠热切换
//
// 抽屉在装配时就钉死了（约二十处 store 各自持着一条绝对路径），登录态却是运行时
// 才变的。热切换要么把二十处改成 getter、要么在 3000 行的装配根中间拆一刀 ——
// 而重启一次就换完，且**换得干净**：没有半初始化状态，没有"这个 store 换了那个
// 没换"的可能。判据是纯的（`needsRelaunch`），代价是登录/换号时闪一次重启。
//
// ## 哪些搬、哪些不搬
//
// userData 下除了 `auth.json`（uid 的来源，必须留在根）和 `updates/`
// （OTA 下载缓存，机器级）全搬；`~/.mr-otto/` 整个搬。
//
// 「整个搬」是刻意的：`skills/` `agents/` 这类手写的东西留在机器级看起来更方便，
// 但那要求每加一个新文件都重新判一次"它算不算私密"—— 而这个 bug 本身就是没人
// 做那次判断的结果。一条规则不需要维护一张名单。目录名不可读的代价用 who.txt
// 抵掉（同 `memoryStore` 的 `root.txt`：让目录自描述，不建中心索引）。
//
// 工作区级的 `<工程>/.mr-otto/`（configDir(workspace)）**不动** —— 它跟着项目走，
// 不跟着人走。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, type ConfigDirFs } from "./configDir.js";

/** 账号抽屉的父目录名（userData 和 ~/.mr-otto 下同名） */
export const ACCOUNTS_DIR = "accounts";

/** 没有登录记录时用的那一格。带前缀下划线，和 16 位十六进制的真抽屉永远不会撞 */
export const SIGNED_OUT_DIR = "_signed-out";

/** 归属不明的存量停在这一格（issue #755）。**永远不会被自动归给任何账号** —— 它存在的
    全部意义就是「这堆东西有主，但这台机器上已经没有证据说主人是谁了」。 */
export const UNCLAIMED_DIR = "_unclaimed";

/** 抽屉的自描述文件（同 memoryStore 的 root.txt）。目录名是哈希，人找不着自己的那份，
    所以每个抽屉里放一张名片 —— 手编 mcp.json 的人 grep 一遍
    `~/.mr-otto/accounts` 底下的 who.txt 就找到自己那间 */
export const WHO_FILE = "who.txt";

/** uid → 抽屉名。sha256 前 16 位，与 projectRoot 的项目目录同一套口径。
    哈希不是为了保密（uid 在 auth.json 里就是明文），是为了长度和字符集可控 */
export function accountDirName(uid: string | null): string {
  if (!uid) return SIGNED_OUT_DIR;
  return createHash("sha256").update(uid).digest("hex").slice(0, 16);
}

/** 这个账号在 userData 下的抽屉。auth.json 不在里面 —— 它是 uid 的来源 */
export function accountDataDir(userData: string, uid: string | null): string {
  return join(userData, ACCOUNTS_DIR, accountDirName(uid));
}

/** 这个账号在 `~/.mr-otto/` 下的抽屉。先过一遍 configDir（`.otter` 老目录的改名
    仍然发生在外层，ADR-0057），再进 accounts/ */
export function accountConfigDir(home: string, uid: string | null, fs?: ConfigDirFs): string {
  return join(configDir(home, fs), ACCOUNTS_DIR, accountDirName(uid));
}

/**
 * 要不要重启换抽屉。
 *
 * 只有「现在登录着的人」和「开机时打开的抽屉」对不上才换：
 * - 登出（signedIn=null）不重启 —— 渲染层的进门闸自己会挡（ADR-0182/0183），
 *   而重启一次只是为了走到同一个结果；同号登出再登入也就不必空转一趟。
 * - 冷启动 restore() 回来的是同一个人，这里恒为 false，感知不到这条机制存在。
 */
export function needsRelaunch(bootUid: string | null, signedInUid: string | null): boolean {
  return signedInUid !== null && signedInUid !== bootUid;
}

// ---------------------------------------------------------------------------
// 存量搬家
// ---------------------------------------------------------------------------

/** userData 根下要搬进抽屉的东西。**不含 `auth.json`**（uid 的来源）和 `updates/`（OTA 缓存）。
    sqlite 的 WAL 三兄弟必须一起走 —— 只搬 .db 会让未 checkpoint 的事件留在原地 */
export const LEGACY_USER_DATA_ENTRIES = [
  "sessions.db",
  "sessions.db-wal",
  "sessions.db-shm",
  "keys.json",
  "permissions.json",
  "execPolicy.json",
  "hooks.json",
  "auto-compact.json",
  "helper-model.json",
  "vision-model.json",
  "island.json",
  "workspace.json",
  "motion.json",
  "proxy-store.json",
  "remote-identity.bin",
  "attachments",
  "worktrees",
] as const;

/** `~/.mr-otto/` 下要搬进抽屉的东西 = 除了 accounts/ 自己以外的全部 */
export const LEGACY_CONFIG_ENTRIES = [
  "memories",
  "mcp.json",
  "mcp-auth.json",
  "skills",
  "agents",
  "checkpoints",
] as const;

export interface AdoptFs {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
}

const nodeAdoptFs: AdoptFs = {
  exists: (p) => existsSync(p),
  rename: (a, b) => renameSync(a, b),
};

/** 根下还有没有升级前的存量。`adoptLegacy` 之前先问这一句：没有存量的话，
    「归属不明」这件事根本不存在，不该凭空建出一格 `_unclaimed` 来 */
export function hasLegacy(
  root: string,
  entries: readonly string[],
  fs: AdoptFs = nodeAdoptFs,
): boolean {
  return entries.some((e) => fs.exists(join(root, e)));
}

/**
 * 把散在 `from` 根下的存量整个搬进 `to` 这个抽屉，返回真搬动了的条目名。
 *
 * 归属的裁决是「存量归给账号 1」（issue #749）。**但"账号 1"只有一个时刻证明得了**：
 * 升级后第一次开机时 `auth.json` 里还有没有 session —— 人一登出，证据就永远没了。
 * 第一版把这句写成了 `if (bootUid) adopt(…)`，实际语义是「归给升级后第一个登录的人」，
 * 于是「登出 → 升级 → 登录另一个号」这条路上，A 的全部数据被交给了 B（issue #755，
 * 正是 #749 要修的那个现象换了条路发生）。所以调用方分两支：能归属就归属，
 * 归属不了就整堆挪进 `_unclaimed`，从此不再自动归给任何人。
 *
 * 两条守则：
 * - **目标已存在就不搬**。这一条同时兜住两种情况：搬过一次不重复搬；
 *   以及 `_signed-out` 那格里可能有一个开机时顺手建出来的空 sessions.db，
 *   它绝不能盖掉抽屉里真的那份。
 * - **单条失败吞掉**（权限、跨设备 rename），继续搬下一条。搬不动的后果是
 *   那一条留在原地看不见了，不该因此拦着启动 —— 同 configDir 的取舍。
 */
export function adoptLegacyData(
  from: string,
  to: string,
  entries: readonly string[],
  fs: AdoptFs = nodeAdoptFs,
): string[] {
  const moved: string[] = [];
  for (const entry of entries) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (!fs.exists(src) || fs.exists(dst)) continue;
    try {
      fs.rename(src, dst);
      moved.push(entry);
    } catch {
      // 留在原地，下次开机再试
    }
  }
  return moved;
}

/** 归属不明的存量停车场里那张说明。它比 who.txt 更需要存在：一个只有哈希名的
    目录里躺着 26 MB 的 sessions.db，不写清楚是什么，下一个看到的人只会删掉它 */
export const UNCLAIMED_NOTE = [
  "这里是「升级到按账号分抽屉之前」的旧数据（issue #755）。",
  "",
  "它有主，但这台机器上已经没有证据说主人是谁了 —— 升级后第一次开机时没有任何",
  "登录记录，而那是唯一一次能证明它属于谁的机会。所以它停在这儿，不会被自动",
  "归给任何账号：猜错一次的后果，就是另一个人看到你的会话、记忆和 API key。",
  "",
  "确定它是谁的，把这些文件移进那个账号的抽屉即可（同级目录，名字是 uid 的",
  "sha256 前 16 位，每间里的 who.txt 写着是谁）。",
  "",
].join("\n");

/**
 * 归属不明时的去处：把 `root` 下的存量整堆挪进 `<root>/accounts/_unclaimed/`，
 * 返回挪走的条目名。
 *
 * 挪走这个动作本身就是修复（issue #755）—— 留在根下的话，**下一个登录的人会把它
 * 顺手扫走**，而那个人多半正是你想把数据挡在外面的那个人。
 */
export function parkUnclaimed(
  root: string,
  entries: readonly string[],
  io: { mkdir(p: string): void; writeNote(p: string, text: string): void } = nodeParkIo,
  fs: AdoptFs = nodeAdoptFs,
): string[] {
  if (!hasLegacy(root, entries, fs)) return []; // 没存量就不该凭空建出一格来
  const parked = join(root, ACCOUNTS_DIR, UNCLAIMED_DIR);
  io.mkdir(parked);
  const moved = adoptLegacyData(root, parked, entries, fs);
  if (moved.length > 0) io.writeNote(join(parked, "读我.txt"), UNCLAIMED_NOTE);
  return moved;
}

const nodeParkIo = {
  mkdir: (p: string) => mkdirSync(p, { recursive: true }),
  writeNote: (p: string, text: string) => {
    try {
      writeFileSync(p, text, { mode: 0o600 });
    } catch {
      // 说明写不出来不影响数据本身已经挪到位
    }
  },
};

/** 抽屉的名片。写失败不算错（只读盘、权限）—— 它是给人看的便利，不是正确性的一环 */
export function writeWho(dir: string, who: { uid: string | null; email: string }): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, WHO_FILE),
      `${who.email || "(未知邮箱)"}\n${who.uid ?? "(未登录)"}\n`,
      { mode: 0o600 },
    );
  } catch {
    // 名片写不出来不影响任何功能
  }
}
