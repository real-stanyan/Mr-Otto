// 工具中间件管线 — DSH 原则 #2：pre-execute → execute → post-execute
// 洋葱模型：middlewares[0] 包 middlewares[1] 包 … 包 executor。
// 中间件不调 next() = 短路，后面全不跑（审批拒绝就是这么实现的）。

import type { Tool } from "../tools/tool.js";
import type { ToolCallRequest } from "../session/events.js";
import type { ExecutionWorld } from "../world/executionWorld.js";

/** 一次工具调用的完整上下文 —— 管线每一环都看得到 */
export interface ToolCallContext {
  call: ToolCallRequest;
  /** 未知工具时为 undefined，由执行器兜底成 error 结果 */
  tool: Tool | undefined;
  world: ExecutionWorld;
  sessionId: string;
}

/** 管线产物 = tool_result 事件的内容部分（status 三态与事件定义对齐） */
export interface ToolOutcome {
  status: "ok" | "error" | "denied";
  output: string;
}

/**
 * 中间件：看 ctx，决定放行（调 next）还是短路（直接返回 outcome）。
 * next 之前的代码 = pre-execute，next 之后的代码 = post-execute。
 */
export type ToolMiddleware = (
  ctx: ToolCallContext,
  next: () => Promise<ToolOutcome>
) => Promise<ToolOutcome>;

/** 把中间件数组卷成洋葱并执行；executor 是最内层的"真正干活的" */
export function runPipeline(
  middlewares: ToolMiddleware[],
  executor: (ctx: ToolCallContext) => Promise<ToolOutcome>,
  ctx: ToolCallContext
): Promise<ToolOutcome> {
  let lastCalled = -1;
  const dispatch = (idx: number): Promise<ToolOutcome> => {
    if (idx <= lastCalled) {
      return Promise.reject(new Error("同一个中间件把 next() 调了两次"));
    }
    lastCalled = idx;
    const mw = middlewares[idx];
    if (!mw) return executor(ctx); // 穿过所有层 = 到达洋葱芯
    return mw(ctx, () => dispatch(idx + 1));
  };
  return dispatch(0);
}
