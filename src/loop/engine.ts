// LoopEngine — 把环闭上：输入 → 落盘 → 投影 → 模型 → 落盘 → 工具 → 落盘 → 再投影……
// 不变量执行处：每一步先 append 再继续，模型看到的永远是日志的投影。

import type { EventStore, NewSessionEvent } from "../session/store.js";
import type { SessionEvent } from "../session/events.js";
import { deriveMessages, DEFAULT_COMPRESSION, COMPACT_COMPRESSION } from "../session/deriveMessages.js";
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

  /** /compact：把现有上下文交给模型写摘要，摘要落盘成 context_compacted 事件，
      之后的投影从摘要起步。贵（一次全量输入 + 摘要输出），所以只由用户手动触发。
      摘要出自模型（不确定），而模型今后看到的就是它 —— model-visible means logged。 */
  async compact(): Promise<void> {
    const { store, sessionId } = this.opts;
    // 摘要专用投影（ADR-0003）：整段历史无保真区，长工具输出/参数都截断——
    // 摘要人要的是"发生了什么"，不是逐字证据；输入 token 是 compact 的主要成本
    const messages = deriveMessages(store.load(sessionId), COMPACT_COMPRESSION);
    const reply = await this.adapter.chat([
      ...messages,
      {
        role: "user",
        content:
          "请把以上对话压缩成一份摘要，供后续对话作为唯一的历史记忆使用。保留：任务目标、" +
          "已完成的动作（含涉及的文件路径与命令）、关键决定及其理由、未完成事项。" +
          "直接输出摘要正文，不要开场白。",
      },
    ]); // 不带工具：这一步只要文字
    if (!reply.content.trim()) throw new Error("模型没有产出摘要，compact 已放弃（未写入任何事件）");

    this.append({
      ...this.env(),
      type: "context_compacted",
      summary: reply.content,
      model: this.adapter.model,
      ...(reply.usage ? { usage: reply.usage } : {}),
    });
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
        ...(reply.usage ? { usage: reply.usage } : {}), // token 账单随事件落盘，UI 从日志求和
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
