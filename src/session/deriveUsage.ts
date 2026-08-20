// deriveUsage — 从事件日志投影出「这个会话烧了多少 token、烧在哪些型号上」。
//
// 纯函数,同 deriveTodos 的路子:不存 UI state,重开 app / 换机器 / 重放同一段日志
// 得到同一份账。
//
// 谁携带一次模型调用的账:凡是"跑了一次模型"的事件都带 usage —— 正文
// (assistant_message)、压缩(context_compacted)、分区(section_classified)、
// 跟进建议(suggestions_generated)。后两个是"外挂"小调用,但它们照样烧钱:
// 漏掉哪一类,统计就从此少算一截(events.ts 里 SuggestionsGeneratedEvent
// 的注释写的就是这件事)。

import type { SessionEvent } from "./events.js";

/** 一款型号在本会话的累计用量 */
export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/** 会计上"算一次模型调用"的四类事件。导出是为了让主进程的 SQL 用同一份清单筛行
    （设置页的跨会话用量），而不是在 store.ts 里再抄一遍这四个字符串 */
export const BILLED_EVENT_TYPES = [
  "assistant_message",
  "context_compacted",
  "section_classified",
  "suggestions_generated",
] as const;

type BilledEvent = Extract<SessionEvent, { type: (typeof BILLED_EVENT_TYPES)[number] }>;

function isBilledEvent(e: SessionEvent): e is BilledEvent {
  return (BILLED_EVENT_TYPES as readonly string[]).includes(e.type);
}

/** 这条事件是不是一次模型调用的账。是就返回(型号, 用量),不是返回 null。
    usage 缺省的事件不算账:旧日志里有没记用量的调用,当 0 会让"没记"和"没花"
    看起来一样 —— 这里的做法是压根不出现在账里 */
function billed(e: SessionEvent): { model: string; promptTokens: number; completionTokens: number } | null {
  if (!isBilledEvent(e)) return null;
  if (!e.usage) return null;
  return {
    model: e.model,
    promptTokens: e.usage.promptTokens,
    completionTokens: e.usage.completionTokens,
  };
}

/** 按型号归并的用量,总量降序(最烧钱的那款在最上面)。
    同量时按型号名排,免得同一份日志两次渲染出不同顺序 */
export function usageByModel(events: SessionEvent[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const e of events) {
    const b = billed(e);
    if (!b) continue;
    const cur = byModel.get(b.model);
    if (cur) {
      cur.promptTokens += b.promptTokens;
      cur.completionTokens += b.completionTokens;
    } else {
      byModel.set(b.model, {
        model: b.model,
        promptTokens: b.promptTokens,
        completionTokens: b.completionTokens,
      });
    }
  }
  return [...byModel.values()].sort((a, b) => {
    const d = b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens);
    return d !== 0 ? d : a.model.localeCompare(b.model);
  });
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
