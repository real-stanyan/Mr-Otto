// MCP 工具 —— 把一台 server 自报的每个 tool 包成本仓的 Tool 形状。
// 只依赖 ExecutionWorld / McpCapability（AGENTS.md 硬规则）：
// 这里不知道背后是 stdio 子进程还是远程 HTTP，也不知道 SDK 长什么样。

import type { Tool } from "./tool.js";
import type { McpCapability } from "../world/executionWorld.js";
import { mcpToolName, renderMcpContent } from "../shared/mcp.js";

/** 装配时把每台**已连上**的 server 的工具全挂上。
    没连上的不出刀 —— 它的工具清单是空的，没有 def 就无从挂起（spec §四第 3 点）。
    挂上之后能不能用由 available() 管：engine 按 available() 过滤声明表喂模型，
    掉线时工具从模型看到的清单消失。工具仍在 toolsByName 里，掉线前发出的调用
    能收到一句人话而不是"未知工具"。 */
export function createMcpTools(mcp: McpCapability): Tool[] {
  return mcp.servers().flatMap((server) =>
    server.tools.map<Tool>((t) => ({
      def: {
        name: mcpToolName(server.name, t.name),
        description: t.description,
        parameters: t.inputSchema as object,
      },
      // 全部要审批：server 是外部代码，MCP 协议里的 readOnlyHint 是它自报的，
      // 不采信（同"不采信页面自报 URL"的判断）。授权记忆按完整工具名记，
      // 所以"永久允许读 issue"不会顺带允许"建 PR"（ADR-0041）
      requiresApproval: true,
      available: () => mcp.servers().some((s) => s.id === server.id && s.live),
      async run(args, world, ctx) {
        if (!world.mcp) throw new Error("这个装配没有 MCP 能力，工具用不了");
        if (!world.mcp.servers().some((s) => s.id === server.id && s.live)) {
          throw new Error(`MCP server「${server.name}」当前没连上，这次调用没发出去`);
        }
        const content = await world.mcp.callTool(server.id, t.name, args, ctx?.signal);
        return renderMcpContent(content);
      },
    }))
  );
}
