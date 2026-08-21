// mcp_read_resource —— 读 MCP server 暴露的资源。
//
// 为什么是"模型主动读"而不是"连上就注入上下文"：自动注入会造出一份模型看得见、
// 却不在事件日志里的内容,直接撞硬规则「先落盘再喂模型」。要合规就得为"注入了哪些
// resource"造新 SessionEvent,还得保证重放时拿回**当时那一版**内容(server 上的文件
// 早变了)——代价远大于收益。走工具调用则天然合规：读取就是一次
// ToolExecutionStarted + ToolResult,内容原样落盘,重放拿到的是当时读到的那一份。

import type { Tool } from "./tool.js";
import type { McpCapability } from "../world/executionWorld.js";
import { renderMcpContent } from "../shared/mcp.js";

/** 清单进 description 的条数上限。再多模型也读不完,而 description 是每轮都要
    进上下文的常驻成本 —— 截断了就明说,不假装列全了(同 browser_read 的 truncated) */
const LIST_MAX = 40;

function describeResources(mcp: McpCapability): string {
  const rows: string[] = [];
  let total = 0;
  for (const s of mcp.servers()) {
    if (!s.live) continue;
    for (const r of s.resources) {
      total++;
      if (rows.length < LIST_MAX) {
        rows.push(`- server=${s.name} uri=${r.uri} — ${r.name}${r.description ? `：${r.description}` : ""}`);
      }
    }
  }
  const head = "读一份 MCP server 暴露的资源。当前可读的有：";
  const tail = total > rows.length ? `\n（还有 ${total - rows.length} 份没列出来）` : "";
  return rows.length === 0 ? "读一份 MCP server 暴露的资源。当前没有任何可读资源。" : `${head}\n${rows.join("\n")}${tail}`;
}

export function createMcpReadResourceTool(mcp: McpCapability): Tool {
  const hasAny = () => mcp.servers().some((s) => s.live && s.resources.length > 0);
  return {
    def: {
      name: "mcp_read_resource",
      // 活的：每轮拼声明表时现算,server 增删/掉线都能反映出来
      get description() {
        return describeResources(mcp);
      },
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "server 名（见工具描述里的 server=）" },
          uri: { type: "string", description: "资源 uri（见工具描述里的 uri=）" },
        },
        required: ["server", "uri"],
      },
    },
    // 纯读不落地,照 browser_read / web_extract
    requiresApproval: false,
    // 一份资源都没有时不给模型这把刀 —— 空刀只会诱导它乱调
    available: hasAny,
    async run(args, world, ctx) {
      if (!world.mcp) throw new Error("这个装配没有 MCP 能力，工具用不了");
      const a = (args ?? {}) as { server?: unknown; uri?: unknown };
      const server = typeof a.server === "string" ? a.server : "";
      const uri = typeof a.uri === "string" ? a.uri : "";
      if (!uri) throw new Error("缺少参数 uri —— 要读哪一份资源");

      const hit = world.mcp.servers().find((s) => s.live && s.name === server);
      if (!hit) {
        const live = world.mcp.servers().filter((s) => s.live).map((s) => s.name);
        throw new Error(
          `没有连上名叫「${server}」的 MCP server。当前连着的是：${live.join("、") || "（一台都没有）"}`
        );
      }
      return renderMcpContent(await world.mcp.readResource(hit.id, uri, ctx?.signal));
    },
  };
}
