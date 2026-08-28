// gitSafety —— 认出「会把工作区未提交改动直接丢掉」的 git 命令（issue #633，ADR-0153）
//
// 背景：ADR-0152 的工作区互斥管的是**水獭之间**。但踩掉未提交改动这件事，一只水獭
// 就够——它在用户的仓里跑一条破坏性 git，用户自己在编辑器里没保存进 commit 的活就没了。
// 互斥拦不住这个：只有一条 turn 在跑，规则完全满足。
//
// ── 一处需要说清楚的事实 ───────────────────────────────────────────────
// 「git checkout 会静默吃掉未提交改动」是个流传很广的误解。**普通的 `git checkout <分支>`
// 不会**：git 自己会拒绝——
//     error: Your local changes to the following files would be overwritten by checkout
// 冲突不到的改动它会带着一起过去。所以裸 checkout 不进这份名单，进了就是天天误报，
// 而误报会训练用户闭眼点「批准」，那比不拦更糟。
//
// 真正会丢东西的是下面这些：它们的语义**就是**「丢弃」，git 不会拦，因为你已经说了要丢。
//
// 判定走 canonicalizeCommand，但**不照搬它的严格度**：那份 META 是为授权 key 的等值
// 比较服务的，把 `~ ^ *` 这类也算复杂脚本；而 `git reset --hard HEAD~1` 里的 `~` 是 git
// 的 rev 语法，跟 shell 无关——照搬就会放过最典型的那一条（本模块第一版就栽在这）。
// 所以退化成 raw 时再看一眼：只有真正改语义的元字符（管道/逻辑/子 shell/命令替换/
// 重定向/转义）才放弃判定，其余按空白切一刀。宽一点的代价是多问一次，不是多放一条。

import { canonicalizeCommand } from "./grantKey.js";

export interface DestructiveGit {
  /** 给人看的一句话：这条命令要丢的是什么 */
  what: string;
  /** 命中的子命令，给日志/测试对齐用 */
  sub: string;
}

/** 有没有这个 flag（长短形式都认；`-fd` 这种粘连短 flag 也认） */
function hasFlag(argv: readonly string[], long: string, short?: string): boolean {
  return argv.some((t) => {
    if (t === long) return true;
    if (!short) return false;
    if (!t.startsWith("-") || t.startsWith("--")) return false;
    return t.slice(1).includes(short);
  });
}

/** 会改变命令语义的 shell 元字符。canonicalizeCommand 的 META 比这份严得多——它还把
    `~ ^ * ? [ ] { } !` 算进去，因为那些会影响**等值比较**（授权 key 要精确）。
    但本模块问的是另一个问题：「这条命令想干什么」。`git reset --hard HEAD~1` 里的 `~`
    是 git 的 rev 语法，跟 shell 无关——为它放弃判定，等于放过最典型的那一条。
    所以这里只挡真正会改语义的：管道/逻辑/多语句/子 shell/命令替换/重定向/转义/注释。 */
const MEANING_META = /[|&;<>()`$\\#]/;

/** 拿到 argv。先走 canonicalizeCommand（引号处理是对的）；它因为 rev 语法这类无害字符
    退化成 raw 时，在确认没有会改语义的元字符之后按空白切一刀兜底。
    兜底只用于**判定意图**，不产出任何授权 key——宽一点的代价是多问一次，不是多放一条。 */
function argvOf(cmd: string): string[] | null {
  const c = canonicalizeCommand(cmd);
  if (c.kind === "cmd") return JSON.parse(c.canon) as string[];
  if (MEANING_META.test(c.raw)) return null; // 真的复杂脚本：不猜
  return c.raw.split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ""));
}

/** 这条 git 命令会不会**丢掉工作区里未提交的改动**？会就返回描述，不会返回 null。
    只认真正「以丢弃为语义」的那几条——理由见文件头。 */
export function destructiveGit(cmd: string): DestructiveGit | null {
  const argv = argvOf(cmd);
  if (!argv) return null; // 复杂脚本不猜
  if (argv[0] !== "git") return null;

  // git 的全局选项（-C <dir> / -c k=v / --git-dir=… 等）夹在子命令前面
  let i = 1;
  while (i < argv.length) {
    const t = argv[i]!;
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree") {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  const sub = argv[i];
  if (!sub) return null;
  const rest = argv.slice(i + 1);

  switch (sub) {
    case "reset":
      // --hard 才动工作区；--soft/--mixed 只动 HEAD/索引，改动还在盘上
      return hasFlag(rest, "--hard")
        ? { sub, what: "把工作区回退到某个提交，未提交的改动全部丢弃" }
        : null;

    case "clean":
      // -n/--dry-run 只是列出来。真删要 -f（git 自己也要求）
      if (hasFlag(rest, "--dry-run", "n")) return null;
      return hasFlag(rest, "--force", "f")
        ? { sub, what: "删除未跟踪的文件（还没 git add 过的新文件）" }
        : null;

    case "checkout":
    case "switch": {
      // `checkout -- <路径>` / `checkout .` / `restore <路径>`：语义就是「把这些文件
      // 还原成 HEAD 的样子」，未提交改动直接没
      if (sub === "checkout" && (rest.includes("--") || rest.some((t) => t === "." || t.endsWith("/")))) {
        return { sub, what: "把指定文件还原成上次提交的样子，这些文件的未提交改动丢弃" };
      }
      // 强制切分支：这就是在对 git 说「我知道会覆盖，照做」
      if (hasFlag(rest, "--force", "f") || hasFlag(rest, "--discard-changes")) {
        return { sub, what: "强制切换，冲突的未提交改动被覆盖" };
      }
      // 裸 checkout/switch 不进名单——git 自己会拒绝（见文件头）
      return null;
    }

    case "restore":
      // restore 默认就是还原工作区；只带 --staged 时动的是索引，盘上的改动还在
      return hasFlag(rest, "--staged") && !hasFlag(rest, "--worktree", "W")
        ? null
        : { sub, what: "把指定文件还原成上次提交的样子，这些文件的未提交改动丢弃" };

    case "stash": {
      const op = rest.find((t) => !t.startsWith("-"));
      if (op === "drop" || op === "clear") {
        return { sub: `stash ${op}`, what: "丢掉暂存起来的改动（stash 里的东西找回来很难）" };
      }
      // `git stash` / `stash push` 本身会把工作区清空——改动没丢（在 stash 里），
      // 但在多 worktree 下 stash 栈是共享的，弹错人是本仓踩过的事故（#543）。
      // 不过那是「不该用 stash」的问题，不是「会丢东西」的问题，这里不拦。
      return null;
    }

    default:
      return null;
  }
}

/** 审批卡上的说明。列出会受影响的文件（截断），不摊开全部——卡片不是 git status */
export function dirtyWarning(d: DestructiveGit, dirty: readonly string[], limit = 10): string {
  const shown = dirty.slice(0, limit);
  const more = dirty.length - shown.length;
  return (
    `这条命令会${d.what}。\n` +
    `当前工作区有 ${dirty.length} 个文件带未提交改动：\n` +
    shown.map((f) => `  ${f}`).join("\n") +
    (more > 0 ? `\n  …还有 ${more} 个` : "") +
    `\n\n这些改动可能不是水獭做的——你自己在编辑器里改的东西也在里面。`
  );
}
