// endpointJudge —— 语音通话里「这句说完了吗」那一问的主进程半边（#1281，spec §5.4 ⑤）。
//
// 渲染层的 utteranceHold 状态机在人停嘴那一刻经 IPC 问到这里；这里拼问题、经
// decisionClient 走网关、回一个 P(说完了)。渲染层不能自己问：硬规则——渲染进程只通过
// ShellBridge 与后端通信，而那一问要带用户的 JWT。
//
// 另一半是**真值日志**。这一处与另外四处不同：别处的对照物是「今天那条 LLM 路怎么判」，
// 这里今天没有 LLM 路，但真值是**观测得到的**——final 之后 1.8 秒内人有没有接着说。
// 主进程本来就过手 helper 的每一条事件（转发给渲染层之前），所以在这里记最省事：
// 不用给渲染层另开一条回报通道。`level` 事件 10Hz，是现成的钟。
// **日志里没有正文**，只有字数——转写是人说的话，不该躺在控制台里。

import { noul, type DecisionQuestion, type DecisionState } from "../shared/decision.js";
import type { SpeechEvent } from "../shared/shellBridge.js";
import { HOLD_MS as RESUME_WINDOW_MS } from "../shared/utteranceTiming.js";
import type { DecisionClient } from "./decisionClient.js";

/** 投机问发生在人停嘴那一刻，helper 最早 700ms 之后才 final——900ms 内回不来的答案，
    渲染层那侧再等 200ms 也就放弃了，这里不必等更久 */
export const ENDPOINT_DECISION_TIMEOUT_MS = 900;
const SAID_MAX = 600;
const ASKED_MAX = 300;
// RESUME_WINDOW_MS 与渲染层 utteranceHold 的 HOLD_MS 是同一个数、同一处定义
// （`src/shared/utteranceTiming.ts`）：真值问的就是「扣那么久值不值」，两处必须
// 量同一扇窗，import 别名只是让这个文件里读起来仍是「真值窗口」这个意思。

export function endpointQuestions(said: string, asked: string | null): { state: DecisionState; questions: Record<string, DecisionQuestion> } {
  return {
    state: { said: said.slice(0, SAID_MAX), asked: (asked ?? "").slice(0, ASKED_MAX) },
    questions: {
      done: noul(
        "语音通话里，一个人说了 `said` 这句话然后停了一下（`asked` 是对方刚才说的上一句，可能为空）。这句话说完了吗——意思已经表达完整、在等对方回应？",
        "意思完整，可以作为一句话单独成立；或者是对 `asked` 的一个完整回答，哪怕只有一两个词",
        "话说到一半：句子缺成分、以连接词或语气停顿收尾、明显还有下文",
      ),
    },
  };
}

export interface EndpointJudge {
  judge(said: string, asked: string | null): Promise<number | null>;
  /** helper 的每一条事件转发给渲染层之前先过这里（只读，不改事件） */
  onSpeechEvent(ev: SpeechEvent): void;
}

export function createEndpointJudge(deps: {
  decision: Pick<DecisionClient, "mode" | "decide">;
  log?: (line: string) => void;
  now?: () => number;
}): EndpointJudge {
  const now = deps.now ?? (() => Date.now());
  let lastAsked: { said: string; p: number } | null = null;
  let pending: { p: number; at: number; chars: number } | null = null;
  const line = (resumed: boolean): void => {
    if (pending === null) return;
    deps.log?.(`[decision] ${JSON.stringify({ use: "endpoint", mode: deps.decision.mode("endpoint"), p: pending.p, resumed, chars: pending.chars })}`);
    pending = null;
  };
  return {
    async judge(said, asked) {
      if (deps.decision.mode("endpoint") === "off") return null;
      const { state, questions } = endpointQuestions(said, asked);
      const a = (await deps.decision.decide("endpoint", state, questions, ENDPOINT_DECISION_TIMEOUT_MS))?.answers.done;
      if (!a || a.type !== "noul") return null;
      lastAsked = { said: said.trim(), p: a.noul };
      return a.noul;
    },
    onSpeechEvent(ev) {
      if (pending !== null && now() - pending.at > RESUME_WINDOW_MS) line(false);
      if (ev.type === "partial" && ev.text.trim() !== "" && pending !== null) line(true);
      if (ev.type === "final") {
        const text = ev.text.trim();
        // 问的是合起来的那句（扣着的 + 新那一段），final 带的只是新那一段——所以是 endsWith
        if (lastAsked !== null && text !== "" && lastAsked.said.endsWith(text)) {
          pending = { p: lastAsked.p, at: now(), chars: [...text].length };
        }
        lastAsked = null;
      }
    },
  };
}
