// 云会话输入框右下角那枚上下文用量环 + 它的浮层（#1138）。
//
// #985 把云会话输入框换成本地同款时，把它连同型号 / thinking 一起当成「团队的属性」
// 少掉了——那两样确实是（ADR-0202 / 0233），环不是：上下文是**每只 agent 各自的**
// 事实，日志里就推得出来。数据源与三条判据（视野按 agent 分 / 工具表从信封取 /
// 窗口查目录、不认识不画）都在 lib/cloudContext.ts；这里只管画。
//
// 与本地那枚（App.tsx 的 ComposerPrefsBar + CtxDetails）的两处不同：
//
// ① **额度那半按 owner 画**：告警点（ContextRingTrigger 右上角）与套餐额度两只表
//    读的都是 store.billing——**我的**订阅；而云会话烧的是 owner 的额度（ADR-0233）。
//    我不是 owner 时它们报的是一个与这条会话无关的账号，整段不画。owner 那一位
//    是 cs.ownerUid === selfUid 这个稳定键，不从「谁建的会话」推。
// ② **钱那段永远不画**：云会话没有 direct 这一档（ADR-0233），showsCost 那道分叉
//    在这里只可能说假话（旧 runtime 落的 context_compacted 缺 route 时会被判成
//    direct，#1091 那一族）；脚注「调了哪几款 · 多少 token」照画，按整条会话算，
//    不按最吃紧那只的视野——它答的是「这条会话调过谁」，不是「这只 agent 看见了谁」。
//
// 群里几只 agent 各有各的上下文：环画**最吃紧**那只，浮层里逐只列一行、段头写清
// 画的是谁的。一只都不画（窗口都不在目录里）时整枚环不出现——按假分母报百分比
// 比不报更糟（#193，同本地那枚 ctxWindow === null 的处置）。

import { useMemo } from "react";
import type { SessionEvent } from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { cacheStats, usageByModel } from "../../../session/deriveUsage.js";
import { ContextDisplayRoot, usageSeverity, type UsageSeverity } from "./assistant-ui/context-display.js";
import { ContextRingTrigger } from "./ContextRingTrigger.js";
import { CTX_ROW, CTX_VALUE, CtxBreakdownSection, CtxCard } from "./CtxBreakdownSection.js";
import { PlanQuotaSection } from "./PlanQuotaSection.js";
import { ModelFootnote } from "./ModelFootnote.js";
import { agentNameOf } from "../lib/workspaceView.js";
import {
  bindingContextRow,
  cloudContextRows,
  contextRowSummary,
  type AgentContextRow,
} from "../lib/cloudContext.js";
import { cn } from "@/lib/utils.js";

/** 颜色只用来说「出事了」：充足时那一行与别的行一个色（同 PlanQuotaSection 的两只表） */
const SEVERITY_TEXT: Record<UsageSeverity, string> = { normal: "", warning: "text-warn", critical: "text-deny" };

export function CloudContextRing({
  events,
  ws,
  fallbackModel,
  quotaApplies,
}: {
  events: SessionEvent[];
  ws: WorkspaceSnapshot;
  /** welcome 带回的团队默认型号（cs.modelRoute 为 hosted 时）；探不到 / blocked = null。
      只给还没跑过一轮的 agent 兜底，跑过的一律按它自己最后一次真跑的型号 */
  fallbackModel: string | null;
  /** 这条会话烧的是不是**我的**额度 = 我是不是 owner */
  quotaApplies: boolean;
}) {
  // memo 在 [events, fallbackModel] 上：每只 agent 一次全量投影 + 多次线性扫描，
  // 不 memo 的话每个流式碎片（cloudStreaming 那一格变化）都要把整份日志重算一遍
  const rows = useMemo(() => cloudContextRows(events, fallbackModel), [events, fallbackModel]);
  const binding = useMemo(() => bindingContextRow(rows), [rows]);
  if (binding === null || binding.window === null) return null;

  return (
    <ContextDisplayRoot modelContextWindow={binding.window} usage={{ totalTokens: binding.breakdown.total }}>
      <ContextRingTrigger quotaApplies={quotaApplies} />
      <CloudCtxDetails rows={rows} binding={binding} ctxWindow={binding.window} ws={ws} events={events} quotaApplies={quotaApplies} />
    </ContextDisplayRoot>
  );
}

function nameOf(ws: WorkspaceSnapshot, row: AgentContextRow): string {
  // agentId 缺席 = 单 agent 的旧云会话，同 cloudTimeline.assistantLabel 的兜底
  return row.agentId === undefined ? "Agent" : agentNameOf(ws, row.agentId);
}

function CloudCtxDetails({
  rows,
  binding,
  ctxWindow,
  ws,
  events,
  quotaApplies,
}: {
  rows: AgentContextRow[];
  binding: AgentContextRow;
  ctxWindow: number;
  ws: WorkspaceSnapshot;
  events: SessionEvent[];
  quotaApplies: boolean;
}) {
  const usage = useMemo(() => usageByModel(events), [events]);
  const cache = useMemo(() => cacheStats(events), [events]);
  const several = rows.length > 1;

  return (
    <CtxCard>
      {/* 账号那半在**上**（同本地那张卡）：额度是会真正把人拦住的那一个，而上下文
          满了还能压缩。只有 owner 看得到——那是他的额度在被这个群烧 */}
      {quotaApplies && <PlanQuotaSection />}

      {/* 群里不止一只时逐只列：环只答得出「最吃紧的那只到哪了」，这里答「其余的呢」。
          最吃紧那只用前景色，其余压弱——与下面那一段的段头呼应，人一眼对得上环画的是谁 */}
      {several && (
        <div className="mb-[8px] pb-[7px] border-b border-border" data-testid="agent-context-rows">
          <div className="text-[11px] text-muted-foreground mb-[2px]">各智能体的上下文 · 环画最吃紧那只</div>
          {rows.map((r) => (
            <div key={r.agentId ?? ""} className={CTX_ROW} data-testid="agent-context-row">
              <span className={cn("truncate", r === binding && "text-foreground")}>{nameOf(ws, r)}</span>
              <span
                className={cn(
                  CTX_VALUE,
                  "text-[11px]",
                  r.percent === null ? "text-muted-foreground" : SEVERITY_TEXT[usageSeverity(r.percent)],
                )}
              >
                {contextRowSummary(r)}
              </span>
            </div>
          ))}
        </div>
      )}

      <CtxBreakdownSection
        breakdown={binding.breakdown}
        ctxWindow={ctxWindow}
        label={several ? `「${nameOf(ws, binding)}」的上下文` : "会话上下文"}
      />

      {/* 钱那段不画（头注 ②）；脚注按整条会话算 */}
      <ModelFootnote rows={usage} cache={cache} />
    </CtxCard>
  );
}
