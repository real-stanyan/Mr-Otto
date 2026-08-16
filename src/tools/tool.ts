// Tool — 工具的统一形状。run 只拿到 args 和 world，别的世界一概不知。

import type { ToolDefinition } from "../model/adapter.js";
import type { ExecutionWorld } from "../world/executionWorld.js";

export interface Tool {
  def: ToolDefinition;
  /** true = 执行前必须过人工审批门（下一课接入管线） */
  requiresApproval: boolean;
  /** 返回值 = 喂回模型的 tool_result.output；抛错 = status: "error" */
  run(args: unknown, world: ExecutionWorld): Promise<string>;
}
