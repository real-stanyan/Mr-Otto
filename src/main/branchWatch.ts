// branch_checked_out 的第二个发射点（issue #568，ADR-0093 的补完）。
//
// ADR-0093 把「切分支」定为日志事实，但发射点只有顶栏 checkout 一个——
// agent 在 bash 里 git checkout 完全绕过它，事件从未落盘（实测两个实例
// 历史总数为 0）。真相不该取决于是谁按的按钮：bash 调用前后各读一次
// .git/HEAD，分支名变了就是切了，跟命令的退出码无关（checkout 成功、
// 后续命令失败，切换仍是事实）。
//
// 为什么读 fs 而不是问 git：与 projectRoot.ts 同一取舍——HEAD 是纯文本，
// 起 git 子进程只为读一行不值得。为什么不用 world.fs：它圈在 workspace 内
// （软沙箱），而 worktree 的 gitdir 指向主仓 .git/worktrees/<名>，在圈外；
// 本模块是主进程装配件（组装根特权可碰 fs），reader 注入、测试喂假实现。
//
// 刻意不覆盖（写明代价）：外部终端切分支（app 进程外没有钩子）；bash 里
// cd 到别的仓库切分支（会话时间线管的是 workspace 所在仓库的脚下事实）；
// run_in_background 的命令（结果回来时 turn 早收口，比对窗口已关）。

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolMiddleware } from "../loop/middleware.js";

/** 读不到/不是文件都返回 null（同 projectRoot.GitFsReader 的语义） */
export interface HeadReader {
  readFile(path: string): string | null;
}

const nodeReader: HeadReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/** 同 projectRoot 的 MAX_ASCEND：防挂载点/深目录爬到天荒地老 */
const MAX_ASCEND = 12;

/** HEAD 内容 → 分支名。裸 sha（detached）→ null，不编名字（同 ADR-0093） */
function parseHead(content: string): string | null {
  const m = /^ref: refs\/heads\/(.+?)\s*$/m.exec(content);
  return m ? m[1]! : null;
}

/**
 * workspace 所在仓库此刻的分支。null = 一路没有 .git。
 * repoDir 是**这个 workspace 的**仓库根（worktree 不折叠回主仓——时间线要答的
 * 是「脚下这份 checkout 在哪个分支」，与 projectRoot 折叠记忆作用域的结论相反）。
 */
export function currentBranch(
  workspace: string,
  reader: HeadReader = nodeReader
): { repoDir: string; branch: string | null } | null {
  let dir = resolve(workspace);
  for (let i = 0; i <= MAX_ASCEND; i++) {
    // 普通仓库：.git 是目录，直接读 HEAD
    const head = reader.readFile(join(dir, ".git", "HEAD"));
    if (head !== null) return { repoDir: dir, branch: parseHead(head) };
    // worktree/submodule：.git 是文件，HEAD 在 gitdir 指向的目录里
    const gitFile = reader.readFile(join(dir, ".git"));
    if (gitFile !== null) {
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(gitFile);
      if (m) {
        const gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
        const wtHead = reader.readFile(join(gitdir, "HEAD"));
        return { repoDir: dir, branch: wtHead !== null ? parseHead(wtHead) : null };
      }
      return { repoDir: dir, branch: null }; // .git 文件但认不出形状：仓库在，分支问不出
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 工具管线中间件：bash 调用前后比对 HEAD，切了就报给 onSwitch
 * （agent.ts 在那头 append branch_checked_out + 推送）。
 * 切完是 detached（发不出名字）不报；切之前是 detached 则 from 缺席。
 */
export function createBranchWatchMiddleware(opts: {
  workspace: string;
  reader?: HeadReader;
  onSwitch(info: { repoDir: string; branch: string; from?: string }): void;
}): ToolMiddleware {
  const reader = opts.reader ?? nodeReader;
  return async (ctx, next) => {
    if (ctx.call.name !== "bash") return next();
    const before = currentBranch(opts.workspace, reader);
    const outcome = await next();
    const after = currentBranch(opts.workspace, reader);
    if (after?.branch && after.branch !== before?.branch) {
      opts.onSwitch({
        repoDir: after.repoDir,
        branch: after.branch,
        ...(before?.branch ? { from: before.branch } : {}),
      });
    }
    return outcome;
  };
}
