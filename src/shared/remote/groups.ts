// 会话按工作区分组。**这是灵动岛那套(native/MrOttoIsland/IslandView.swift 的
// workspaceGroups + workspaceHeader)的 TypeScript 版**,三个投影窗口看到的
// 分组必须是同一套,否则同一份 IslandFleet 在桌面、岛、手机上长得不一样。
//
// 两条从 Swift 那侧照搬过来的规矩,都不是随手定的:
//
// 1. **只合并相邻的同工作区**,不做全局 Map 归并。fleet 的顺序是主进程排好的
//    (侧栏可见顺序),全局归并会把它打乱 —— 分组是给顺序**加一层**,不是重排。
// 2. **收起时组内状态不能凭空消失**:组里有等审批的给 warn 点(要人动手的那种,
//    绝不能被收起藏没),否则有 active 给 busy 点。这是收起功能能不能用的前提。
//
// 纯文件:不许 import node builtin / electron(手机端 import 同一份)。

import type { IslandAgent } from "../shellBridge.js";

/** 没有 workspace 的(旧主进程不带这个字段)归到这个组 */
export const OTHER_GROUP = "其他";

export interface WorkspaceGroup {
  /** 工作区全路径,也是收起状态的键。没有 workspace 时是 OTHER_GROUP */
  key: string;
  /** 组头显示名:路径末段 */
  label: string;
  agents: IslandAgent[];
}

export function groupByWorkspace(agents: readonly IslandAgent[]): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = [];
  for (const agent of agents) {
    const key = agent.workspace ?? OTHER_GROUP;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.agents.push(agent);
    else groups.push({ key, label: basename(key), agents: [agent] });
  }
  return groups;
}

/** 收起时组头要显示的状态点。null = 组里没有需要冒出来的状态 */
export function groupTone(g: WorkspaceGroup): "warn" | "busy" | null {
  if (g.agents.some((a) => a.phase === "approval")) return "warn";
  if (g.agents.some((a) => a.phase === "active")) return "busy";
  return null;
}

/** 路径末段。末尾的斜杠不算一段("/a/b/" 的显示名是 b 不是空串) */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  const name = i < 0 ? trimmed : trimmed.slice(i + 1);
  return name || path;
}
