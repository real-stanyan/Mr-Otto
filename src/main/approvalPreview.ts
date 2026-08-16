// 审批预览 — 审批卡弹出前，主进程替人把"将要发生什么"看清楚。
// 目前只有 write_file 有预览（旧内容 vs 新内容）；bash/read_file 没有
// 可对照的"世界现状"，退回原样 JSON 参数展示。
// 读旧文件走 world.fs（围栏天然生效）——预览不开任何工具之外的口子。

import type { ToolCallRequest } from "../session/events.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import type { WriteFilePreview } from "../shared/shellBridge.js";

/** 单边文本超过此长度就放弃预览（IPC 别扛巨物，diff 也算不动），退回 JSON 展示 */
const MAX_PREVIEW_CHARS = 200_000;

export async function buildApprovalPreview(
  call: ToolCallRequest,
  world: ExecutionWorld
): Promise<WriteFilePreview | undefined> {
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

  return { path: args.path, oldText, newText: args.content };
}
