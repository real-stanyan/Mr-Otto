// LoopEngine — 把环闭上：输入 → 落盘 → 投影 → 模型 → 落盘 → 工具 → 落盘 → 再投影……
// 不变量执行处：每一步先 append 再继续，模型看到的永远是日志的投影。

import type { EventStore, NewSessionEvent } from "../session/store.js";
import type { SessionEvent } from "../session/events.js";
import { deriveMessages, DEFAULT_COMPRESSION } from "../session/deriveMessages.js";
import type { ModelAdapter } from "../model/adapter.js";
import type { Tool } from "../tools/tool.js";
import type { ExecutionWorld } from "../world/executionWorld.js";
import { runPipeline } from "./middleware.js";
import type { ToolCallContext, ToolMiddleware, ToolOutcome } from "./middleware.js";
import { createApprovalGate } from "./approvalGate.js";
import type { Approver } from "./approvalGate.js";

/** 单个 turn 内模型最多连续调工具的轮数（防失控空转烧钱） */
const MAX_STEPS = 8;

export interface LoopEngineOptions {
  store: EventStore;
  adapter: ModelAdapter;
  tools: Tool[];
  world: ExecutionWorld;
  sessionId: string;
  /** 每条事件落盘后回调 —— CLI 打印、将来 UI 实时刷新都挂这 */
  onEvent?: (event: SessionEvent) => void;
  /** requiresApproval 工具的审批人；不给 = 危险操作一律默认拒绝 */
  approver?: Approver;
  /** 额外中间件，插在审批门之后、执行器之前（日志、限流、脱敏都从这进） */
  middlewares?: ToolMiddleware[];
}

export class LoopEngine {
  private readonly toolsByName: Map<string, Tool>;
  private readonly pipeline: ToolMiddleware[];
  private adapter: ModelAdapter;

  constructor(private readonly opts: LoopEngineOptions) {
    this.adapter = opts.adapter;
    this.toolsByName = new Map(opts.tools.map((t) => [t.def.name, t]));
    // 审批门永远是第一层 —— 没人能插队到它前面绕过审批
    this.pipeline = [
      createApprovalGate({
        approver: opts.approver,
        onDecision: (call, outcome) =>
          this.append({
            ...this.env(),
            type: "approval_decision",
            toolCallId: call.id,
            decision: outcome.decision,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          }),
      }),
      ...(opts.middlewares ?? []),
    ];
  }

  /** 换模型 = 换实现。engine 对"有哪些模型"一无所知，只认 ModelAdapter 接口 */
  setAdapter(adapter: ModelAdapter): void {
    this.adapter = adapter;
  }

  /** 落盘 + 通知，loop 里所有写日志走这一个口 */
  private append(event: NewSessionEvent): SessionEvent {
    const full = this.opts.store.append(event);
    this.opts.onEvent?.(full);
    return full;
  }

  private env() {
    return { sessionId: this.opts.sessionId, ts: Date.now() };
  }

  /** 洋葱芯：真正跑 tool.run 的执行器 —— 只有穿过全部中间件才到得了这 */
  private async execute(ctx: ToolCallContext): Promise<ToolOutcome> {
    if (!ctx.tool) {
      return { status: "error", output: `未知工具: ${ctx.call.name}` };
    }
    try {
      return { status: "ok", output: await ctx.tool.run(ctx.call.args, ctx.world) };
    } catch (err) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 跑一个完整 turn：直到模型不再要工具为止 */
  async runTurn(userInput: string): Promise<void> {
    const { store, world, sessionId } = this.opts;

    this.append({ ...this.env(), type: "user_message", content: userInput });

    for (let step = 0; step < MAX_STEPS; step++) {
      // 永远从日志现算上下文——loop 自己不持有任何对话状态。
      // 带压缩：老 turn 的长工具输出折叠（确定性，重放可还原模型视野）
      const messages = deriveMessages(store.load(sessionId), DEFAULT_COMPRESSION);
      const reply = await this.adapter.chat(
        messages,
        this.opts.tools.map((t) => t.def)
      );

      this.append({
        ...this.env(),
        type: "assistant_message",
        content: reply.content,
        model: this.adapter.model,
        ...(reply.toolCalls ? { toolCalls: reply.toolCalls } : {}),
      });

      if (!reply.toolCalls || reply.toolCalls.length === 0) return; // 模型说完了

      for (const call of reply.toolCalls) {
        const outcome = await runPipeline(this.pipeline, (ctx) => this.execute(ctx), {
          call,
          tool: this.toolsByName.get(call.name),
          world,
          sessionId,
        });
        this.append({
          ...this.env(),
          type: "tool_result",
          toolCallId: call.id,
          status: outcome.status,
          output: outcome.output,
        });
      }
      // 结果已落盘 → 下一圈 deriveMessages 自然带上它们
    }

    throw new Error(`turn 超过 ${MAX_STEPS} 步仍未收敛，已中止`);
  }
}
