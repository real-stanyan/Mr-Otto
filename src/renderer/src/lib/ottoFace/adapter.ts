// 仓里已有的四套状态枚举 → 一个 FaceState。
//
// **这是整个库唯一和 Mr Otto 耦合的文件。** 其余部分只认 `FaceState` 这个字符串，
// 所以库本身可以单独拿走、单独测；要接别的产品只需重写这一个文件。
//
// `agentPhase()` / `orbState()` 一个字不改——这里调它们、读它们的返回值。那两个
// 纯函数已经把优先级的法理写清楚了（审批 > 等执行器 > 压缩 > 工具 > 正文 > 思考；
// 以及「等你」压过「在跑」），在这里重新排一遍序就是把同一条规矩写第二遍，
// 而两份迟早分家。

import type { BackgroundRunState } from "../../../../shared/backgroundRuns.js";
import type { OrbState as PhaseOrb } from "../../../../shared/toolSummary.js";
import { agentPhase, type AgentPhaseInput } from "../agentPhase.js";
import { orbState } from "../sessionOrb.js";
import type { FaceState } from "./states.js";

/** 通话里一只 agent 的状态词（VoiceCallOverlay 的 `t.state`） */
export type VoiceState = "speaking" | "thinking" | "listening" | "idle";

const ORB_TO_FACE: Readonly<Record<PhaseOrb, FaceState>> = {
  listening: "waiting",
  searching: "searching",
  working: "working",
  composing: "thinking",
  solving: "answering",
  weaving: "weaving",
  // `breathing` 在 agentPhase() 里一个分支都没用到（声明了没人读）。接到「空闲」上
  // 是它字面意思最近的一格；真要给它别的含义，改这一行即可
  breathing: "idle",
};

export interface FaceSourceInput {
  /** turn 在不在跑。false 且无审批时，`agentPhase()` 压根不该被调用 */
  readonly running: boolean;
  /** `openTurns()` 里这只 agent 的那一行；没有就是没人欠它回答 */
  readonly openTurn?: { readonly state: "queued" | "running" } | undefined;
  /** 通话里的状态；不在通话里就不传 */
  readonly voice?: VoiceState | undefined;
  /** 后台任务跑完但还没注回对话 */
  readonly background?: BackgroundRunState | undefined;
  /** 模型 API 错误分类 */
  readonly errorClass?: "rate-limit" | "retryable" | "fatal" | undefined;
  /** 同步冻结 / MCP 连不上 —— 都是「这个不会自己好」 */
  readonly dormant?: boolean;
  /** 久未动静，够久就睡 */
  readonly idleMs?: number;
  /** 喂给 `agentPhase()` 的那份投影 */
  readonly phase?: AgentPhaseInput | undefined;
}

/** 多久不动算睡着。取 10 分钟：比一轮长任务长得多，比「今天没再打开」短得多 */
export const SLEEP_AFTER_MS = 10 * 60 * 1000;

/** 优先级从上到下，**与 `orbState()` 的法理同序**：停住不动的先说，其次在跑，最后闲着。
 *
 *  `dormant` 排在最前不是因为它更要紧，而是因为它一旦成立，下面每一格读出来的都是
 *  过期快照——一个连不上的 agent 显示「在跑」，说的是它崩之前那一刻的事。 */
export function faceStateFor(input: FaceSourceInput): FaceState {
  if (input.dormant === true) return "frozen";
  if (input.errorClass === "fatal") return "failed";
  if (input.errorClass === "rate-limit") return "ratelimit";
  if (input.background === "failed") return "failed";
  if (input.background === "ready") return "done";

  // 通话中它有自己一套说法（在说 / 在想 / 在听），压过下面的 turn 状态：
  // 人此刻看的是通话那一屏，那里的语义才对得上
  if (input.voice === "speaking") return "speaking";
  if (input.voice === "listening") return "listening";
  if (input.voice === "thinking") return "thinking";

  // queued 必须排在 agentPhase 之前：它一个 token 都还没跑，
  // 而 agentPhase 的调用前提是「turn 在跑」（它自己的注释）
  if (input.openTurn?.state === "queued") return "queued";

  if (input.phase !== undefined && (input.running || input.phase.hasApproval)) {
    return ORB_TO_FACE[agentPhase(input.phase).orb];
  }

  const orb = orbState({ waiting: input.phase?.hasApproval === true, running: input.running });
  if (orb === "waiting") return "waiting";
  if (orb === "running") return "thinking";
  return (input.idleMs ?? 0) >= SLEEP_AFTER_MS ? "sleep" : "idle";
}
