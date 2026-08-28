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
  /** 会话标题，拿得到就带上（提示语里点名用；还没命名 → null/缺席） */
  title?: string | null;
}

export interface WorkspaceConflict {
  /** 占着的那个会话 */
  heldBy: string;
  /** 那个会话的标题，能拿到就带上。会话 id 对用户是一串没有意义的十六进制——
      他要做的事是「去看看那只水獭」，标题才认得出是哪一只。
      新会话还没自动命名 → null，退回只报 id（issue #653） */
  heldByTitle?: string | null;
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
    return { heldBy: s.sessionId, heldByTitle: s.title ?? null, workspace: s.workspace };
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

/** 两条互斥（进程内 ADR-0152 / 跨进程 ADR-0155）共用的措辞。
    共用不是为了省字数，是为了不再各自漂移：这两句原先各写各的，其中一句漂到了
    「同一个仓库可以用 git worktree 开一份独立的工作目录」——而 ADR-0157 之后 git
    文件夹各自拿了副本、根本撞不上，那句建议只在**非 git 文件夹**这唯一还会出现的
    场合露面，对着不用 git 的人说 worktree（issue #653）。

    所以这两段刻意不提 git：会读懂 worktree 的那批用户，已经在这条提示的适用范围之外了。 */
export const EXCLUSION_WHY =
  `同一个文件夹，同一时刻只让一只水獭动手——这是故意的，不是出错了。\n` +
  `两只水獭同时改同一批文件，后写的会把先写的悄悄盖掉，事后谁也说不清丢了什么。`;

/** 真正的出路。文案类工作想并行，正常做法是**两个文件夹各写各的**，
    而不是同一个文件夹里两只手（issue #653 第三条） */
export const EXCLUSION_WAY_OUT =
  `想让两只水獭真的同时干活：给这个会话换一个文件夹，各写各的，互不打架。`;

/** 走到这条提示，说明本来该有的独立副本没建成（ADR-0161 之后，非 git 目录改走
    文件级的闸 + 协作记录，根本不来这儿）。这句话是诊断：不说的话，用户只知道
    自己被拦了，不知道系统本来打算怎么伺候他。仍然不提 git 术语（issue #653） */
export const EXCLUSION_FALLBACK =
  `正常情况下每只水獭都拿一份独立的工作副本，各干各的互不相干。这次没建成，才退回到同一个文件夹。`;

/** 拒绝时给人看的话。照 git 的口气：说清谁占着、为什么拦、怎么继续 */
export function conflictMessage(c: WorkspaceConflict): string {
  return (
    `另一只水獭正在这个文件夹里干活，先让它做完：\n` +
    `  文件夹：${c.workspace}\n` +
    `  正在忙的会话：${c.heldByTitle ? `${c.heldByTitle}（${c.heldBy}）` : c.heldBy}\n\n` +
    `${EXCLUSION_WHY}\n` +
    `${EXCLUSION_FALLBACK}\n\n` +
    `怎么办：\n` +
    `  · 等它做完，再把这条消息发一次；\n` +
    `  · ${EXCLUSION_WAY_OUT}`
  );
}
