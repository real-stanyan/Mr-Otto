// sessionWorktree —— 两只水獭同一个项目并行干活（issue #641，ADR-0156）
//
// ADR-0152 曾把这条否掉，选了「只拒绝、排队」。维护者复盘后要真并行，那条否决作废。
//
// 形状照 Claude Code：**隔离靠 git 自己**。第二只水獭拿到的是同一个仓库的一个
// 一次性 worktree —— 独立工作目录、独立 HEAD、独立分支。git 拒绝同一分支被两处
// checkout，所以「互切对方分支」这个动作根本不存在，不需要任何协调机制。
//
// ── 三个不显然的选择 ──────────────────────────────────────────────
//
// **第一只不隔离**。用户在 GUI 里点了个文件夹，他的编辑器开着那个文件夹——单只水獭
// 时把它挪进 worktree，等于第一次用就要他理解「你的活在别的目录、回头要 merge」。
// 隔离只在真的出现第二只时才发生，那时用户本来就在做一件更复杂的事。
//
// **worktree 不放在用户的仓库里**。放 `<repo>/.mr-otto/worktrees/…` 会进他的
// `git status`、可能被误提交。落在 userData 下（与 ADR-0155 的锁文件同一个理由：
// 用户的目录是他的）。git 的 worktree 本来就可以在任何位置。
//
// **判据是「同一个仓库」而不是「同一个路径」**。已经在某个 worktree 里的会话，与
// 主目录里的会话共享同一个 `.git`——分支空间是共享的，所以算同一个项目。
// 这也让第三只水獭正确地拿到第三个 worktree，而不是与第二只撞在一起。
//
// 纯函数、零 IO：命名、判据、文案。真正的 `git worktree add` 在 main 层。

/** 一个会话此刻的隔离状态。落进 `session_created.isolated`（已知类型上的新增可选
    字段，旧日志照常重放——schema 硬规则），于是「我在一份副本上干活」这件事
    可以从日志推导，不靠运行时配置 */
export interface IsolatedWorkspace {
  /** 用户当初选的那个项目目录（主 checkout）。合回去的目的地在这里 */
  projectRoot: string;
  /** 这只水獭独占的分支 */
  branch: string;
}

/** 分支名：`otto/<slug>-<6位随机>`。
    随机后缀照 Claude Code —— 两只水獭同一天开同一个项目也撞不了名，
    而撞名的代价是 `git worktree add` 直接失败、会话建不起来 */
export function isolatedBranchName(slug: string, rand: string): string {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `otto/${safe || "session"}-${rand}`;
}

/** worktree 目录名。同时含项目哈希与分支后缀：同一台机器上多个项目、同一个项目多只
    水獭都不会撞。调用方把它拼在 userData 的 worktrees 目录下 */
export function isolatedDirName(projectHash: string, rand: string): string {
  return `${projectHash.slice(0, 12)}-${rand}`;
}

/** 该不该给这个新会话开 worktree？
    要三个条件同时成立：
    - 这个工作区在一个 git 仓库里（不是仓库 → 没有 worktree 这回事，退回排队）
    - 已经有**活着的**会话在同一个仓库里（第一只不隔离，见文件头）
    - 那个会话不是本会话的家族成员（子会话 / SideChat 共享工作区是故意的） */
export function shouldIsolate(candidate: {
  /** 本会话工作区所属仓库的 `.git` 绝对路径；不是仓库 → null */
  repo: string | null;
  familyRoot: string;
}, live: readonly { repo: string | null; familyRoot: string }[]): boolean {
  if (!candidate.repo) return false;
  return live.some((s) => s.repo === candidate.repo && s.familyRoot !== candidate.familyRoot);
}

/** 注进系统提示的那一段：告诉水獭它在副本上，以及怎么把活交回去。
    放在 shared 是因为 `deriveMessages`（投影）和 `contextEstimate`（占用估算）
    共用同一处文案——两边各写一份，「系统提示词占多少」就是猜的 */
export function isolatedPromptText(iso: IsolatedWorkspace): string {
  return (
    `\n注意：这个文件夹是一份**独立工作副本**（git worktree），分支 \`${iso.branch}\`。` +
    `项目本体在 ${iso.projectRoot}，那边可能有另一只水獭在同时干活。\n` +
    `所以：只改这份副本，别去动项目本体的目录；活干完了提交在自己分支上，` +
    `用户要合并时再把 \`${iso.branch}\` 合回去（先问一句合到哪个分支）。\n`
  );
}
