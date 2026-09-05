// cloudTimeline —— 云会话时间线：谁说的 / 说给谁 / 谁还没回（Task 10，#932 切片 1b）。
//
// 从 CloudSessionPage.tsx 搬出来的纯逻辑（parseUserMessageLabel 原样搬 +
// 两个新的署名/归属函数）：组件旁边放一个 lib 是本仓的既有惯例
// （src/renderer/src/lib/workspaceView.ts 同款），纯函数零 React 也方便
// 单独写测试（tests/renderer/cloudTimelineLabels.test.ts）。

import { agentNameOf, labelOf } from "./workspaceView.js";
import type {
  AgentRelayEvent, ApprovalDecisionEvent, ApprovalRequestEvent, AssistantMessageEvent, RouteChangedEvent, SessionEvent, UserMessageEvent,
} from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { CREATE_AGENT_TOOL_NAME } from "../../../shared/createAgentDraft.js";
import { countdown } from "./billingView.js";

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

/** 审批卡第一行（#957 C-I3）：多智能体是这一批六片的全部意义，两张卡工具名
    相同、argsSummary 前 200 字也可能相同时，"批准哪一张"必须先说清"是哪只
    agent 要的这份权限"。agentId 缺席（旧日志）→ 沿用现状的裸工具名，不装作
    答得出这个问题（同 assistantLabel 的兜底纪律） */
export function approvalCardTitle(e: ApprovalRequestEvent, ws: WorkspaceSnapshot): string {
  return e.agentId ? `「${agentNameOf(ws, e.agentId)}」请求 ${e.toolName}` : e.toolName;
}

/** 「谁批的」（#957 M8）：decidedBy 是云 runtime 专门认定的字段，本地单人会话
    没有意义（缺席=本地会话/旧日志，同字段自身的注释），此时不装作有答案，
    交给调用方决定要不要画这一行 */
export function decisionLineText(e: ApprovalDecisionEvent, _ws?: WorkspaceSnapshot): string | null {
  if (!e.decidedBy) return null;
  return `由 ${e.decidedBy.label} ${e.decision === "approved" ? "批准" : "拒绝"}`;
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

const ROUTE_LABEL: Record<RouteChangedEvent["from"], string> = {
  hosted: "托管",
  workspace: "工作区自带 key",
  direct: "自带 key",
};

const ROUTE_REASON_TEXT: Record<RouteChangedEvent["reason"], string> = {
  quota_exhausted: "本周额度用完",
  probe_failed: "订阅探测失败",
  no_subscription: "所有者没有活跃订阅",
  subscription_active: "订阅恢复",
};

/** `route_changed` 的时间线文案（第一批 Task 6 复审 Minor 7，#957 Task 7b）：`to==="direct"`
    是桌面唯一的、在这套 reason 语义之前就有的换轨（额度用完退回本机 key），旧日志里全是
    这句话——**逐字节保留**，不套下面的通用模板（brief 的硬约束，同 schema 向后兼容的
    Hard rule：旧日志必须永远可重放）。
    `subscription_active` 只在换回 hosted 时出现（`decideRuntimeRoute` 只在 `route.kind
    === "hosted"` 时判这个 reason），措辞走「改回」不走「改道：X → Y」——「改道」暗示
    从谁那儿抢了额度，而这一格说的是恢复原状。
    其余（`probe_failed` / `no_subscription` / `quota_exhausted` 落在非 direct 的
    工作区↔托管之间）用通用模板：改道：<from> → <to>（<原因>）。`resetAt` 有值时在原因后面
    追加「，X 恢复」——用 Timeline.tsx 原本就在用的 `countdown`（同一扇窗两处不能各写一份，
    ADR-0209 那条纪律） */
export function routeChangedText(e: RouteChangedEvent, now: number = Date.now()): string {
  if (e.to === "direct") {
    const base = "订阅额度已用完，本次起用的是你自己的 key";
    return e.resetAt !== undefined ? `${base}（${countdown(e.resetAt, now)}）` : base;
  }
  if (e.reason === "subscription_active") {
    return `改回${ROUTE_LABEL[e.to]}（订阅恢复）`;
  }
  const resetSuffix = e.resetAt !== undefined ? `，${countdown(e.resetAt, now)}` : "";
  return `改道：${ROUTE_LABEL[e.from]} → ${ROUTE_LABEL[e.to]}（${ROUTE_REASON_TEXT[e.reason]}${resetSuffix}）`;
}
