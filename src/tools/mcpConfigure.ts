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
import type { ExecutionWorld } from "../world/executionWorld.js";
import type { McpServerConfig } from "../shared/mcp.js";
import { mcpOutcomeReport, normalizeMcpHttpUrl } from "../shared/mcp.js";

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStringMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(v)).map(([k, x]) => [k, String(x)]));

/** 参数出自模型，一个字段都不赌形状。校验失败抛人话——模型收到的是
    tool_result 里的错误文本，它能照着改；写进配置的垃圾则要用户去手删 */
export function parseConfigureArgs(raw: unknown): { id: string; cfg: McpServerConfig | null } {
  const a = asRecord(raw);
  const rawId = a["id"];
  if (typeof rawId !== "string" || rawId.trim() === "") {
    throw new Error("id 必填，且必须是字符串（这是这台 server 在配置里的名字）");
  }
  // 判空用 trim、存的却是原值 = 两把尺子（终审 B Minor）：`" supabase "` 和
  // `"supabase"` 会成为两台不同的 server，而审批卡上这两个 id 长得一模一样
  // （首尾空白在卡片上不可见），用户看不出这是新建了一台而不是改了那台。
  // 统一存 trim 后的值，判空和落盘用同一把尺子
  const id = rawId.trim();
  // schema 的 enum 写着 upsert/remove，实现从前只判 remove——传 "delete" 的
  // 会被静默当 upsert 落盘（#474）。enum 不该只是给模型看的摆设
  const action = a["action"];
  if (action !== undefined && action !== "upsert" && action !== "remove") {
    throw new Error('action 只认 "upsert" 或 "remove"（不传默认 upsert）');
  }
  if (action === "remove") return { id, cfg: null };

  // "false" / 0 / null 从前全被 `!== false` 折成 true（#474）——模型传字符串
  // "false" 的本意明明是关，落盘却成了开（stdio 的开 = 命令会被 spawn）。
  // 歧义值抛回去让模型改，不猜
  const enabledRaw = a["enabled"];
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    throw new Error("enabled 必须是布尔值 true/false（收到了非布尔值，不猜它的意思）");
  }
  const enabled = enabledRaw !== false;

  const kind = a["kind"];
  if (kind === "http") {
    const url = a["url"];
    if (typeof url !== "string" || url === "") throw new Error("http 传输必须给 url");
    // 目录给的 URL 是带 {param} 的模板（mcpCatalog.ts）。忘了替换的占位符
    // 此前没有任何一层拦（#474）——审批卡上人眼看得见，但不该指望人兜底
    const hole = /\{(\w+)\}/.exec(url);
    if (hole !== null) {
      throw new Error(
        `url 里还有没替换的占位符 {${hole[1]}}——用 mcp_catalog 查这个参数该填什么，替换成真实值再来`
      );
    }
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
        enabled,
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
        enabled,
      },
    };
  }
  throw new Error('kind 必须是 "http" 或 "stdio"（删除请传 action: "remove"）');
}

// 无参（#474）：run 用的是调用时传进来的 world.mcp，工厂参数从第一版起就
// 是个没人读的死参数——留着会误导读者以为工具绑死了构造时那个 hub
export function createMcpConfigureTool(): Tool {
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
      return mcpOutcomeReport(hit, {
        connected: `MCP server「${id}」已配置并连上`,
        needsAuth: `MCP server「${id}」已配置，但需要授权。调用 mcp_authorize 拉起授权（会打开浏览器让用户点同意）。`,
        notConnected: `MCP server「${id}」已配置，但暂时没连上`,
      });
    },
  };
}
