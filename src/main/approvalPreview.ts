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
