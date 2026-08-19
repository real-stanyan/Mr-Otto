// Git Graph — 主进程数据源:execFile 直调 git。log/commit/branches 只读;
// checkout 是唯一的写操作,且只能由用户在 UI 里显式选分支触发(ADR-0014 记录这个例外边界)。
// app 功能不是 agent 工具,主进程直用 child_process 合规(同 protocolService 先例)。
// DI 模式同 protocolService:测试喂假 execGit。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  classifyGitError, isValidBranchName, parseBranchList, parseGitLog, parseNumstat, pickSpineBranch,
  type CommitDetail, type GitBranchesResult, type GitCheckoutResult,
  type GitCommitResult, type GitLogResult,
} from "../shared/gitGraph.js";
import { mergeNumstat, parseGitStatus, type GitStatusResult } from "../shared/gitStatus.js";

export interface GitGraphDeps {
  /** git 子进程;reject 的错误对象带 code/stderr(classifyGitError 的输入形状) */
  execGit(args: string[], cwd: string): Promise<{ stdout: string }>;
  /** repoDir 是否存在——不存在的 cwd 会让 execFile 抛 ENOENT,与"没装 git"同码,先挡 */
  dirExists(dir: string): boolean;
}

const nodeDeps: GitGraphDeps = {
  execGit(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve({ stdout: String(stdout) });
      });
    });
  },
  dirExists(dir) {
    return existsSync(dir);
  },
};

/** log 记录:\x01 开记录,\x00 分字段(shared/gitGraph.parseGitLog 的约定) */
const LOG_FORMAT = "%x01%H%x00%P%x00%D%x00%an%x00%at%x00%s";
/** commit 详情字段:hash/作者/邮箱/时间戳/完整消息 */
const SHOW_FORMAT = "%H%x00%an%x00%ae%x00%at%x00%B";

/** 分支列表格式:%(HEAD) 是 "*"/空格,%(refname:short) 是短名(shared/parseBranchList 的约定) */
const BRANCH_FORMAT = "%(HEAD)%00%(refname:short)";

/** 首屏条数;滚到底再按这个步长往下要 */
export const DEFAULT_LOG_LIMIT = 300;
/** 天花板:渲染层传什么都不许突破。非整数/负数一律回落首屏值,不把脏数字拼进命令行 */
const MAX_LOG_LIMIT = 5000;

export function clampLogLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LOG_LIMIT;
  const i = Math.floor(n);
  if (i < 1) return DEFAULT_LOG_LIMIT;
  return Math.min(i, MAX_LOG_LIMIT);
}

export interface GitGraphService {
  /** limit 缺省 300;滚到底加载更多时渲染层要更大的窗口(整窗重拉,不分页,见 issue #29) */
  log(repoDir: string, limit?: number): Promise<GitLogResult>;
  commit(repoDir: string, hash: string): Promise<GitCommitResult>;
  branches(repoDir: string): Promise<GitBranchesResult>;
  /** 唯一的写操作:切分支。只服务"用户显式选分支",不给 agent 用 */
  checkout(repoDir: string, branch: string): Promise<GitCheckoutResult>;
  /** 工作区此刻脏在哪(只读)。行增删拿得到就贴上,拿不到不算失败 */
  status(repoDir: string): Promise<GitStatusResult>;
}

