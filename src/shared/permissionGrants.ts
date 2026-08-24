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
// 授权的粒度从 v1 的"整个工具"收窄成**规范化 key**（issue #342，规则见
// shared/grantKey.ts）："同一个能力"的答案现在说得清了——bash 按 token 化后的
// 命令、write_file 按路径、其余工具按工具名，全部掺 cwd。说不清的复杂脚本
// 退化原文精确匹配，宁窄勿宽。旧的裸工具名条目按宽语义兼容（见 grantKey.ts）。

import type { SessionEvent, ToolCallRequest } from "../session/events.js";
import { grantKeysFor } from "./grantKey.js";

/** 授权档位。"once" 不在这里 —— 只批这一次就是不授权，approval_decision.grant 缺席 */
export type GrantScope = "session" | "always";

/**
 * 本会话已经授权过的 key 集合（从日志推）。
 *
 * 只认 approved 的那条：拒绝时按钮压根不带 grant，但日志是外部输入，
 * 不赌它的形状——denied 带着 grant 也不算数。
 *
 * key 从当时那次调用的**实际执行参数**推（revisedArgs 优先，ADR-0041 分块审批：
 * 用户只放行了改过的那份，授权范围也只能是那份）；cwd 取日志第 0 条的 workspace
 * ——与授权发生时刻 agent.grant 用的 opts.workspace 是同一个事实，resume 重建
 * 出的 key 必然与当时写下的逐字节一致。
 */
export function sessionGrants(events: readonly SessionEvent[]): Set<string> {
  const workspace = events.find(
    (e): e is Extract<SessionEvent, { type: "session_created" }> => e.type === "session_created"
  )?.workspace;
  const byCall = new Map<string, ToolCallRequest>();
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    for (const c of e.toolCalls ?? []) byCall.set(c.id, c);
  }
  const granted = new Set<string>();
  for (const e of events) {
    if (e.type !== "approval_decision") continue;
    if (e.decision !== "approved" || e.grant === undefined) continue;
    const call = byCall.get(e.toolCallId);
    // 对不上号的决定（日志被截断/工具调用不在这段里）不算授权：
    // 授的是"哪次调用"的权，不知道是哪次就不能放行
    if (call === undefined) continue;
    const effective = e.revisedArgs !== undefined ? { ...call, args: e.revisedArgs } : call;
    for (const k of grantKeysFor(effective, workspace)) granted.add(k);
  }
  return granted;
}

/** 给人看的档位文案。审批决定的 reason 里也用它——日志里那句话得自解释 */
export function grantLabel(scope: GrantScope): string {
  return scope === "session" ? "本次会话" : "永久";
}
