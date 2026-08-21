// 设置页作用域下拉的候选。
// 候选来自"有过会话的工程文件夹"——不新开一条 IPC 去列目录:会话列表本来就在
// store 里,而一个从没开过会话的文件夹,用户也没有在那儿建子智能体的由头。
// 代价写在 ADR-0048「接受的代价」里:要先在那个工程开一次会话。

import { groupSessionsByWorkspace } from "../sessionGroups.js";
import type { SessionSummary } from "../../../shared/shellBridge.js";

export interface SubagentScopeOption {
  /** null = 用户级 */
  workspace: string | null;
  label: string;
}

export function subagentScopeOptions(sessions: readonly SessionSummary[]): SubagentScopeOption[] {
  return [
    { workspace: null, label: "用户" },
    ...groupSessionsByWorkspace([...sessions]).map((g) => ({
      workspace: g.workspace,
      label: g.label,
    })),
  ];
}
