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
// **每只水獭都隔离**（issue #644 取消了 0156 的「第一只不隔离」）。曾经留过那条例外，
// 怕第一次用的人就面对「你的活在别的目录、回头要 merge」；取消它换来的是一条规则而不是
// 两条——不用再解释「什么时候会隔离、什么时候不会」，也不会出现「第一只在原目录、第二只
// 在副本」这种两只水獭形态不一致的局面。
//
// 代价是真的：**用户打开自己的项目目录会看不到任何改动**，直到合并。缓解写在
// isolatedPromptText 里——水獭在动文件之前先讲明白这件事。
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
  /** 创建那一刻的分支名。**会被改名**（issue #647：自动标题出来后跟着走），
      所以这个字段是「当初叫什么」的历史记录，不是「此刻叫什么」——
      要当前名字就去问 git（`git branch --show-current`）。
      日志是 append-only，改不了；提示语因此不写死分支名，否则会陈旧 */
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
    只剩一个条件：**这个工作区在一个 git 仓库里**（issue #644）。
    不是仓库 → 没有 worktree 这回事，退回原目录（ADR-0152 的互斥在那儿兜底）。

    「已经有别的会话占着吗」这个条件在 #644 里去掉了：留着它就有两条规则、两种形态，
    而两只水獭形态不一致（一只在原目录、一只在副本）比两只都在副本更难解释。

    子会话 / SideChat 不走这条路——它们直接继承父会话的 workspace，压根不问这个函数。 */
export function shouldIsolate(candidate: {
  /** 本会话工作区所属仓库的 `.git` 绝对路径；不是仓库 → null */
  repo: string | null;
}): boolean {
  return candidate.repo !== null;
}

/** 注进系统提示的那一段：告诉水獭它在副本上，以及怎么把活交回去。
    放在 shared 是因为 `deriveMessages`（投影）和 `contextEstimate`（占用估算）
    共用同一处文案——两边各写一份，「系统提示词占多少」就是猜的 */
export function isolatedPromptText(iso: IsolatedWorkspace): string {
  return (
    `\n注意：这个文件夹是一份**独立工作副本**（git worktree），有自己的分支` +
    `（要用名字时现查：\`git branch --show-current\`）。` +
    `项目本体在 ${iso.projectRoot}，那边可能有另一只水獭在同时干活。\n` +
    `所以：只改这份副本，别去动项目本体的目录；活干完了提交在自己分支上，` +
    `用户要合并时再把这条分支合回去（先问一句合到哪个分支）。\n` +
    // 用户看不到副本里的改动——他打开自己的项目目录会以为你什么都没干。
    // 这是这套隔离的全部代价，所以必须由你在动手之前主动说，不能等他来问
    `重要：用户很可能不知道有这份副本。**第一次动文件之前**，先用一句话告诉他：` +
    `你在一份独立副本上干活、他的项目目录暂时不会变、要合回去随时说。\n`
  );
}

/** 会话有标题之后，副本分支改叫什么。保留原来的随机后缀——目录名带着它，
    改名只换可读的那一半，两边仍然对得上。
    标题里没有可用字符（纯中文/纯符号）→ 返回 null，不改名（留着原名比改成
    `otto/-a1b2c3` 强） */
export function renamedBranch(oldBranch: string, title: string): string | null {
  const suffix = oldBranch.slice(oldBranch.lastIndexOf("-") + 1);
  if (!/^[0-9a-f]{6}$/.test(suffix)) return null; // 不是我们建的那种名字，不碰
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!slug) return null;
  const next = `otto/${slug}-${suffix}`;
  return next === oldBranch ? null : next;
}
