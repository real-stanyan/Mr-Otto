// 设置页「清理空的任务文件夹」（#851）：归档不删子目录（用户产物不因归档消失），
// 于是空壳会攒起来。只删两个条件都满足的：名字是 sessionId 形状 + 目录为空。
// rmdir 非递归——非空目录 ENOTEMPTY 就是「留着」，不是错误。
import { readdirSync, rmdirSync } from "node:fs";
import { isSessionFolderName, sessionWorkspaceUnder } from "../shared/defaultWorkspace.js";

export interface PruneFs {
  list(dir: string): { name: string; isDir: boolean }[];
  rmdirIfEmpty(abs: string): boolean;
}

/** @param live 此刻活着的会话 id（文件夹名 = sessionId）：活着的会话刚建目录时也是空的，
    删掉它等于把正在跑的水獭的 cwd 抽走——空不空不是唯一判据 */
export function pruneEmptyTaskFolders(
  builtin: string,
  fs: PruneFs,
  live: ReadonlySet<string> = new Set(),
): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  for (const e of fs.list(builtin)) {
    if (!e.isDir || !isSessionFolderName(e.name) || live.has(e.name)) continue;
    if (fs.rmdirIfEmpty(sessionWorkspaceUnder(builtin, e.name))) removed++;
    else kept++;
  }
  return { removed, kept };
}

export const nodePruneFs: PruneFs = {
  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return [];
    }
  },
  rmdirIfEmpty(abs) {
    try {
      rmdirSync(abs);
      return true;
    } catch {
      return false;
    }
  },
};
