// 审批预览 — 审批卡弹出前，主进程替人把"将要发生什么"看清楚。
// 两种工具有专门的排版：
//   write_file → 旧内容 vs 新内容（渲染层现算 diff）
//   MCP 工具   → 哪台 server 的哪把刀 + 参数表（issue #157）
// 其余（bash/read_file…）没有可对照的"世界现状"，退回原样 JSON 参数展示。
// 读旧文件走 world.fs（围栏天然生效）——预览不开任何工具之外的口子。

import type { ToolCallRequest } from "../session/events.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import type { ApprovalPreview, McpPreviewArg } from "../shared/shellBridge.js";
import { assignMcpToolNames } from "../shared/mcp.js";

/** 单边文本超过此长度就放弃预览（IPC 别扛巨物，diff 也算不动），退回 JSON 展示 */
const MAX_PREVIEW_CHARS = 200_000;

/** 单个 MCP 参数值在主进程就截断的长度。审批卡是"扫一眼看清要发生什么"，
    不是全文阅读器；一个塞了整份文件的参数不该把 IPC 和卡片一起撑爆 */
const MAX_ARG_CHARS = 2_000;

export async function buildApprovalPreview(
  call: ToolCallRequest,
  world: ExecutionWorld
): Promise<ApprovalPreview | undefined> {
  if (call.name === "mcp_configure") return mcpConfigurePreview(call, world);
  if (call.name.startsWith("mcp__")) return mcpPreview(call, world);
  if (call.name !== "write_file") return undefined;
  // 参数出自模型，不赌形状：不像 {path, content} 就不预览（审批卡照常弹，走 JSON 兜底）
  const args = call.args as { path?: unknown; content?: unknown };
  if (typeof args.path !== "string" || typeof args.content !== "string") return undefined;
  if (args.content.length > MAX_PREVIEW_CHARS) return undefined;

  // 读不到 = 新文件（不存在/没权限统统按"无旧内容"处理——预览失败不该挡住审批）
  const oldText = await world.fs.read(args.path).then(
    (t) => t,
    () => null
  );
  if (oldText !== null && oldText.length > MAX_PREVIEW_CHARS) return undefined;

  return { kind: "write_file", path: args.path, oldText, newText: args.content };
}

/** 预览这一步的最佳展示：能规范化就规范化，展示的是 URL 解析器实际会看到
    的主机，不是可能藏着隐藏 tab/换行的原始输入（Task 9 审查 Critical 1——
    "https://good.com" + 30 个换行 + "@evil.com/mcp" 解析出的 host 是
    evil.com，卡片必须露出这个真相，不能停留在被换行推没了的原始字符串）。
    解析失败（语法错误/协议不对）时 run() 那层会真正拒绝这次调用——这里仍
    展示原始值，让卡片至少说得出模型传了什么，而不是直接哑掉退回 JSON 兜底。 */
function previewUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/** 单个字符串值按 MAX_ARG_CHARS 截断，和 clip() 同一份纪律（Task 9 审查
    Important 2：这个预览此前没有 mcp_tool 参数预览、write_file 都有的
    长度上限，一个几 MB 的 command/url/arg 会整个原样过 IPC 落到卡片上）。 */
function clipValue(value: string): { value: string; truncated: boolean; fullLength: number } {
  return value.length <= MAX_ARG_CHARS
    ? { value, truncated: false, fullLength: value.length }
    : { value: value.slice(0, MAX_ARG_CHARS), truncated: true, fullLength: value.length };
}

/** mcp_configure 的预览。参数出自模型，形状一律不赌——认不出来就不预览，
    审批卡照常弹、走 JSON 兜底（同 write_file 分支的口径）。 */
