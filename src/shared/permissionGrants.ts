// 长期许可 —— 「批准这一次」之外的两档（ADR-0041）。
//
// 三个事实分居三处，是有意的：
//   ① 授权发生的**那一刻** → approval_decision.grant（日志，唯一事实来源）
//   ② 本会话有效的许可     → 从日志推得出（下面的 sessionGrants），不另存一份
//   ③ 永久有效的许可       → 跨会话，日志推不出，存在 userData（main/permissionStore.ts）
//
// ② 之所以是投影而不是一份内存状态：重开 app、重放同一段日志，界面和行为该长得一样。
// 一个会话中途授权过的工具，恢复会话时必须还是授权状态——从日志扫一遍就有了，
// 再存一份内存副本只是多一个会不一致的地方。
//
// 授权的粒度是**工具**（write_file / bash），不是"某个路径的 write_file"。
// 更细的粒度不是做不出来，是说不清：参数出自模型，下一次的路径未必长得像这一次，
// "同一个能力"到底指什么得先有答案。粒度粗一档、说得清，好过细一档、蒙人。

import type { SessionEvent } from "../session/events.js";

/** 授权档位。"once" 不在这里 —— 只批这一次就是不授权，approval_decision.grant 缺席 */
export type GrantScope = "session" | "always";

/**
 * 本会话已经授权过的工具（从日志推）。
 *
 * 只认 approved 的那条：拒绝时按钮压根不带 grant，但日志是外部输入，
 * 不赌它的形状——denied 带着 grant 也不算数。
 */
export function sessionGrants(events: readonly SessionEvent[]): Set<string> {
  const byCall = new Map<string, string>(); // toolCallId → tool name
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    for (const c of e.toolCalls ?? []) byCall.set(c.id, c.name);
  }
  const granted = new Set<string>();
  for (const e of events) {
    if (e.type !== "approval_decision") continue;
    if (e.decision !== "approved" || e.grant === undefined) continue;
    const tool = byCall.get(e.toolCallId);
    // 对不上号的决定（日志被截断/工具调用不在这段里）不算授权：
    // 授的是"哪个工具"的权，不知道是哪个就不能放行
    if (tool !== undefined) granted.add(tool);
  }
  return granted;
}

/** 给人看的档位文案。审批决定的 reason 里也用它——日志里那句话得自解释 */
export function grantLabel(scope: GrantScope): string {
  return scope === "session" ? "本次会话" : "永久";
}
