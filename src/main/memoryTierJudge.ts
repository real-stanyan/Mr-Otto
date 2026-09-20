// 记忆分档核对的主进程装配（#1281）：把 decisionClient 包成工具认得的那个注入函数。
// 工具不 import 网络（硬规则：工具只依赖 ExecutionWorld），所以判断从这里递进去。
// 三态在这一层收口：off 不问；shadow 只记一行、回 null（工具照常写）；on 回 mismatch。
// **日志里没有正文**——记忆条目可能是关于用户本人的事。

import { TIER_DECISION_TIMEOUT_MS, tierMismatches, tierQuestions, type MemoryTierJudge } from "../shared/memoryTierJudge.js";
import type { DecisionClient } from "./decisionClient.js";

export function createMemoryTierJudge(decision: Pick<DecisionClient, "mode" | "decide">, log?: (line: string) => void): MemoryTierJudge {
  return async (contents, target, projectLabel) => {
    const mode = decision.mode("memory");
    if (mode === "off" || contents.length === 0) return null;
    const { state, questions } = tierQuestions(contents, projectLabel);
    const reply = await decision.decide("memory", state, questions, TIER_DECISION_TIMEOUT_MS);
    if (reply === null) return null;
    const hits = tierMismatches(reply, target, contents.length);
    log?.(`[decision] ${JSON.stringify({ use: "memory", mode, target, entries: contents.length, mismatches: hits.map((h) => ({ suggested: h.suggested, confidence: h.confidence })) })}`);
    return mode === "on" ? hits : null;
  };
}
