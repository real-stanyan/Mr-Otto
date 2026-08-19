// LoopEngine — 把环闭上：输入 → 落盘 → 投影 → 模型 → 落盘 → 工具 → 落盘 → 再投影……
// 不变量执行处：每一步先 append 再继续，模型看到的永远是日志的投影。

import type { EventStore, NewSessionEvent } from "../session/store.js";
import type { SessionEvent, UserAttachmentRef, UserTextFile } from "../session/events.js";
import { deriveMessages, DEFAULT_COMPRESSION, COMPACT_COMPRESSION } from "../session/deriveMessages.js";
import type { DeltaKind, ModelAdapter } from "../model/adapter.js";
import type { Tool } from "../tools/tool.js";
import { withAbortSignal, withExecOutput, type ExecutionWorld } from "../world/executionWorld.js";
import { runPipeline } from "./middleware.js";
import type { ToolCallContext, ToolMiddleware, ToolOutcome } from "./middleware.js";
import { createApprovalGate } from "./approvalGate.js";
import type { Approver } from "./approvalGate.js";
import { createReasoningClock } from "./reasoningClock.js";

/** AbortError 判定：fetch 中止、signal.reason、throwIfAborted 抛的都是它 */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export interface LoopEngineOptions {
  store: EventStore;
  adapter: ModelAdapter;
  tools: Tool[];
  world: ExecutionWorld;
  sessionId: string;
  /** 每条事件落盘后回调 —— CLI 打印、将来 UI 实时刷新都挂这 */
  onEvent?: (event: SessionEvent) => void;
  /** 流式文本碎片回调（临时 UI 直播，不是事实）。kind 区分思考/正文两条频道。
      半成品永不落盘：日志只收凝固后的完整 assistant_message——
      pi 的"消息完成后不可修改"同款边界 */
  onAssistantDelta?: (text: string, kind: DeltaKind) => void;
  /** 工具输出直播回调（bash 的 stdout/stderr 碎片，临时 UI 直播，不是事实）。
      和 onAssistantDelta 一对儿：碎片不落盘，完整输出以 tool_result 事件落盘 */
  onToolOutput?: (toolCallId: string, chunk: string, stream: "stdout" | "stderr") => void;
  /** requiresApproval 工具的审批人；不给 = 危险操作一律默认拒绝 */
  approver?: Approver;
  /** 额外中间件，插在审批门之后、执行器之前（日志、限流、脱敏都从这进） */
  middlewares?: ToolMiddleware[];
}

