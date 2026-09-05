// agentToolsForm —— 工作区 agent 编辑弹窗里「连接器」那张勾选表的纯逻辑（切片 2）。
// 换算复用 proxyShare.ts（ProxySelection / buildAllow …），这里只回答三件
// proxyShare 不知道的事：候选行从哪来（工作区快照的 connectors）、「全部 / 只用
// 勾选的」两档怎么映射到 [] 这个编码、哪种草稿不许存。
//
// 候选行按 serverId 合并：runtime 过滤只看 serverId（agentToolAllow.ts），界面上
// 按 host 拆两行会让人以为能分开授权、实际做不到。工具名只在**每个**贡献者都点了
// 名时才列得出来——有人 tools:[] 整台放行时，那台此刻有哪些工具本机快照里没有
// （在 edge 的托管箱里），只能整台勾。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { AgentToolAllow } from "../../../shared/agentToolAllow.js";
import { buildAllow, isServerOn, type ProxySelection } from "./proxyShare.js";
import { labelOf } from "./workspaceView.js";

export type ToolsMode = "all" | "some";

export interface ConnectorChoice {
  serverId: string;
  hostLabels: string[];
  /** null = 至少一个贡献者整台放行，工具名列不出来，只能整台勾 */
  toolNames: string[] | null;
}

export function connectorChoices(ws: WorkspaceSnapshot): ConnectorChoice[] {
  const byServer = new Map<string, ConnectorChoice>();
  for (const c of ws.connectors) {
    const cur = byServer.get(c.serverId) ?? { serverId: c.serverId, hostLabels: [], toolNames: [] };
    cur.hostLabels.push(labelOf(ws, c.hostUid));
    if (c.tools.length === 0) cur.toolNames = null;
    else if (cur.toolNames !== null) {
      for (const t of c.tools) if (!cur.toolNames.includes(t)) cur.toolNames.push(t);
    }
    byServer.set(c.serverId, cur);
  }
  return [...byServer.values()];
}

export function modeFromTools(tools: readonly AgentToolAllow[]): ToolsMode {
  return tools.length === 0 ? "all" : "some";
}

/** [] 在线上是「整池放行」，所以「只用勾选的」却一台都没勾不能存——存出去就是
    把用户的「都不要」翻译成「都要」（proxyShare.ts 文件头的同一条约定，高一层） */
export function toolsDraftError(mode: ToolsMode, sel: ProxySelection): string | null {
  if (mode === "some" && buildAllow(sel).length === 0) return "至少勾一台连接器，或改回「全部连接器」";
  return null;
}

export function toolsFromDraft(mode: ToolsMode, sel: ProxySelection): AgentToolAllow[] {
  return mode === "all" ? [] : buildAllow(sel).map((a) => ({ serverId: a.serverId, tools: [...a.tools] }));
}

/** 勾选表里还留着、候选行里已经没有的 serverId——那台连接器已经被撤回，
    但这只 agent 存量的白名单还点着它的名。`buildAllow` 只看 `sel` 不看
    `choices`，回填时（selectionFromAllow）这种条目原样进了 sel，界面却
    因为 connectorChoices(ws) 里没有它而一行都不画——用户会看见「一个都
    没勾」却存不掉/存下去后隐藏条目原样带走。列出来渲染成一行，不能悄悄
    丢：那等于替用户把一份没碰过的授权收窄了 */
export function staleSelections(sel: ProxySelection, choices: readonly ConnectorChoice[]): string[] {
  const known = new Set(choices.map((c) => c.serverId));
  return Object.keys(sel).filter((id) => isServerOn(sel, id) && !known.has(id));
}
