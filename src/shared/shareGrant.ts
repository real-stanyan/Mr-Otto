// shareGrant —— 「分享会话时连带把它用到的服务借给对方」的纯逻辑（issue #694，ADR-0177）。
//
// 在这之前，「把会话给你看」和「把服务借给你用」是两条互不相通的路：
// 分享包过隐私闸、**不带任何凭证**（sessionPackage.ts），于是 B 导入后调 `shopify`
// 必然失败；要真能帮忙，A 还得另开好友代理弹窗圈一次白名单、生成邀请码、
// 让 B 手动粘贴。两趟，且第二趟全靠 DM 里口头指挥。
//
// 这一层回答那两趟里的第一个问题：**这个会话到底用到了哪几台服务**。
// 有了它，分享的确认框才能只列该列的那几台，而不是把 A 接通的一切都摆上去
// —— 默认授权的范围就是爆炸半径，issue #694 的第四条冲突说的就是这个。
//
// 判据只有一条：会话里模型请求过的工具名，能对回哪台**此刻还连着**的 server。
//
// 两条刻意的不精确，都写在这儿而不是让调用方猜：
//   1. 事件日志里只有**模型可见名**（`mcp__<server>__<tool>`，撞名时还带哈希后缀），
//      没有 serverId。反查靠 `assignMcpToolNames` 重算一遍——和 approvalPreview
//      反查同一招。而名字分配依赖**整桌的顺序**，昨天那次调用发生时的桌面
//      可能与此刻不同：于是这是「尽力而为」，不是「精确重建」。这没问题——
//      产物是给 A 看的一张勾选表，A 自己会拍板，不是自动授权。
//   2. 没连上的 server 一律不算。给了对方也调不动，摆上去只会误导
//      （与 ProxyDialog 的 `live` 同一口径）。
//
// 纯逻辑零 IO：不碰传输、不碰存储、不认识 window。

import { assignMcpToolNames } from "./mcp.js";
import type { SessionEvent } from "../session/events.js";

/** 反查要的那点 server 信息（`McpServerStatus` / `McpServerHandle` 都喂得进来）。
    id 同时当分配工具名用的 server 名——mcpHub 的 `handleOf` 就是 `name: id` */
export interface ShareGrantServer {
  id: string;
  /** 连上了没。没连上的不进结果（理由见文件头第 2 条） */
  live: boolean;
  tools: readonly { name: string }[];
}

/**
 * 这个会话用到了哪几台（此刻还连着的）MCP 服务。
 *
 * 返回顺序跟随 `servers` 而不是调用先后：这份清单要渲染成一张勾选表，
 * 表的行序该是稳定的，不该因为 A 昨天先调了谁而跳来跳去。
 */
export function serversUsedInSession(
  events: readonly SessionEvent[],
  servers: readonly ShareGrantServer[]
): string[] {
  // 名字分配必须跑在**全体**上（含没连上的），再滤 live —— 与 createMcpTools /
  // knownMcpToolNames 同一份分配才对得上号：撞名时的哈希后缀取决于整桌顺序，
  // 只拿 live 的重算会算出另一套名字（issue #349 踩过的那个坑）
  const all = servers.flatMap((s) => s.tools.map((t) => ({ server: s.id, tool: t.name, live: s.live })));
  const names = assignMcpToolNames(all.map(({ server, tool }) => ({ server, tool })));
  const serverOf = new Map<string, string>();
  all.forEach((e, i) => {
    const name = names[i];
    // null = assignMcpToolNames 判定的重复项（同 server 名 + 同 tool 名）
    if (name && e.live) serverOf.set(name, e.server);
  });

  const used = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "assistant_message" || !ev.toolCalls) continue;
    for (const tc of ev.toolCalls) {
      const server = serverOf.get(tc.name);
      if (server !== undefined) used.add(server);
    }
  }
  // 按 servers 的顺序输出（稳定行序），而不是 Set 的插入序
  return servers.filter((s) => used.has(s.id)).map((s) => s.id);
}

/** 勾选结果 → 线上白名单。整服务放行（`tools: []` 就是那个意思，见 proxyShare.ts）。
    分享这条路只到「服务」这一层：想再往下圈到单个工具，走好友代理弹窗那张表 */
export function shareAllow(serverIds: readonly string[]): { serverId: string; tools: readonly string[] }[] {
  return serverIds.map((serverId) => ({ serverId, tools: [] }));
}
