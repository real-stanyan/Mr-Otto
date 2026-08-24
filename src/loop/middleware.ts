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
  /** turn 中断信号（ADR-0006）：审批门用它唤醒挂起的审批，world 用它杀进程。
      可选 = 不给就是不可中断（测试里的裸管线照旧） */
  signal?: AbortSignal;
}

/** 管线产物 = tool_result 事件的内容部分（status 三态与事件定义对齐） */
export interface ToolOutcome {
  status: "ok" | "error" | "denied";
  output: string;
  /** DSH 式数据驱动收口：true = 本步结束整个 turn，不给模型补答的机会 */
  concludesTurn?: true;
}

// ─── Pre/PostToolUse 钩子（issue #350，codex dispatch 对照）────
// 中间件是"包住执行"的洋葱层；钩子是更窄的一等语义：Pre 可拦截/改参，
// Post 可拒绝/注入反馈。窄接口的价值：三种返回语义都由 engine 统一落盘
// （tool_hook 事件），钩子作者不碰日志，也碰不坏日志。

/** Pre 钩子的裁决。空返回/undefined = 放行不干预 */
export interface PreHookResult {
  /** 拦截：工具不执行，这条消息作为 error 回模型 */
  block?: string;
  /** 改写入参：执行用这一份（同审批 revisedArgs 的先例，engine 换新对象不原地改） */
  reviseArgs?: unknown;
}

/** Post 钩子的裁决。空返回/undefined = 结果原样放行 */
export interface PostHookResult {
  /** 拒绝结果：模型收到的 tool_result 变成这条 error；原始输出进 tool_hook 事件（审计） */
  reject?: string;
  /** 注入反馈：日志仍存原始输出，投影把这条包装进模型看到的 tool 消息尾部 */
  feedback?: string;
}

/** 钩子按工具名匹配时的 alias 表（issue #350 可选项）：兼容 Claude Code 风格
    的钩子配置——那边叫 Bash/Write/Read，本仓叫 bash/write_file/read_file。
    将来开放用户钩子时低成本兼容生态；内部钩子直接写本仓名即可 */
export const HOOK_TOOL_ALIASES: Record<string, string> = {
  Bash: "bash",
  Write: "write_file",
  Edit: "write_file",
  Read: "read_file",
};

export interface ToolHook {
  /** 钩子名：落进 tool_hook 事件（谁干预的） */
  name: string;
  /** 匹配哪些工具："*" 全部；数组按名（可写 alias，见 HOOK_TOOL_ALIASES） */
  tools: "*" | string[];
  pre?(ctx: ToolCallContext): PreHookResult | void | Promise<PreHookResult | void>;
  post?(ctx: ToolCallContext, outcome: ToolOutcome): PostHookResult | void | Promise<PostHookResult | void>;
}

/** 这只钩子管不管这把工具 */
export function hookMatches(hook: ToolHook, toolName: string): boolean {
  if (hook.tools === "*") return true;
  return hook.tools.some((t) => t === toolName || HOOK_TOOL_ALIASES[t] === toolName);
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
