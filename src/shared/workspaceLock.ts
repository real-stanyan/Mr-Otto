// workspaceLock —— 工作区互斥的跨进程那一半（issue #634，ADR-0155）
//
// ADR-0152 用 `runningSessions` 挡住了同一个进程里的两条 turn。它明写了不覆盖的第一条：
// **两个 app 实例**（dev 版和正式版、或两份安装）指着同一个文件夹时互相看不见——
// `runningSessions` 是进程内状态。
//
// 这一层补的就是那个洞：一个进程外可见的锁。设计上只回答一个问题——
//   「此刻还有别的进程在这个文件夹里跑 turn 吗？」
//
// ── 两个不显然的选择 ──────────────────────────────────────────────
//
// **锁不放在工作区里**。放 `<workspace>/.mr-otto/…` 会污染用户的仓库、会进 git status、
// 会被误提交。放在机器级临时目录、按路径哈希取名：两个 app 实例看得见同一个文件，
// 用户的目录一个字节都不动。
//
// **不放在 userData 里**。那是每个安装各自的目录——dev 版和正式版的 userData 不同，
// 锁写进去等于两个进程各锁各的，正好把要解决的问题解决不掉。
//
// 陈旧锁必须能自愈：进程崩了不该把文件夹永久锁死。两道判据——心跳过期、进程已死。
// 纯逻辑在这里，真正的读写和 pid 探活在 main 层。

import { EXCLUSION_WHY, EXCLUSION_WAY_OUT, EXCLUSION_FALLBACK } from "./workspaceExclusion.js";

/** 落盘的锁内容。字段都是给人看的诊断信息，判定只用 pid 和 heartbeatTs */
export interface WorkspaceLockFile {
  /** 持锁进程 */
  pid: number;
  /** 持锁会话（诊断用；跨进程时对方的 sessionId 对本进程没有意义，但写日志有用） */
  sessionId: string;
  /** 哪个安装写的（"Mr Otto" / "Mr Otto Dev"…），提示语里点名用 */
  app: string;
  /** 最近一次心跳（epoch ms） */
  heartbeatTs: number;
}

/** 心跳间隔。turn 可以跑很久，锁必须在跑的过程中持续刷新 */
export const HEARTBEAT_MS = 10_000;
/** 超过这么久没心跳就当陈旧。取心跳间隔的若干倍——一次调度延迟、一次系统休眠
    不该让别人抢走锁，但也不能长到「崩溃之后要等好几分钟才能干活」 */
export const STALE_AFTER_MS = 60_000;

/** 这份锁此刻还算数吗？
    算数 = 有别的进程正持着它，本进程该退让。
    两道判据任一不成立就当陈旧（可以抢）：
    - 心跳超过 STALE_AFTER_MS 没更新（进程卡死/被 SIGKILL/机器休眠过久）
    - 进程已经不在了（pidAlive 说了算——同机才问得出来，这正是本锁的适用范围） */
export function lockHeld(
  lock: WorkspaceLockFile,
  now: number,
  pidAlive: (pid: number) => boolean,
  selfPid: number
): boolean {
  if (lock.pid === selfPid) return false; // 自己写的锁不挡自己（同进程由 ADR-0152 那层管）
  if (now - lock.heartbeatTs > STALE_AFTER_MS) return false;
  return pidAlive(lock.pid);
}

/** 锁文件名：路径哈希 + 可读前缀。哈希是为了避开路径里的分隔符和长度上限；
    前缀只是让人 `ls` 的时候认得出这是什么，判定不看它。
    传入的 workspace 必须已经是解析过的绝对路径——本函数不做规范化，
    两个进程对同一个目录算出不同哈希的话，这层锁就白做了 */
export function lockFileName(workspace: string, sha256Hex: (s: string) => string): string {
  return `ws-${sha256Hex(workspace).slice(0, 32)}.json`;
}

/** 拒绝时给人看的话。与 ADR-0152 那半**共用同一段措辞**（issue #653）：
    用户看不见这两层的分界，两条提示读起来必须是同一句话 */
export function crossProcessMessage(lock: WorkspaceLockFile, workspace: string): string {
  return (
    `另一个 Mr Otto 正在这个文件夹里干活：\n` +
    `  文件夹：${workspace}\n` +
    `  占用的程序：${lock.app}（进程 ${lock.pid}）\n\n` +
    `${EXCLUSION_WHY}\n` +
    `${EXCLUSION_FALLBACK}\n\n` +
    `怎么办：\n` +
    `  · 等它做完，再把这条消息发一次；\n` +
    `  · ${EXCLUSION_WAY_OUT}\n` +
    `  · 那个程序要是已经关了，等一分钟这里会自己过期解开。`
  );
}
