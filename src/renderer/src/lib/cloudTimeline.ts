// cloudTimeline —— 云会话时间线：谁说的 / 说给谁 / 谁还没回（Task 10，#932 切片 1b）。
//
// 从 CloudSessionPage.tsx 搬出来的纯逻辑（parseUserMessageLabel 原样搬 +
// 两个新的署名/归属函数）：组件旁边放一个 lib 是本仓的既有惯例
// （src/renderer/src/lib/workspaceView.ts 同款），纯函数零 React 也方便
// 单独写测试（tests/renderer/cloudTimelineLabels.test.ts）。

import { agentNameOf, labelOf } from "./workspaceView.js";
import type { AgentRelayEvent, AssistantMessageEvent, SessionEvent, UserMessageEvent } from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { CREATE_AGENT_TOOL_NAME } from "../../../shared/createAgentDraft.js";

/** sessionService.ts 的 say() 点火一个 turn 时拼的前缀:`\`[${label}]: ${text}\``。
    协议没有给 user_message 配独立的 fromUid/label 字段（这个事件本来就是
    "普通会话的一条用户消息"，云会话群聊只是把发言人编进了正文），只能在
    渲染层尽力而为地把它解析回来：非贪婪匹配第一个 "]: " 之前的内容当
    label，其余原样当正文。解析不出（旧日志 / 前缀被破坏）就把 label 记
    null、正文原样显示全文，不装作解析成功了 */
export function parseUserMessageLabel(content: string): { label: string | null; text: string } {
  const m = /^\[(.*?)\]: ([\s\S]*)$/.exec(content);
  return m ? { label: m[1]!, text: m[2]! } : { label: null, text: content };
}

/** user_message 行的署名与归属（Task 1 补的 fromUid/mentions 上线后的正路）：
    fromUid 在就按 uid 判"是不是我"——同名两个人也分得开（1a 的前缀比对做
    不到这点）；fromUid 缺席（旧日志）才退回 1a 的"解析出的 label 跟自己
    的展示名比对"。targets 是这句话点了谁（用于标签行末尾的 "→ 谁"），
    查不到名字的 agentId 由 agentNameOf 自己兜底（回 agentId 本身） */
export function userRowIdentity(
  e: UserMessageEvent,
  ws: WorkspaceSnapshot,
  selfUid: string
): { label: string | null; text: string; mine: boolean; targets: string[] } {
  const parsed = parseUserMessageLabel(e.content);
  const mine = e.fromUid ? e.fromUid === selfUid : parsed.label === labelOf(ws, selfUid);
  const targets = (e.mentions ?? []).map((id) => agentNameOf(ws, id));
  return { label: parsed.label, text: parsed.text, mine, targets };
}

/** assistant_message 的署名：agentId 查名单（agentNameOf 查不到回 agentId 本身，
    同旧消息 @提及上留个把手的纪律）；没有 agentId（旧日志/单 agent 会话，
    见 events.ts AssistantMessageEvent.agentId 字段注释）→ "Agent"，
    维持多智能体上线前的既有文案 */
export function assistantLabel(e: AssistantMessageEvent, ws: WorkspaceSnapshot): string {
  return e.agentId ? agentNameOf(ws, e.agentId) : "Agent";
}

/** 接力线文案（#950）：谁 → 谁 · 接力第几棒。名字现查 agentNameOf——被删的
    agent 回 id（同 assistantLabel/targets 的纪律，旧接力线上还得有个把手） */
export function relayLineText(e: AgentRelayEvent, ws: WorkspaceSnapshot): string {
  return `${agentNameOf(ws, e.fromAgentId)} → ${agentNameOf(ws, e.toAgentId)} · 接力第 ${e.depth} 棒`;
}

/** 这条事件要不要在云会话时间线上画出来（#950）：只对带 relay 的 user_message
    为真——那条开场白是给模型看的（"[系统] 「运营」@ 了你"），人看接力线
    （agent_relay 那一行）就够，画出来是同一件事说两遍 */
export function hiddenFromCloudTimeline(e: SessionEvent): boolean {
  return e.type === "user_message" && e.relay !== undefined;
}

/** 管理员刚建成一只 agent（#954）：create_agent 的 tool_result{status:"ok"}。桌面的名册住在
    WorkspaceSnapshot.agents，没有推送通道（store.ts refreshWorkspaceGroups 的注释），看见这条
    就重拉一次——不新增事件类型（那是十一处清单的代价），判据从日志里既有的两条事件反查：
    tool_result 只带 toolCallId，工具名在配对的 assistant_message.toolCalls 里 */
export function createAgentLanded(events: readonly SessionEvent[], e: SessionEvent): boolean {
  if (e.type !== "tool_result" || e.status !== "ok") return false;
  return events.some(
    (p) => p.type === "assistant_message" && (p.toolCalls ?? []).some((c) => c.id === e.toolCallId && c.name === CREATE_AGENT_TOOL_NAME)
  );
}
