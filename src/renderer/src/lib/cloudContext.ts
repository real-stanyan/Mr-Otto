// 云会话输入框右下角那枚上下文用量环的数据源（#1138）——全是日志投影，没有独立状态。
//
// #985 把云会话输入框换成本地同款时，把这枚环连同型号 / thinking 一起当成「团队的
// 属性」少掉了。那两样确实是（ADR-0202 / 0233）；上下文不是——它是**每只 agent
// 各自的**事实，日志里就推得出来，和本地会话那枚环读的是同一份 contextBreakdown。
//
// 与本地那条路的三处差别，每一处都是「云会话是群聊」带来的：
//
// ① **视野按 agent 分**。群里每只 agent 读的是自己那份视野（runtime 的 agentView，
//    ADR-0219），账单锚点也各是各的。整份日志当一只算的话，`billingAnchor` 取的是
//    最后一条带 usage 的 assistant_message——A 刚报了 50K 的账，B 回一句 8K 的话，
//    环就从 40% 掉到 6%，而谁都没压缩。projectForAgent 是同一份判据，不另写一遍。
// ② **工具表从信封取**。本地那枚环的 tools 是主进程报上来的 toolDefs；云会话的工具
//    挂在 VPS 的 runtime 上，桌面没有那份表，日志里唯一的快照是 engine 落的
//    request_envelope（它带全量 tools）。取**这只 agent 自己**最后一条信封的。
// ③ **窗口按这只 agent 最后一次真跑的型号查目录**（request_envelope / assistant_message
//    的 model，事实不是配置）；一次都没跑过时退回 welcome 带回的团队默认款。目录不
//    认识的一律 null——不画、不比（#193 的判据，与 daemon 的 contextWindowOf 同一条）：
//    按假分母报百分比比不报更糟。
//
// 环画**最吃紧**那只（bindingContextRow，同 PlanQuotaSection 的 bindingWindow 取法），
// 浮层里逐只列。这里只有纯函数；色档与画法在 components/CloudContextRing.tsx。

import type { SessionEvent } from "../../../session/events.js";
import type { ToolDefinition } from "../../../model/adapter.js";
import { projectForAgent } from "../../../session/agentView.js";
import { contextBreakdown, type ContextBreakdown } from "../../../shared/contextEstimate.js";
import { findModel } from "../../../shared/modelCatalog.js";
import { fmtCtx } from "./fmtTokens.js";

export interface AgentContextRow {
  /** 哪只 agent 的视野。undefined = 日志里还没有任何一只 agent 的痕迹（多智能体
      上线前的旧云会话，或这条会话还没人开过口）——整份日志当一份视野 */
  agentId: string | undefined;
  /** 最后一次真跑的型号；没跑过时是团队默认款；那也没有 = null */
  model: string | null;
  /** 目录里那款的窗口；目录不认识 / 没有型号 = null */
  window: number | null;
  breakdown: ContextBreakdown;
  /** 已用百分比（0–100+，不钳——钳是画的时候的事）；窗口未知 = null */
  percent: number | null;
}

/** 目录里这款的窗口；不认识一律 null。判据与 daemon 的 contextWindowOf 逐字相同：
    contextWindowKnown 那一位存在的全部理由就是「兜底常量不许拿来算百分比」 */
export function contextWindowOf(model: string | null): number | null {
  if (model === null) return null;
  const c = findModel(model);
  return c?.contextWindowKnown ? c.contextWindow : null;
}

/** 日志里露过面的 agent，按第一次露面的顺序。判据是「发过请求或回过话」
    （request_envelope / assistant_message 带 agentId）——agent_briefed 那种「就位」
    不算：就位了却一个字没跑过的 agent 没有上下文可言 */
function agentsInOrder(events: readonly SessionEvent[]): string[] {
  const seen: string[] = [];
  for (const e of events) {
    if (e.type !== "request_envelope" && e.type !== "assistant_message") continue;
    if (e.agentId === undefined || seen.includes(e.agentId)) continue;
    seen.push(e.agentId);
  }
  return seen;
}

/** 这份视野里**这只 agent 自己**最后一次请求的事实：型号 + 信封里的工具表。
    要按 agentId 过滤：projectForAgent 会把别人说出口的那半留在我的视野里
    （剥掉 toolCalls / usage，但 model 与 agentId 还在），倒着扫第一个撞上的
    可能是别人的回复，拿它的型号当我的窗口就错了 */
function lastRequestFacts(
  view: readonly SessionEvent[],
  agentId: string | undefined,
): { model: string | null; tools: ToolDefinition[] } {
  let model: string | null = null;
  let tools: ToolDefinition[] | null = null;
  for (let i = view.length - 1; i >= 0 && (model === null || tools === null); i--) {
    const e = view[i]!;
    if (e.type === "request_envelope") {
      if (e.agentId !== agentId) continue;
      model ??= e.model;
      tools ??= e.tools;
    } else if (e.type === "assistant_message") {
      if (e.agentId !== agentId) continue;
      model ??= e.model;
    }
  }
  return { model, tools: tools ?? [] };
}

function rowFor(agentId: string | undefined, view: SessionEvent[], fallbackModel: string | null): AgentContextRow {
  const facts = lastRequestFacts(view, agentId);
  const model = facts.model ?? fallbackModel;
  const window = contextWindowOf(model);
  const breakdown = contextBreakdown(view, facts.tools);
  return {
    agentId,
    model,
    window,
    breakdown,
    percent: window === null ? null : (breakdown.total / window) * 100,
  };
}

/** 每只露过面的 agent 一行；一只都没有时整份日志当一行（agentId = undefined） */
export function cloudContextRows(events: SessionEvent[], fallbackModel: string | null): AgentContextRow[] {
  const ids = agentsInOrder(events);
  if (ids.length === 0) return [rowFor(undefined, events, fallbackModel)];
  return ids.map((id) => rowFor(id, projectForAgent(events, id), fallbackModel));
}

/** 环画哪一只：窗口已知的里面已用占比最高的；并列取先露面的。
    一只都没有已知窗口 = null，整枚环不画（#193） */
export function bindingContextRow(rows: readonly AgentContextRow[]): AgentContextRow | null {
  let best: AgentContextRow | null = null;
  for (const r of rows) {
    if (r.percent === null) continue;
    if (best === null || r.percent > (best.percent as number)) best = r;
  }
  return best;
}

/** 浮层里逐只那一行的右半：`41% · 52.7K / 128K`。窗口未知时说出原因——
    「型号不在目录里」与「还没跑过」该做的事不一样（前者是目录欠一行，后者等它开口） */
export function contextRowSummary(row: AgentContextRow): string {
  if (row.window === null || row.percent === null) {
    return row.model === null ? "还没跑过" : `窗口未知（${row.model} 不在目录里）`;
  }
  return `${Math.min(100, Math.round(row.percent))}% · ${fmtCtx(row.breakdown.total)} / ${fmtCtx(row.window)}`;
}
