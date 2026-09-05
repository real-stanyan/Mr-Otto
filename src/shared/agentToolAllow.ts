// agentToolAllow —— 工作区 agent 的连接器白名单（spec §3，切片 2）。
// 三端共用一份（runtime 过滤 / 桌面快照与表单 / 手机端将来），只有类型 + 纯函数。
//
// 口径与 workspace_connectors / proxyShare.ts 一致，两层都是「空 = 全给」：
//   顶层 []                    = 整池放行（这只 agent 拿得到工作区里贡献的全部连接器）
//   条目 { serverId, tools: [] } = 这台服务的全部工具
//   条目 { serverId, tools: [..] } = 只给点名的这几个
// 「一台都不给」在这个编码里**表达不了**——表单层负责不让用户存出那种状态
// （agentToolsForm.ts 的 toolsDraftError）。
//
// 匹配只看 serverId 不看 hostUid：两个成员各自贡献了同一个 serverId 时两台都放行。
// 白名单是「配错了」的护栏不是越权闸（spec §11），真正的三道闸在 edge 的 pxGate。

export interface AgentToolAllow {
  serverId: string;
  tools: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** jsonb → 白名单。形状不对（不是数组 / 条目缺 serverId / tools 不是字符串数组）
    整份回 []——顶层 [] 是**整池放行**，这是本函数刻意的 fail-open：接受它是因为
    白名单是「配错了」的护栏不是越权闸（真闸在 edge 的 pxGate），而这一列
    `not null default '[]'`、唯一写入方是带类型的 IPC，坏数据本就进不来。*/
export function normalizeAgentTools(value: unknown): AgentToolAllow[] {
  if (!Array.isArray(value)) return [];
  const out: AgentToolAllow[] = [];
  for (const item of value) {
    if (!isObj(item) || typeof item.serverId !== "string") return [];
    if (!Array.isArray(item.tools) || !item.tools.every((t) => typeof t === "string")) return [];
    out.push({ serverId: item.serverId, tools: [...(item.tools as string[])] });
  }
  return out;
}

/** fetchGrantedTools 的产物过一道白名单。[] = 整池放行；过滤后一个工具都不剩的
    服务不进结果（engine 挂一台空服务没意义，还会在工具表里占一行） */
export function filterGrantedByAllow<T extends { serverId: string; toolDefs: readonly { name: string }[] }>(
  granted: readonly T[],
  allow: readonly AgentToolAllow[]
): T[] {
  if (allow.length === 0) return [...granted];
  const out: T[] = [];
  for (const g of granted) {
    const entry = allow.find((a) => a.serverId === g.serverId);
    if (!entry) continue;
    if (entry.tools.length === 0) {
      out.push(g);
      continue;
    }
    const toolDefs = g.toolDefs.filter((t) => entry.tools.includes(t.name));
    if (toolDefs.length > 0) out.push({ ...g, toolDefs });
  }
  return out;
}

/** 两份白名单是不是同一份（编辑弹窗「只发变了的字段」用）。顺序无关——包括
    同一 serverId 条目内 tools 的顺序，键里把 tools 也排过序再拼 */
export function sameAgentTools(a: readonly AgentToolAllow[], b: readonly AgentToolAllow[]): boolean {
  if (a.length !== b.length) return false;
  const key = (x: AgentToolAllow): string => `${x.serverId}:${[...x.tools].sort().join(",")}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}
