// mcp_configure —— agent 增 / 改 / 删一台 MCP server。
//
// 必须过审批门，这不是可选项（spec §3.1）：stdio 类型的 server 配置就是
// command + args + env，agent 能自由写盘，等于绕开 bash 工具的审批门拿到
// 任意命令执行，还附带任意环境变量。审批卡片（approvalPreview.ts 里的
// mcp_configure 分支）把这些逐字段列出来，是这条路上唯一的安全闸。
//
// 只依赖 ExecutionWorld / McpCapability（硬规则）：这里不知道配置写在哪个
// 文件、也不知道 hub 和 SDK 的存在。

import type { Tool } from "./tool.js";
import type { McpCapability, ExecutionWorld } from "../world/executionWorld.js";
import type { McpServerConfig } from "../shared/mcp.js";
import { mcpNewToolsNotice, normalizeMcpHttpUrl } from "../shared/mcp.js";

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStringMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(v)).map(([k, x]) => [k, String(x)]));

/** 参数出自模型，一个字段都不赌形状。校验失败抛人话——模型收到的是
    tool_result 里的错误文本，它能照着改；写进配置的垃圾则要用户去手删 */
export function parseConfigureArgs(raw: unknown): { id: string; cfg: McpServerConfig | null } {
  const a = asRecord(raw);
  const id = a["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("id 必填，且必须是字符串（这是这台 server 在配置里的名字）");
  }
  if (a["action"] === "remove") return { id, cfg: null };

  const kind = a["kind"];
  if (kind === "http") {
    const url = a["url"];
    if (typeof url !== "string" || url === "") throw new Error("http 传输必须给 url");
    // 归一化 + 校验挪进 shared/mcp.ts 的 normalizeMcpHttpUrl（Task 9 审查 Critical 1）：
    // 存盘的必须是 URL.href，不是模型给的原始字符串——WHATWG 解析器会在解析前
    // 悄悄剥掉 tab/换行，原始字符串和解析结果能对应到两个不同的主机。
    // mcpConfigurePreview 复用同一个函数，卡片和落盘的值因此永远是同一份。
    const normalizedUrl = normalizeMcpHttpUrl(url);
    return {
      id,
      cfg: {
        kind: "http",
        url: normalizedUrl,
        headers: asStringMap(a["headers"]),
        enabled: a["enabled"] !== false,
      },
    };
  }
  if (kind === "stdio") {
    const command = a["command"];
    if (typeof command !== "string" || command === "") throw new Error("stdio 传输必须给 command");
    return {
      id,
      cfg: {
        kind: "stdio",
        command,
        args: Array.isArray(a["args"]) ? a["args"].map(String) : [],
        env: asStringMap(a["env"]),
        enabled: a["enabled"] !== false,
      },
    };
  }
  throw new Error('kind 必须是 "http" 或 "stdio"（删除请传 action: "remove"）');
}

export function createMcpConfigureTool(mcp: McpCapability): Tool {
  return {
    def: {
      name: "mcp_configure",
      description:
        "增 / 改 / 删一台 MCP server 的配置。会弹审批卡请用户确认，用户同意后才落盘并尝试连接。" +
        "先用 mcp_catalog 查该填什么。http 传输的 server 配好之后通常还需要调 mcp_authorize 授权一次。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "这台 server 在配置里的名字，例如 supabase" },
          action: { type: "string", enum: ["upsert", "remove"], description: "默认 upsert；remove 表示删除这台" },
          kind: { type: "string", enum: ["http", "stdio"], description: "传输方式" },
          url: { type: "string", description: "http 传输的地址" },
          headers: { type: "object", description: "http 传输的自定义请求头（OAuth 授权不需要填这个）" },
          command: { type: "string", description: "stdio 传输要跑的命令" },
          args: { type: "array", items: { type: "string" }, description: "stdio 传输的命令参数" },
          env: { type: "object", description: "stdio 传输的环境变量" },
          enabled: { type: "boolean", description: "是否启用，默认 true" },
        },
        required: ["id"],
      },
    },
    exposure: "deferred",
    requiresApproval: true,
    async run(args, world: ExecutionWorld) {
      if (!world.mcp) throw new Error("这个装配没有 MCP 能力，配不了 MCP server");
      const { id, cfg } = parseConfigureArgs(args);
      await world.mcp.configure(id, cfg);
      if (cfg === null) return `已删除 MCP server「${id}」。`;
      const hit = world.mcp.servers().find((s) => s.id === id);
      if (hit?.live) {
        return `MCP server「${id}」已配置并连上，${mcpNewToolsNotice(hit.tools.map((t) => t.name))}`;
      }
      if (hit?.status === "needs-auth") {
        return `MCP server「${id}」已配置，但需要授权。调用 mcp_authorize 拉起授权（会打开浏览器让用户点同意）。`;
      }
      return `MCP server「${id}」已配置，但暂时没连上：${hit?.error ?? "原因未知"}`;
    },
  };
}
