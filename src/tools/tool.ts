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
  /** 挂载(mounted) 和可用(available) 是两件事，别混：挂载答"这次装配拥不拥有
      这把刀"（由 agent.ts 组装时的固定条件决定，一次定终身）；available 答
      "此刻用它能不能干出点什么"（可以每次现算，随外部状态变化）。缺席 = 恒可用，
      老工具一个字不用改。task 是目前唯一用到它的例子：subagentRunner 在场就
      挂上（拥有派活的能力），但清单是空的时候派不出任何人（用不出东西） */
  available?: () => boolean;
  /** 返回值 = 喂回模型的 tool_result.output；抛错 = status: "error"。
      也可返回 { output, concludesTurn } —— concludesTurn:true 时 engine 在当步收口整个 turn */
  run(
    args: unknown,
    world: ExecutionWorld,
    ctx?: ToolRunContext
  ): Promise<string | { output: string; concludesTurn?: true }>;
}
