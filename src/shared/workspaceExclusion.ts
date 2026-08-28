// workspaceExclusion —— 同一个工作区，同一时刻只允许一条 turn 在跑（issue #620，ADR-0152）
//
// 为什么需要：一只水獭的沙箱是 `ExecutionWorld` 圈定的**文件系统路径**。git 的状态不在
// 路径里，在 `.git` 里——两只水獭指着同一个工作目录时，一边 `git checkout`，另一边的
// 未提交改动就无声消失了。围栏一个字都拦不住：那条命令的 cwd 完全合法。
//
// 本仓自己的 agent lane 已经踩过三次（#543 / #449 / #616），修法写在 ADR-0149/0150：
// 一次性 worktree + 主 checkout 只读。但那是**给会读 AGENTS.md 的 agent 的规矩**，
// 用户的水獭不读。所以产品侧要一个不靠自觉的东西。
//
// 做法与 git 自己同构：**只拒绝，不做魔法**。git 不会替你把分支挪到别处，它只说
// 「'main' is already used by worktree at …」。这里也一样——不自动开 worktree、不自动
// 换目录，只是不让第二条 turn 起跑，并说清楚谁占着、怎么办。
//
// 判据是「turn 在跑」而不是「会话存在」：两个会话指着同一个文件夹但都闲着，什么事都
// 没有；真正会互相踩的是**同时执行**。这也让机制自己维护自己——没有要 release 的锁，
// 状态就是 engine.runningTurnId，问一次就有答案，不存在忘记解锁这种失败模式。
//
// 纯函数、零 IO：主进程把 agents 表拍成快照喂进来。

/** 一条参与判定的会话。主进程从 agents 表 + store.sessions() 拍出来 */
export interface LiveSession {
  sessionId: string;
  /** ExecutionWorld 的围栏根。已解析成绝对路径——本模块不做路径规范化 */
  workspace: string;
  /** 家族根：会话自己，或它所属的那条主会话（子会话/SideChat 顺着 spawnedFrom 爬到顶）。
      同家族共享工作区是**故意的**（SideChat 就是拿父会话的 workspace 开的，子会话在
      父 turn 跑着的时候跑），所以家族内部不互斥 */
  familyRoot: string;
  /** 此刻有没有 turn 在跑 */
  running: boolean;
}

export interface WorkspaceConflict {
  /** 占着的那个会话 */
  heldBy: string;
  /** 撞的是哪个目录 */
  workspace: string;
}

/** 想在 `candidate` 上起一条 turn，能起吗？
    返回冲突 = 不能起；null = 能。
    只有「别的家族 + 同一个工作区 + 正在跑」三条同时成立才算冲突：
    - 同家族（子会话 / SideChat）不算——那是同一条 lane 的内部并发，本来就该并行；
    - 闲着的会话不算——闲着不会执行任何命令；
    - 不同工作区不算——各自围栏，互不相干（不同 worktree 也落在这一档：git 自己
      保证同一分支不会被两处 checkout，两个目录的 HEAD 互不影响）。 */
export function turnConflict(
  candidate: Pick<LiveSession, "sessionId" | "workspace" | "familyRoot">,
  live: readonly LiveSession[]
): WorkspaceConflict | null {
  for (const s of live) {
    if (s.sessionId === candidate.sessionId) continue;
    if (!s.running) continue;
    if (s.familyRoot === candidate.familyRoot) continue;
    if (s.workspace !== candidate.workspace) continue;
    return { heldBy: s.sessionId, workspace: s.workspace };
  }
  return null;
}

/** 顺着 spawnedFrom 爬到家族根。环（不该出现，但日志是外部输入）按「爬不动就停」处理，
    不无限循环；找不到父会话（父已 purge）时以当前这层为根——独立会话与它同款语义 */
export function familyRootOf(
  sessionId: string,
  parentOf: (id: string) => string | null | undefined
): string {
  const seen = new Set<string>([sessionId]);
  let cur = sessionId;
  for (;;) {
    const parent = parentOf(cur);
    if (!parent || seen.has(parent)) return cur;
    seen.add(parent);
    cur = parent;
  }
}

/** 拒绝时给人看的话。照 git 的口气：说清谁占着、为什么拦、怎么继续 */
export function conflictMessage(c: WorkspaceConflict): string {
  return (
    `另一只水獭正在这个文件夹里干活，先让它跑完：\n` +
    `  文件夹：${c.workspace}\n` +
    `  占用的会话：${c.heldBy}\n\n` +
    `两个会话同时在同一个文件夹里跑，一边切分支/改文件，另一边的改动会无声消失——` +
    `沙箱围的是路径，围不住共享的 .git。\n` +
    `继续的办法：等它跑完，或者让这个会话换一个文件夹（同一个仓库可以用 git worktree 开一份独立的工作目录）。`
  );
}
