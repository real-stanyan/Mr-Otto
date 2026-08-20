// 永久授权的落点：userData/permissions.json（ADR-0041）。
//
// 为什么不进事件日志：日志是**会话**的事实，而"永久允许 write_file"横跨所有会话，
// 包括还没建的那些。放进某一个会话的日志，等于让一条会话记录去管别的会话 ——
// 而日志的另一条硬规则是旧日志必须永远可重放：重放一段两年前的日志，不该把
// 当时按下的"永久"再次施加到今天。
//
// 授权发生的**那一刻**照旧在日志里（approval_decision.grant），所以每个会话
// 仍然自解释：谁在什么时候授的权，日志上写着；权现在还在不在，问这个文件。
//
// 文件形状故意做成最钝的一版：一个工具名数组。没有过期时间、没有路径限定 ——
// 那些都是"说不清就别做"的东西（见 shared/permissionGrants.ts 的粒度那段）。
// 撤销：目前只能删这个文件（设置页还没有入口）。

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

interface PermissionFile {
  /** 永久允许、不再弹审批的工具名 */
  alwaysAllow: string[];
}

export function loadAlwaysAllow(path: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PermissionFile;
    // 文件是外部输入(用户手改过、上个版本写的、被截断过),不赌形状
    if (!Array.isArray(parsed?.alwaysAllow)) return new Set();
    return new Set(parsed.alwaysAllow.filter((t): t is string => typeof t === "string"));
  } catch {
    return new Set(); // 没有文件 / 坏 JSON = 什么都没授过
  }
}

/** 记一条永久授权。幂等：授过的再授一次不变形状 */
export function addAlwaysAllow(path: string, tool: string): Set<string> {
  const allow = loadAlwaysAllow(path);
  allow.add(tool);
  const body: PermissionFile = { alwaysAllow: [...allow].sort() };
  mkdirSync(dirname(path), { recursive: true });
  // 0600:这份文件说的是"哪些危险操作不再问人",别人可写 = 别人可以替你点头
  writeFileSync(path, JSON.stringify(body, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return allow;
}
