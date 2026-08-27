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

/** 可见性三态（issue #348，codex ToolExposure 对照）：
    - direct    模型初始工具表就有（缺席时的默认——老工具零改动）
    - deferred  注册了但初始不可见；tool_search 搜到后进入可见集
    - hidden    永不进模型工具表，但仍在 toolsByName 里（内部可调、
                模型误调能收到明确错误而不是崩溃） */
export type ToolExposure = "direct" | "deferred" | "hidden";

/** 工具产出的一张图（原始字节，**不落日志**）。
    工具交字节，落库交给中间件 —— 硬规则：工具只依赖 ExecutionWorld，不碰 fs。
    管线里没装 imageIntake 中间件时（裸装配、单测）这些字节就地丢弃：
    模型看到的正文不受影响（工具自己会在 output 里说"返回了一张图"），
    只是时间线上不出卡。刻意做成静默降级，而不是抛错——一个展示层能力
    不该让工具调用整个失败 */
export interface ToolImage {
  data: Uint8Array;
  /** "image/png" | "image/jpeg" | "image/webp" | "image/gif"；
      认不出的格式在落库那一刻被 AttachmentStore 挡掉 */
  mimeType: string;
}

export interface Tool {
  def: ToolDefinition;
  /** 缺席 = "direct"。事后改数据结构很痛——趁工具还少先把字段落进注册表（#348） */
  exposure?: ToolExposure;
  /** true = 执行前必须过人工审批门（下一课接入管线） */
  requiresApproval: boolean;
  /** true = 只读且无共享状态，模型同一步里连续的这类调用可以并发执行
      （issue #283 ③）。缺席 = 串行（老工具/有副作用的一个字不用改）。
      只给真正"怎么并发都无所谓"的工具贴：读文件、搜网页这类；bash/写文件
      天然串行，browser_read 共享同一个浏览器实例的当前页，也不贴 */
  parallelSafe?: boolean;
  /** 挂载(mounted) 和可用(available) 是两件事，别混：挂载答"这次装配拥不拥有
      这把刀"（由 agent.ts 组装时的固定条件决定，一次定终身）；available 答
      "此刻用它能不能干出点什么"（可以每次现算，随外部状态变化）。缺席 = 恒可用，
      老工具一个字不用改。两个用到它的例子：task —— subagentRunner 在场就挂上
      （拥有派活的能力），但清单是空的时候派不出任何人（用不出东西）；mcp 工具
      —— server 掉线时从声明表里消失，但仍留在 toolsByName 里，这样掉线前
      已经发出的调用能收到人话而不是"未知工具" */
  available?: () => boolean;
  /** 返回值 = 喂回模型的 tool_result.output；抛错 = status: "error"。
      也可返回 { output, concludesTurn } —— concludesTurn:true 时 engine 在当步收口整个 turn。
      images 是给人看的产出（见 ToolImage）：喂模型的仍然只有 output */
  run(
    args: unknown,
    world: ExecutionWorld,
    ctx?: ToolRunContext
  ): Promise<string | { output: string; concludesTurn?: true; images?: readonly ToolImage[] }>;
}
