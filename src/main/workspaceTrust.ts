// 工作区信任门禁（issue #353 ③）：未信任的工作区**不加载**其指令文件——
// 陌生仓库里塞一份恶意 AGENTS.md 是现成的 prompt injection 载体，指令必须
// 在用户点头之后才进模型上下文。
//
// 落点 userData/trustedWorkspaces.json（permissions.json 同款手法）：
// 信任是跨会话的机器级决定，不属于任何一个会话的日志；"哪一刻注入了什么"
// 照旧由 project_instructions 事件在会话里自解释。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface TrustFile {
  trusted: string[];
}

export function loadTrustedWorkspaces(path: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TrustFile;
    if (!Array.isArray(parsed?.trusted)) return new Set();
    return new Set(parsed.trusted.filter((t): t is string => typeof t === "string"));
  } catch {
    return new Set(); // 没有文件 / 坏 JSON = 什么都没信任过（fail-closed）
  }
}

/** 信任一个工作区（幂等）。没有"取消信任"入口时删文件即可——同 permissions.json 现状 */
export function addTrustedWorkspace(path: string, workspace: string): Set<string> {
  const trusted = loadTrustedWorkspaces(path);
  trusted.add(workspace);
  const body: TrustFile = { trusted: [...trusted].sort() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
  return trusted;
}
