// workspaceMemoryView —— 设置页「记忆」tab 的纯逻辑（#949，spec §6）。
// 名单里每只 agent 都出一份档（没行 = 空档，人能第一次写进去）；行里有但名单里没有的
// agentId 是被删 agent 的残留，画出来标 stale——不静默丢（#722「撒谎的勾」的一般形式）

import type { WorkspaceMemoryRow, WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { charCount, formatEntries, parseEntries } from "../../../shared/memoryStore.js";
import { SHARED_MEMORY_AGENT_ID, WORKSPACE_MEMORY_LIMITS, type WorkspaceMemoryTier } from "../../../shared/workspaceMemory.js";

export interface MemoryDocView {
  agentId: string;
  title: string;
  tier: WorkspaceMemoryTier;
  content: string;
  used: number;
  limit: number;
  stale: boolean;
}

function doc(agentId: string, title: string, tier: WorkspaceMemoryTier, content: string, stale: boolean): MemoryDocView {
  return { agentId, title, tier, content, used: charCount(formatEntries(parseEntries(content))), limit: WORKSPACE_MEMORY_LIMITS[tier], stale };
}

export function memoryDocs(ws: WorkspaceSnapshot, rows: readonly WorkspaceMemoryRow[]): MemoryDocView[] {
  const byId = new Map(rows.map((r) => [r.agentId, r.content]));
  const out: MemoryDocView[] = [doc(SHARED_MEMORY_AGENT_ID, "共享档", "shared", byId.get(SHARED_MEMORY_AGENT_ID) ?? "", false)];
  for (const a of ws.agents) out.push(doc(a.agentId, a.name, "own", byId.get(a.agentId) ?? "", false));
  const known = new Set([SHARED_MEMORY_AGENT_ID, ...ws.agents.map((a) => a.agentId)]);
  for (const r of rows) if (!known.has(r.agentId)) out.push(doc(r.agentId, `已删除的智能体 ${r.agentId}`, "own", r.content, true));
  return out;
}
