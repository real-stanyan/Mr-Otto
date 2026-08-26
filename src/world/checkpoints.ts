// 影子 git 检查点（issue #395 / ADR-0090，Claude Code shadow-repo 对照）——
// CheckpointCapability 的 LocalWorld 系实现。
//
// 形态：每个工作区一个独立 git 仓（--git-dir 指到 ~/.mr-otto/checkpoints/<hash>，
// --work-tree 指回工作区），与工作区自己的 .git **互不相识**：
// - 工作区是 git 仓时，它的 .git 目录天然不被影子仓跟踪（git 不收名叫 .git 的
//   目录）——restore 永远不碰用户的分支/暂存区/历史，只还原工作文件
// - 工作区的 .gitignore 照常生效（gitignore 从 work-tree 读）：被忽略的文件
//   （node_modules、.env…）不进快照、也**不被 restore 还原**——已知边界
// - 子目录里的嵌套 git 仓会被记成 gitlink（只有指针没有内容），restore
//   还原不了它们的内容——已知边界，CC 的影子仓同款
//
// save = add -A + commit --allow-empty（无改动也出新 id：每个 turn 一个锚点，
// 树对象复用，空间近零）；每个 commit 另挂 refs/checkpoints/<id> 保可达——
// restore 用 reset --hard 会把"未来"的 commit 甩出 HEAD 链，没有 ref 兜着
// 迟早被 gc 收走，那些正是用户可能还要"回到"的点。
// restore = reset --hard <id>：被跟踪文件全部回位，快照后新建（且已进过
// 后续快照）的文件被删掉；从未进过任何快照的文件不动（untracked 保护）。
//
// spawn git 二进制（不走 shell，参数数组无注入面）；本文件与 localWorld 同级
// ——src/world 是允许碰 node API 的层（架构测试圈的是 src/tools）。

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { CheckpointCapability } from "./executionWorld.js";

/** 单条 git 命令的硬超时：大仓首次 add -A 可能要吞几十万文件，给足；
    挂死（网络文件系统等）不该挂死 turn——超时按失败抛，自动存档侧会吞成警告 */
const GIT_TIMEOUT_MS = 120_000;

/** 快照库目录名：工作区绝对路径的 sha256 前 16 位——路径里的斜杠/空格/中文
    不适合直接当目录名，哈希稳定且无碰撞之忧（16 hex = 64 bit） */
export function workspaceStoreName(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
}

/** Default 工作区的影子仓按会话一份（#573）：同一个文件夹被所有「任务」会话
    共写,共享一份影子仓时 A 会话的 reset --hard 会把 B 会话的文件一起回退。
    按会话拆开后,B 在 A 的快照之后新建的文件在 A 的仓里是 untracked——
    reset --hard 天然不碰,A 回退不再吞 B 的新产出（B 对早已存在的共享文件的
    改动仍会被波及,那一半靠提示词的通名警示压概率,见 PACKAGE_NUDGE）。
    项目工作区维持共享一份:大仓按会话复制血亏,且串扰概率低。
    sessionId 形状是 `s-<时间戳>-<hex>`（newSessionId）,直接可作目录名 */
export function sessionCheckpointStoreName(workspace: string, sessionId: string): string {
  return `${workspaceStoreName(workspace)}-${sessionId}`;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runGit(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { timeout: timeoutMs, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (e) => reject(new Error(`git 起不来：${e.message}`)));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`git ${args[2] ?? args[0]} 被 ${signal} 终止（超时 ${timeoutMs}ms）`));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export function createShadowGitCheckpoints(opts: {
  workspace: string;
  /** 影子仓的 git-dir（如 ~/.mr-otto/checkpoints/<hash>）。调用方负责选址 */
  gitDir: string;
}): CheckpointCapability {
  const { workspace, gitDir } = opts;
  // 每条命令都带上下文旗标 + 内联身份/行为配置：不依赖全局 gitconfig
  //（用户没配 user.name 的机器上 commit 不该失败），不签名、不走模板钩子
  const base = [
    "--git-dir", gitDir,
    "--work-tree", workspace,
    "-c", "user.name=Mr Otto",
    "-c", "user.email=checkpoint@mr-otto.local",
    "-c", "commit.gpgsign=false",
    "-c", "core.autocrlf=false",
    "-c", "gc.auto=0",
  ];

  async function git(args: string[]): Promise<string> {
    const r = await runGit([...base, ...args]);
    if (r.code !== 0) {
      throw new Error(`git ${args[0]} 失败（exit ${r.code}）：${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  }

  /** init 幂等（已是仓 = "Reinitialized"，零破坏），每次 save/restore 前都过一遍
      ——比缓存"已初始化"标志可靠：快照库目录可能被用户手动清掉 */
  async function ensureRepo(): Promise<void> {
    await mkdir(gitDir, { recursive: true });
    await git(["init", "-q"]);
  }

  return {
    async save(label: string): Promise<string> {
      await ensureRepo();
      await git(["add", "-A"]);
      // --allow-empty：无改动也出新 commit——每个 turn 一个可寻址锚点，
      // 树对象全复用，代价近零；-m 的 label 只是给人看的注记
      await git(["commit", "-q", "--allow-empty", "-m", label || "checkpoint"]);
      const id = (await git(["rev-parse", "HEAD"])).trim();
      // ref 保可达：restore 的 reset --hard 会把后续 commit 甩出 HEAD 链
      await git(["update-ref", `refs/checkpoints/${id}`, id]);
      return id;
    },

    async restore(id: string): Promise<void> {
      if (!/^[0-9a-f]{7,40}$/.test(id)) {
        throw new Error(`检查点 id 形状非法：${id}`);
      }
      await ensureRepo();
      await git(["reset", "--hard", "-q", id]);
    },
  };
}
