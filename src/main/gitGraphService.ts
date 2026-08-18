// Git Graph — 主进程数据源:execFile 直调 git,严格只读(log/rev-parse/show)。
// app 功能不是 agent 工具,主进程直用 child_process 合规(同 protocolService 先例)。
// DI 模式同 protocolService:测试喂假 execGit。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  classifyGitError, parseGitLog, parseNumstat,
  type CommitDetail, type GitCommitResult, type GitLogResult,
} from "../shared/gitGraph.js";

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

export interface GitGraphService {
  log(repoDir: string): Promise<GitLogResult>;
  commit(repoDir: string, hash: string): Promise<GitCommitResult>;
}

export function createGitGraphService(deps: GitGraphDeps = nodeDeps): GitGraphService {
  return {
    async log(repoDir) {
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      try {
        const { stdout } = await deps.execGit(
          ["log", "--all", "--topo-order", "-n", "300", `--format=${LOG_FORMAT}`],
          repoDir
        );
        // HEAD 单独拿:detached/正常都返回 hash;空仓库等失败情形容错为 null
        let head: string | null = null;
        try {
          head = (await deps.execGit(["rev-parse", "HEAD"], repoDir)).stdout.trim() || null;
        } catch {
          head = null;
        }
        return { ok: true, head, commits: parseGitLog(stdout) };
      } catch (e) {
        const err = e as { code?: string; stderr?: string; message?: string };
        // 空仓库:git log 报"没有 commit"不是错误,是合法空态
        if ((err.stderr ?? "").includes("does not have any commits")) {
          return { ok: true, head: null, commits: [] };
        }
        return { ok: false, ...classifyGitError(err) };
      }
    },

    async commit(repoDir, hash) {
      if (!deps.dirExists(repoDir)) return { ok: false, kind: "no-repo", detail: `目录不存在: ${repoDir}` };
      // 渲染层传来的 hash 只是"凭证"——验形后才进 exec,防注入(同 readAdr 路径钉死)
      if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
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
  };
}
