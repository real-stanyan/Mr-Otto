// Tool — 工具的统一形状。run 只拿到 args 和 world，别的世界一概不知。

import type { ToolDefinition } from "../model/adapter.js";
import type { ExecutionWorld } from "../world/executionWorld.js";

/** 执行器透给 run 的一点点上下文。绝大多数工具用不着——
    只有需要"回头找自己这次调用"的工具（ask_user 要拿 toolCallId 当唤醒钥匙、
    要拿 signal 在 turn 中断时收场）才读它。可选参数 = 老工具一个字不用改 */
export interface ToolRunContext {
  toolCallId: string;
  /** turn 中断信号（ADR-0006）。不给 = 不可中断（测试里的裸管线照旧） */
  signal?: AbortSignal;
}

export interface Tool {
  def: ToolDefinition;
  /** true = 执行前必须过人工审批门（下一课接入管线） */
  requiresApproval: boolean;
  /** 挂载是一次性的（装配时决定），可用性每轮重问。
      返回 false = 模型的声明表里消失，但工具还在 toolsByName 里，
      这样掉线前发出的调用能收到人话而不是"未知工具"。可选参数 = 兼容旧工具 */
  available?: () => boolean;
  /** 返回值 = 喂回模型的 tool_result.output；抛错 = status: "error"。
      也可返回 { output, concludesTurn } —— concludesTurn:true 时 engine 在当步收口整个 turn */
  run(
    args: unknown,
    world: ExecutionWorld,
    ctx?: ToolRunContext
  ): Promise<string | { output: string; concludesTurn?: true }>;
}
