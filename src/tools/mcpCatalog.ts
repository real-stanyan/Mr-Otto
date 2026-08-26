// mcp_catalog —— agent 查"这台 server 该怎么配"。
// 只读一份仓内常量：不碰 world、没有副作用、免审批。

import type { Tool } from "./tool.js";
import { searchCatalog, type CatalogEntry } from "../shared/mcpCatalog.js";

function render(e: CatalogEntry): string {
  const lines = [
    `## ${e.name}（建议 id: ${e.id}）`,
    e.description,
    `传输方式：${e.transport}`,
  ];
  if (e.url !== undefined) lines.push(`URL 模板：${e.url}`);
  if (e.command !== undefined) lines.push(`命令：${e.command} ${(e.args ?? []).join(" ")}`);
  lines.push(
    e.params.length === 0
      ? "需要用户提供的参数：无"
      : `需要用户提供的参数：\n${e.params
          .map((p) => `  - ${p.name}${p.required ? "（必填）" : "（可选）"}：${p.description}`)
          .join("\n")}`
  );
  lines.push(`认证：${e.auth} —— ${e.authNote}`);
  return lines.join("\n");
}

export const mcpCatalogTool: Tool = {
  def: {
    name: "mcp_catalog",
    description:
      "查常见 MCP server 的配置方法（URL / 命令 / 需要用户提供的参数 / 认证方式）。" +
      "用户说要接某个服务时先查这里；查不到再用 web_search。" +
      "留空 query 可以列出全部已知的 server。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "服务名，例如 supabase / github；留空列出全部" },
      },
      required: [],
    },
  },
  exposure: "deferred",
  requiresApproval: false,
  // 纯读常量，无共享状态
  parallelSafe: true,
  async run(args) {
    const q = (args as { query?: unknown } | null)?.query;
    const hits = searchCatalog(typeof q === "string" ? q : "");
    if (hits.length === 0) {
      return (
        `目录里没有「${String(q)}」。用 web_search 查一下它的 MCP server 地址` +
        `（关键词：<服务名> MCP server url），拿到之后再调 mcp_configure。`
      );
    }
    return hits.map(render).join("\n\n");
  },
};
