// mcp_authorize —— 对一台 needs-auth 的 server 拉起 OAuth 授权。
//
// 不设审批门（spec §7）：它必然弹出系统浏览器、用户必须亲手在服务商的
// 页面上点同意——人天然在环里，再加一道审批门是重复劳动而非安全增益。
// 而且这把刀改不了任何配置：它只能对**已经配好的**那台跑授权流程，
// 能造成的最坏结果是浏览器白开一次。

import type { Tool } from "./tool.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import { mcpOutcomeReport } from "../shared/mcp.js";

// 无参（#474）：同 createMcpConfigureTool——run 用调用时的 world.mcp，
// 工厂参数是死的
export function createMcpAuthorizeTool(): Tool {
  return {
    def: {
      name: "mcp_authorize",
      description:
        "对一台需要授权（needs-auth）的 MCP server 拉起 OAuth 授权：会打开系统浏览器，" +
        "用户在服务商页面登录并点同意后自动重连。授权期间这次调用会一直等（最多 5 分钟）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "server 在配置里的名字" } },
        required: ["id"],
      },
    },
    exposure: "deferred",
    requiresApproval: false,
    async run(args, world: ExecutionWorld) {
      if (!world.mcp) throw new Error("这个装配没有 MCP 能力，授权不了");
      const id = (args as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id === "") throw new Error("id 必填，且必须是字符串");
      // 失败原样抛：超时 / 用户拒绝 / 服务端报错是三件不同的事，模型要拿到
      // 具体原因才能告诉用户下一步该做什么
      await world.mcp.authorize(id);
      const hit = world.mcp.servers().find((s) => s.id === id);
      return mcpOutcomeReport(hit, {
        connected: `「${id}」授权完成并已连上`,
        notConnected: `「${id}」的授权流程跑完了，但还没连上`,
      });
    },
  };
}
