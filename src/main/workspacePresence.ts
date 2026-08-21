// workspacePresence — 盯着"当前会话的工作区此刻在哪个分支"(issue #167,ADR-0055)。
// 渲染层报 repoDir,这里算出 {repoKey, branch} 交给 FriendsManager.setWorkspace 去广播,
// 并 watch git 目录:checkout 会重写 HEAD,文件一变就重算。
// app 功能不是 agent 工具,主进程直用 fs.watch 合规(同 gitGraphService 的 child_process 先例)。
// DI:测试喂假 watch / 假 git。

import { watch } from "node:fs";
import type { WorkspacePresence } from "../shared/friends.js";

export interface WorkspacePresenceDeps {
  /** 算 {repoKey, branch};不是仓库/没 origin → null */
  workspace(repoDir: string): Promise<WorkspacePresence | null>;
  /** git 目录绝对路径(HEAD 住这里);不是仓库 → null */
  gitDir(repoDir: string): Promise<string | null>;
  /** 盯一个目录里的文件名变化。返回停止函数。盯不住(目录没了/平台不支持)就抛,调用方忍 */
  watchDir(dir: string, onFile: (filename: string | null) => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** HEAD 改写会连着触发几次事件(lock → rename),合并成一次重算 */
export const DEBOUNCE_MS = 200;
/** 兜底轮询:macOS 上 fs.watch 偶有漏报(尤其 rename 之后),慢速对一次账 */
export const POLL_MS = 60_000;

const nodeDeps: WorkspacePresenceDeps = {
  workspace: async () => null, // 占位:真实现由 index.ts 用 gitGraphService 注入
  gitDir: async () => null,
  watchDir(dir, onFile) {
    const w = watch(dir, { persistent: false }, (_ev, filename) => onFile(filename == null ? null : String(filename)));
    return () => w.close();
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface WorkspacePresenceWatcher {
  /** 换目标目录。null = 当前没有会话/没有工作区 → 广播 null。同一目录重复报是空操作 */
  setRepoDir(repoDir: string | null): void;
  /** 强制重算一次(比如窗口重新聚焦) */
  refresh(): void;
  dispose(): void;
}

export function createWorkspacePresence(
  onChange: (ws: WorkspacePresence | null) => void,
  partial: Partial<WorkspacePresenceDeps> = {}
): WorkspacePresenceWatcher {
  const deps: WorkspacePresenceDeps = { ...nodeDeps, ...partial };
  let repoDir: string | null = null;
  let stopWatch: (() => void) | null = null;
  let debounce: unknown = null;
  let poll: unknown = null;
  // 世代号:setRepoDir 切换后,上一目录还在飞的 async 结果作废
  let gen = 0;

  const compute = async (g: number): Promise<void> => {
    if (!repoDir) return;
    const ws = await deps.workspace(repoDir).catch(() => null);
    if (g !== gen) return;
    onChange(ws);
  };

  const scheduleCompute = (): void => {
    if (debounce !== null) deps.clearTimeout(debounce);
    const g = gen;
    debounce = deps.setTimeout(() => {
      debounce = null;
      void compute(g);
    }, DEBOUNCE_MS);
  };

  const teardown = (): void => {
    gen++;
    stopWatch?.();
    stopWatch = null;
    if (debounce !== null) { deps.clearTimeout(debounce); debounce = null; }
    if (poll !== null) { deps.clearInterval(poll); poll = null; }
  };

  return {
    setRepoDir(dir) {
      if (dir === repoDir) return;
      teardown();
      repoDir = dir;
      if (!dir) { onChange(null); return; }
      const g = gen;
      void (async () => {
        await compute(g);
        if (g !== gen) return;
        const gitDir = await deps.gitDir(dir).catch(() => null);
        if (g !== gen) return;
        if (gitDir) {
          try {
            // 盯目录不盯文件:git 用 rename 落 HEAD,盯文件本身会在第一次 rename 后失联
            stopWatch = deps.watchDir(gitDir, (name) => {
              if (name === null || name === "HEAD") scheduleCompute();
            });
          } catch {
            // 盯不住就只剩轮询那条腿
          }
        }
        poll = deps.setInterval(() => { void compute(g); }, POLL_MS);
      })();
    },
    refresh() {
      if (repoDir) scheduleCompute();
    },
    dispose() {
      teardown();
      repoDir = null;
    },
  };
}
