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

/** 这条事件是不是一次模型调用的账。是就返回(型号, 用量),不是返回 null。
    usage 缺省的事件不算账:旧日志里有没记用量的调用,当 0 会让"没记"和"没花"
    看起来一样 —— 这里的做法是压根不出现在账里 */
function billed(e: SessionEvent): { model: string; promptTokens: number; completionTokens: number } | null {
  if (
    e.type !== "assistant_message" &&
    e.type !== "context_compacted" &&
    e.type !== "section_classified" &&
    e.type !== "suggestions_generated"
  ) {
    return null;
  }
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

/** 最近一次模型调用的账。没有任何一次带用量的调用 = null */
export function lastCall(events: SessionEvent[]): ModelUsage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined) continue;
    const b = billed(e);
    if (b) return b;
  }
  return null;
}

/** 上下文增长曲线:每一次**正文**调用送进去的 prompt token 数,按时间顺序。
    为什么只取 assistant_message:压缩/分区/建议是外挂小调用,它们的 prompt
    是各自的小提示词,和"这段对话有多长"没关系 —— 混进来会把曲线锯成一排尖刺。

    promptTokens 就是那一刻上下文的真实大小(模型这一头数出来的),比投影层
    estimate 出来的更准;压缩发生时它会掉下来一截,那正是压缩这件事该有的样子。 */
export function contextSeries(events: SessionEvent[]): number[] {
  const out: number[] = [];
  for (const e of events) {
    if (e.type === "assistant_message" && e.usage) out.push(e.usage.promptTokens);
  }
  return out;
}