export function createGitGraphService(deps: GitGraphDeps = nodeDeps): GitGraphService {
  return {
    async log(repoDir, limit = DEFAULT_LOG_LIMIT) {
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      try {
        const { stdout } = await deps.execGit(
          // --decorate=full:%D 给全名(refs/heads/x、refs/remotes/fork/x)。短名下
          // remote 和"名字里带斜杠的本地分支"长得一样,只能靠 origin/ 前缀猜,猜错了画错徽章
          [
            "log", "--all", "--topo-order", "--decorate=full",
            "-n", String(clampLogLimit(limit)), `--format=${LOG_FORMAT}`,
          ],
          repoDir
        );
        // HEAD 单独拿:detached/正常都返回 hash;空仓库等失败情形容错为 null
        let head: string | null = null;
        try {
          head = (await deps.execGit(["rev-parse", "HEAD"], repoDir)).stdout.trim() || null;
        } catch {
          head = null;
        }
        // 主脊分支:origin/HEAD 最准(纯本地读 ref,不联网)。没设过 origin/HEAD 的仓库
        // 这条会失败,交给 pickSpineBranch 退 main/master/当前分支
        let remoteHead: string | null = null;
        try {
          const { stdout: sym } = await deps.execGit(
            ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
            repoDir
          );
          remoteHead = sym.trim().replace(/^[^/]+\//, "") || null;
        } catch {
          remoteHead = null;
        }
        const commits = parseGitLog(stdout);
        return { ok: true, head, commits, spineBranch: pickSpineBranch(commits, remoteHead) };
      } catch (e) {
        const err = e as { code?: string; stderr?: string; message?: string };
        // 空仓库:git log 报"没有 commit"不是错误,是合法空态
        if ((err.stderr ?? "").includes("does not have any commits")) {
          return { ok: true, head: null, commits: [], spineBranch: null };
        }
        return { ok: false, ...classifyGitError(err) };
      }
    },

    async commit(repoDir, hash) {
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      // 渲染层传来的 hash 只是"凭证"——验形后才进 exec,防注入(同 readAdr 路径钉死)
      // 上限 64 而不是 40:SHA-256 仓库的 hash 就是 64 位十六进制(git 的 objectFormat=sha256)
      if (!/^[0-9a-f]{4,64}$/i.test(hash)) {
        return { ok: false, kind: "git-error", detail: `非法 hash: ${hash}` };
      }
      try {
        const meta = await deps.execGit(
          ["show", "--no-patch", `--format=${SHOW_FORMAT}`, hash],
          repoDir
        );
        const stat = await deps.execGit(["show", "--numstat", "--format=", hash], repoDir);
        const [h, author, email, at, ...bodyParts] = meta.stdout.split("\x00");
        const detail: CommitDetail = {
          hash: h!,
          author: author!,
          email: email!,
          timestamp: Number(at),
          body: bodyParts.join("\x00").replace(/\n+$/, ""),
          files: parseNumstat(stat.stdout),
        };
        return { ok: true, detail };
      } catch (e) {
        return { ok: false, ...classifyGitError(e as { code?: string; stderr?: string; message?: string }) };
      }
    },

    async branches(repoDir) {
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      try {
        const { stdout } = await deps.execGit(["branch", "--list", `--format=${BRANCH_FORMAT}`], repoDir);
        const branches = parseBranchList(stdout);
        return { ok: true, current: branches.find((b) => b.current)?.name ?? null, branches };
      } catch (e) {
        return { ok: false, ...classifyGitError(e as { code?: string; stderr?: string; message?: string }) };
      }
    },

    async status(repoDir) {
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      try {
        // -z:路径不转义,中文/空格文件名照样是原样字节。--untracked-files=all:
        // 新建的目录要摊开到文件——"新建了 3 个文件"比"新建了 1 个目录"更接近用户在问的事
        const { stdout } = await deps.execGit(
          ["status", "--porcelain", "-z", "--branch", "--untracked-files=all"],
          repoDir
        );
        const status = parseGitStatus(stdout);
        // 行增删是锦上添花:空仓库(没有 HEAD)这条会失败,失败就没数字,不影响文件清单
        try {
          const { stdout: num } = await deps.execGit(["diff", "--numstat", "HEAD", "--"], repoDir);
          status.files = mergeNumstat(status.files, parseNumstat(num));
        } catch {
          // 保持没有数字的原样
        }
        return { ok: true, status };
      } catch (e) {
        return { ok: false, ...classifyGitError(e as { code?: string; stderr?: string; message?: string }) };
      }
    },

    async checkout(repoDir, branch) {
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      // 渲染层传来的分支名只是"凭证":验形后才进 exec(同 commit 的 hash 钉死路径)
      if (!isValidBranchName(branch)) {
        return { ok: false, kind: "git-error", detail: `非法分支名: ${branch}` };
      }
      try {
        // `--` 终止选项解析:即便验形漏了什么,git 也不会把分支名当选项读
        await deps.execGit(["checkout", branch, "--"], repoDir);
        return { ok: true, branch };
      } catch (e) {
        const err = e as { code?: string; stderr?: string; message?: string };
        const stderr = err.stderr ?? "";
        // 工作区脏是最常见的失败,且用户自己能解(提交/暂存)——单独成 kind,给可行动提示
        if (stderr.includes("would be overwritten") || stderr.includes("local changes")) {
          return { ok: false, kind: "dirty", detail: stderr.trim() };
        }
        return { ok: false, ...classifyGitError(err) };
      }
    },
  };
}