export class LoopEngine {
  private readonly toolsByName: Map<string, Tool>;
  private readonly pipeline: ToolMiddleware[];
  private adapter: ModelAdapter;
  /** 当前 turn 的中断开关；idle 时为 null。每个 turn 一个新的——
      AbortSignal 是一次性的，翻过去就回不来 */
  private turnAbort: AbortController | null = null;

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
    // 碰世界之前先留痕（ADR-0004）：崩溃后"有 started 无 result" = 悬空执行。
    // 被拒绝的调用到不了这（审批门短路），所以 denied 没有此事件
    this.append({ ...this.env(), type: "tool_execution_started", toolCallId: ctx.call.id });
    try {
      const raw = await ctx.tool.run(ctx.call.args, ctx.world, {
        toolCallId: ctx.call.id,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      // run 可返回字符串（现状）或 { output, concludesTurn }（DSH 式提前收口）
      if (typeof raw === "string") return { status: "ok", output: raw };
      return {
        status: "ok",
        output: raw.output,
        ...(raw.concludesTurn ? { concludesTurn: true } : {}),
      };
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

  /** 中断当前 turn（ADR-0006）。幂等：没 turn 在跑 / 重复按都是无操作。
      效果 = 信号翻转，三个可能卡住的位置各自醒来：
      fetch/SSE 抛 AbortError、审批 resolve 成 denied、bash 子进程收 SIGTERM */
  abortTurn(): void {
    this.turnAbort?.abort();
  }

  /** 跑一个完整 turn：直到模型不再要工具为止。
      收口和暴死都落 turn_ended（ADR-0004）——错误照旧向上抛，落盘是补记事实不是吞错。
      中断（ADR-0006）落 outcome:"aborted" 且不抛：停止是用户意志，不是故障 */
  async runTurn(
    userInput: string,
    attachments?: UserAttachmentRef[],
    textFiles?: UserTextFile[]
  ): Promise<void> {
    this.append({
      ...this.env(),
      type: "user_message",
      content: userInput,
      // 空数组不落字段:无附件的事件形状与从前逐字节一致(投影回归测试的前提)
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(textFiles && textFiles.length > 0 ? { textFiles } : {}),
    });
    this.turnAbort = new AbortController();
    try {
      await this.loop(this.turnAbort.signal);
      this.append({ ...this.env(), type: "turn_ended", outcome: "completed" });
    } catch (err) {
      if (isAbort(err)) {
        this.append({ ...this.env(), type: "turn_ended", outcome: "aborted" });
        return;
      }
      this.append({
        ...this.env(),
        type: "turn_ended",
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.turnAbort = null;
    }
  }

  /** turn 主循环 —— DSH 式收敛：不数步数，靠数据信号收口。
      两个结束信号：(1) 模型这步没要任何工具（说完了）；(2) 某次工具结果声明
      concludesTurn（提前收口）。失控空转的兜底是用户停止键（abort 信号，
      ADR-0006），不是预设步数天花板。 */
  private async loop(signal: AbortSignal): Promise<void> {
    const { store, sessionId } = this.opts;
    // 工具拿到的 world 天生带中断信号（装饰器），工具代码对中断无感——
    // 硬规则"工具只依赖 ExecutionWorld"原样成立
    const world = withAbortSignal(this.opts.world, signal);

    while (true) {
      signal.throwIfAborted(); // 上一圈工具被杀后从这收口，不再浪费一次投影

      // 永远从日志现算上下文——loop 自己不持有任何对话状态。
      // 带压缩：老 turn 的长工具输出折叠（确定性，重放可还原模型视野）
      const messages = deriveMessages(store.load(sessionId), DEFAULT_COMPRESSION);
      // 思考耗时只有在碎片流里才测得到:包一层记下频道切换的时刻,原回调原样透传
      const clock = createReasoningClock();
      const onDelta = this.opts.onAssistantDelta;
      const reply = await this.adapter.chat(
        messages,
        this.opts.tools.map((t) => t.def),
        onDelta
          ? (text, kind) => {
              clock.observe(kind);
              onDelta(text, kind);
            }
          : undefined, // 非流式路径:测不到就不测,字段缺席
        signal // 中断从这穿进 fetch / SSE 读流
      );
      const reasoningMs = clock.finish();

      this.append({
        ...this.env(),
        type: "assistant_message",
        content: reply.content,
        model: this.adapter.model,
        ...(reply.toolCalls ? { toolCalls: reply.toolCalls } : {}),
        ...(reply.usage ? { usage: reply.usage } : {}), // token 账单随事件落盘，UI 从日志求和
        // 思考过程随消息落盘（模型产出的新信息，丢了回放就永远缺这段）；
        // 投影层会丢弃它——API 禁止思考回流上下文
        ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        // 耗时只在真有思考内容时才有意义(空思考的耗时是噪音)
        ...(reply.reasoning && reasoningMs !== null ? { reasoningMs } : {}),
      });

      if (!reply.toolCalls || reply.toolCalls.length === 0) return; // 模型说完了

      for (const call of reply.toolCalls) {
        // 中断后剩余调用不再执行，但必须补上结果——OpenAI 方言要求每个
        // tool_call 都有答复，缺一个 = 会话投影永久 400（ADR-0005 的教训）。
        // 补的是事实（"没执行"），不是伪造的输出
        if (signal.aborted) {
          this.append({
            ...this.env(),
            type: "tool_result",
            toolCallId: call.id,
            status: "error",
            output: "调用未执行：用户中断了 turn。执行器未达，世界未被此调用变更。",
          });
          continue;
        }
        // 按调用再包一层：输出直播的回调在这绑上 toolCallId——
        // world 到工具手里已经"知道"该把碎片挂到哪次调用，工具自己无感
        const onToolOutput = this.opts.onToolOutput;
        const callWorld = onToolOutput
          ? withExecOutput(world, (chunk, stream) => onToolOutput(call.id, chunk, stream))
          : world;
        const outcome = await runPipeline(this.pipeline, (ctx) => this.execute(ctx), {
          call,
          tool: this.toolsByName.get(call.name),
          world: callWorld,
          sessionId,
          signal,
        });
        this.append({
          ...this.env(),
          type: "tool_result",
          toolCallId: call.id,
          status: outcome.status,
          output: outcome.output,
        });
        // concludesTurn = 数据驱动的提前收口（DSH 同款）：本步到此为止，
        // 不给模型补答的机会，turn 直接 completed
        if (outcome.concludesTurn) return;
      }
      // 结果已落盘 → 下一圈 deriveMessages 自然带上它们
    }
  }
}
