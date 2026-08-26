// 运行指示条那枚药丸上写什么、配哪个 orb 动画。
//
// 从 OttoThread.tsx 搬出来（issue #549）：它是纯判定，搬出来才测得动——原来住在
// 一个上千行的组件模块里，想断言"审批比压缩优先"就得挂载整棵 Thread。
//
// 判定的输入全是日志/推送的投影，这里不产生任何新事实，只把它们排成一个优先级。

import type { ToolCallRequest } from "../../../session/events.js";
import type { OrbState } from "../../../shared/toolSummary.js";

export interface AgentPhaseInput {
  /** 挂着审批卡。最优先——agent 此刻停在原地等人，别的都不重要 */
  hasApproval: boolean;
  /** 正在压缩上下文。它复用 running 灯，靠这一位才分得出和普通 turn */
  compacting: boolean;
  /** 正文已经在流 */
  streamingText: string;
  /** 当前执行中的工具（有请求、无结果 = 还没落地） */
  tool: ToolCallRequest | null;
}

/** agent 当前阶段 → orb 动画 + 文案。审批等待最优先，其后按「在跑哪个环节」细分：
    检索(read_file) / 执行(bash·write_file…) / 作答(正文) / 思考(其余)。
    对应 orbs 的 Listening / Weaving / Searching / Working / Solving / Composing。

    **调用方保证 turn 在跑**（或有挂起审批）——RunIndicator 在算这个之前就已经
    `return null` 了。所以这里没有"空闲"这一档：以前有一条 `status !== "running"
    → 空闲` 的分支，它永远返回不出去（有审批时上一行先赢，没审批时组件压根不渲染），
    只是让读代码的人以为这个函数管 idle（issue #549）。

    reasoning 在流和「请求已发、第一个 token 还没回」共用"思考中…"：两者都是
    "模型在想"，UI 上没有区分的必要，所以这里也不收 streamingThinking——
    以前收了但没有任何分支读它（同 issue）。真要给 reasoning 单开一档是产品决定，
    不是这次清理该顺手做的事。 */
export function agentPhase(input: AgentPhaseInput): { orb: OrbState; label: string } {
  if (input.hasApproval) return { orb: "listening", label: "等待审批…" };
  // weaving = 把一长段历史织成一份摘要，比"思考"的旋转更贴这件事
  if (input.compacting) return { orb: "weaving", label: "压缩中…" };
  if (input.tool?.name === "read_file") return { orb: "searching", label: "检索中…" };
  if (input.tool) return { orb: "working", label: "执行中…" };
  if (input.streamingText) return { orb: "solving", label: "作答中…" };
  return { orb: "composing", label: "思考中…" };
}