function mcpConfigurePreview(call: ToolCallRequest, world: ExecutionWorld): ApprovalPreview | undefined {
  const mcp = world.mcp;
  if (!mcp) return undefined;
  const a = call.args as Record<string, unknown> | null;
  const id = a?.["id"];
  if (typeof id !== "string" || id === "") return undefined;

  const existing = mcp.configOf(id);
  const before = existing
    ? {
        url: existing.kind === "http" ? existing.url : null,
        command: existing.kind === "stdio" ? existing.command : null,
        toolCount: mcp.servers().find((s) => s.id === id)?.tools.length ?? 0,
      }
    : null;

  if (a?.["action"] === "remove") {
    return {
      kind: "mcp_configure", server: id, action: "remove", transport: null,
      url: null, command: null, args: [], credentialKeys: [], before,
      truncated: { url: false, command: false, args: [] },
      fullLength: { url: 0, command: 0, args: [] },
    };
  }

  const kind = a?.["kind"];
  if (kind !== "http" && kind !== "stdio") return undefined;
  const creds = kind === "http" ? a?.["headers"] : a?.["env"];

  // url 走 previewUrl 归一化再截断——卡片和最终写盘的 URL.href 因此永远是
  // 同一份（normalizeMcpHttpUrl 在 mcpConfigure.ts 里存的也是 href）
  const urlClip =
    kind === "http" && typeof a?.["url"] === "string" ? clipValue(previewUrl(a["url"] as string)) : null;
  const commandClip =
    kind === "stdio" && typeof a?.["command"] === "string" ? clipValue(a["command"] as string) : null;
  const argsClip = Array.isArray(a?.["args"]) ? (a["args"] as unknown[]).map((x) => clipValue(String(x))) : [];

  return {
    kind: "mcp_configure",
    server: id,
    action: before ? "update" : "add",
    transport: kind,
    url: urlClip?.value ?? null,
    command: commandClip?.value ?? null,
    // 一格一项，不 join——每一条 arg 是它自己的一行（Task 9 审查 Important 1）
    args: argsClip.map((c) => c.value),
    // 只出键名。真值绝不过桥（ADR-0044）——审批卡要回答的是"配了哪几把"，
    // 不是"每把长什么样"
    credentialKeys: Object.keys(
      creds !== null && typeof creds === "object" && !Array.isArray(creds) ? creds : {}
    ),
    before,
    truncated: {
      url: urlClip?.truncated ?? false,
      command: commandClip?.truncated ?? false,
      args: argsClip.map((c) => c.truncated),
    },
    fullLength: {
      url: urlClip?.fullLength ?? 0,
      command: commandClip?.fullLength ?? 0,
      args: argsClip.map((c) => c.fullLength),
    },
  };
}

/** 把 `mcp__<server>__<tool>` 还原成"哪台 server 的哪把刀"。
    不从工具名反推——mcpToolName 的收口有损（净化 + 截断 + 指纹，见 shared/mcp.ts），
    反推不回去。正着来：拿此刻的清单逐个算一遍名字，撞上的那个就是它。
    清单里没有（server 刚掉线、工具被撤了）= 不预览，审批卡照常弹、走 JSON 兜底 */
function mcpPreview(call: ToolCallRequest, world: ExecutionWorld): ApprovalPreview | undefined {
  const mcp = world.mcp;
  if (!mcp) return undefined;
  // 与 createMcpTools 同一份分配（issue #349）：名字唯一性依赖整桌统一算
  // （撞名的哈希后缀取决于先来后到），逐个独立算会对不上号
  const entries = mcp.servers().flatMap((server) => server.tools.map((tool) => ({ server, tool })));
  const names = assignMcpToolNames(entries.map((e) => ({ server: e.server.name, tool: e.tool.name })));
  for (const [i, { server, tool }] of entries.entries()) {
    if (names[i] !== call.name) continue;
    return {
      kind: "mcp_tool",
      server: server.name,
      tool: tool.name,
      description: tool.description ?? "",
      args: previewArgs(call.args),
    };
  }
  return undefined;
}

/** 参数摊平成一格一项。值出自模型，形状不赌：字符串原样，其余 JSON 序列化。
    参数根本不是对象（模型给了个数组或一个裸值）时也不硬拆，整体记成一项 */
function previewArgs(args: unknown): McpPreviewArg[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [clip("参数", stringify(args))];
  }
  return Object.entries(args as Record<string, unknown>).map(([k, v]) => clip(k, stringify(v)));
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    // 循环引用之类：说得出"这里有个值，但它印不出来"比整张卡不预览强
    return String(v);
  }
}

function clip(name: string, value: string): McpPreviewArg {
  return value.length <= MAX_ARG_CHARS
    ? { name, value, truncated: false, fullLength: value.length }
    : { name, value: value.slice(0, MAX_ARG_CHARS), truncated: true, fullLength: value.length };
}
