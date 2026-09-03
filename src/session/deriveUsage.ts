// deriveUsage — 从事件日志投影出「这个会话烧了多少 token、烧在哪些型号上」。
//
// 纯函数,同 deriveTodos 的路子:不存 UI state,重开 app / 换机器 / 重放同一段日志
// 得到同一份账。
//
// 谁携带一次模型调用的账:凡是"跑了一次模型"的事件都带 usage —— 正文
// (assistant_message)、压缩(context_compacted)、分区(section_classified)、
// 跟进建议(suggestions_generated)、微压缩(micro_compacted,ADR-0064)。
// 后三个是"外挂"小调用,但它们照样烧钱:漏掉哪一类,统计就从此少算一截
// (events.ts 里 SuggestionsGeneratedEvent 的注释写的就是这件事)。
// 微压缩尤其不能漏:它每 turn 收口都烧一次,开着的话是这里最高频的一笔。

import type { SessionEvent } from "./events.js";

/** 一款型号在本会话的累计用量 */
export interface ModelUsage {
  model: string;
  /** 这笔账走的哪条路（ADR-0176 决定五）：hosted = 官方 key + 订阅额度（按 credit 记账，
      UI 不显示 $）,direct = 用户自己的 key（按 $ 记账）。同一款型号换过路要分两行——
      合成一行会把两种不同的计费口径混进同一个 $ 数字里，读者会当成一次双重扣费。
      非 assistant_message 的外挂小调用（压缩/分区/建议…）没有 route 字段,billed()
      里一律按 direct 记（这些账目前只走用户自己的 key） */
  route: "hosted" | "direct";
  promptTokens: number;
  completionTokens: number;
  /** promptTokens 里命中 prompt cache 的部分。不报 cache 的调用按 0 计——
      计费上"没报"只能当"没命中"（按全价），与 cacheStats 的口径刻意不同：
      那边是命中率度量,分母要剔掉不报数的调用;这边是钱,漏算命中只会报高不报错 */
  cachedTokens: number;
}

/** 会计上"算一次模型调用"的几类事件。导出是为了让主进程的 SQL 用同一份清单筛行
    （设置页的跨会话用量），而不是在 store.ts 里再抄一遍这几个字符串。
    session_autotitled 通常搭 section/suggestions 的合并调用（账只挂先落那条，
    billOnce），但解析只活下来标题那一边时账就挂在它身上——所以必须在清单里 */
export const BILLED_EVENT_TYPES = [
  "assistant_message",
  "context_compacted",
  "section_classified",
  "suggestions_generated",
  "micro_compacted",
  "session_autotitled",
] as const;

type BilledEvent = Extract<SessionEvent, { type: (typeof BILLED_EVENT_TYPES)[number] }>;

function isBilledEvent(e: SessionEvent): e is BilledEvent {
  return (BILLED_EVENT_TYPES as readonly string[]).includes(e.type);
}

/** 这条事件是不是一次模型调用的账。是就返回(型号, 用量),不是返回 null。
    usage 缺省的事件不算账:旧日志里有没记用量的调用,当 0 会让"没记"和"没花"
    看起来一样 —— 这里的做法是压根不出现在账里 */
function billed(
  e: SessionEvent
): { model: string; route: "hosted" | "direct"; promptTokens: number; completionTokens: number; cachedTokens: number } | null {
  if (!isBilledEvent(e)) return null;
  if (!e.usage) return null;
  return {
    model: e.model,
    // 只有 assistant_message 携带 route；外挂小调用（压缩/分区/建议…）没有这个字段，
    // 按 direct 记（ADR-0176 决定五：缺省 = direct，旧日志 / 子会话照常重放）
    route: e.type === "assistant_message" ? (e.route ?? "direct") : "direct",
    promptTokens: e.usage.promptTokens,
    completionTokens: e.usage.completionTokens,
    cachedTokens: e.usage.cachedTokens ?? 0,
  };
}

/** 按 (型号, route) 归并的用量,总量降序(最烧钱的那款在最上面)。
    同一款型号换过路要分两行 —— 合成一行会把两种不同的计费口径（credit / $）
    混进同一份汇总里。同量时按型号名排,再按 route 排,免得同一份日志两次
    渲染出不同顺序 */
export function usageByModel(events: SessionEvent[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const e of events) {
    const b = billed(e);
    if (!b) continue;
    const key = `${b.model}|${b.route}`;
    const cur = byModel.get(key);
    if (cur) {
      cur.promptTokens += b.promptTokens;
      cur.completionTokens += b.completionTokens;
      cur.cachedTokens += b.cachedTokens;
    } else {
      byModel.set(key, {
        model: b.model,
        route: b.route,
        promptTokens: b.promptTokens,
        completionTokens: b.completionTokens,
        cachedTokens: b.cachedTokens,
      });
    }
  }
  return [...byModel.values()].sort((a, b) => {
    const d = b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens);
    if (d !== 0) return d;
    const m = a.model.localeCompare(b.model);
    return m !== 0 ? m : a.route.localeCompare(b.route);
  });
}

/** prompt cache 命中账（issue #213 基线度量）。
    分母不是全会话 promptTokens,而是**报了 cachedTokens 的那些调用**的 promptTokens——
    把不报 cache 字段的调用算进分母,会把「API 不报」稀释成「命中率低」。 */
export interface CacheStats {
  /** 命中缓存的 prompt token 总数 */
  cachedTokens: number;
  /** 报了 cache 字段的那些调用的 prompt token 总数(命中率的分母) */
  measuredPromptTokens: number;
}

/** null = 整段日志没有一次调用报过 cache 字段(旧日志/端点不支持)。
    区别于 {0, n}:后者是"量了,一个没中"。 */
export function cacheStats(events: SessionEvent[]): CacheStats | null {
  let cachedTokens = 0;
  let measuredPromptTokens = 0;
  let measured = false;
  for (const e of events) {
    if (!isBilledEvent(e) || !e.usage || e.usage.cachedTokens === undefined) continue;
    measured = true;
    cachedTokens += e.usage.cachedTokens;
    measuredPromptTokens += e.usage.promptTokens;
  }
  return measured ? { cachedTokens, measuredPromptTokens } : null;
}

/** 会话累计 token(入 + 出)。UI 上那个"会话累计消耗"就是它 */
export function totalTokens(events: SessionEvent[]): number {
  let sum = 0;
  for (const e of events) {
    const b = billed(e);
    if (b) sum += b.promptTokens + b.completionTokens;
  }
  return sum;
}
