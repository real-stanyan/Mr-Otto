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

/** 钩子单次调用的超时上限（issue #383）。教训来自 hermes 的 pi/OpenCode 对比
    RFC："Neither system has hook timeouts. Both have shipped hang-class
    failures because of it."——一只挂死的钩子不该挂死整个 turn。
    超时按**弃权**处理（fail-open）：钩子是观察/干预者，不是安全边界——
    安全边界是守卫（ToolGuard，fail-closed 的那层）和审批门 */
export const HOOK_TIMEOUT_MS = 10_000;

/** 把钩子的裁决 Promise 圈进超时：超时返回 undefined（= 弃权，与钩子自己
    返回空同义）。不 reject——超时不是错误，是"这只钩子这次没赶上表态" */
export async function hookWithTimeout<T>(
  p: T | Promise<T>,
  ms: number = HOOK_TIMEOUT_MS
): Promise<T | undefined> {
  if (!(p instanceof Promise)) return p; // 同步裁决没有挂死一说，不掏计时器
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── 单调守卫（issue #383，dsh monotonic guard 对照）─────────
// 钩子（waterfall，可 block/改参）之后、执行器留痕之前的最后一道闸：
// 守卫**只能 deny 或弃权，不能 allow**——返回 reason 即拒绝，返回 undefined
// 即弃权。没有 allow 这个返回值，注册顺序就永远翻不了案（后注册的守卫
// 无法把前面的拒绝改回放行）。
// 它堵的真实的洞：审批门在管线最外层，Pre 钩子的 revise_args 跑在它**之后**
// ——批的是原参数、执行的是改后参数。守卫看到的是**最终生效的参数**
// （过完审批改参、过完钩子改参），execpolicy 的 forbidden 规则在这复查。

export interface ToolGuard {
  /** 守卫名：落进 tool_hook 事件（action:"guard_deny"，谁拒的） */
  name: string;
  /** 匹配哪些工具（语义同 ToolHook.tools） */
  tools: "*" | string[];
  /** 返回拒绝理由 = deny；返回 undefined = 弃权。刻意没有 allow。
      守卫是进程内受信代码（fail-closed 的安全层），不设超时——
      挂死是代码 bug，不是可容忍的运行时状态 */
  check(ctx: ToolCallContext): string | undefined | Promise<string | undefined>;
}

/** 这只守卫管不管这把工具（与 hookMatches 同一套 alias 规则） */
export function guardMatches(guard: ToolGuard, toolName: string): boolean {
  if (guard.tools === "*") return true;
  return guard.tools.some((t) => t === toolName || HOOK_TOOL_ALIASES[t] === toolName);
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
