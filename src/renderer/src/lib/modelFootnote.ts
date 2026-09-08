// 上下文浮层末尾那一行：这个会话调了哪几款型号、一共多少 token、缓存命中多少。
//
// 它是**订阅用户那条路上**替掉整段花费的那一行（钱整段删掉之后，「用了哪款」
// 这个事实没有别的出口）。自带 key 的用户仍然看按型号拆开的价目表（CostPanel），
// 那时这一行不画 —— 同一批型号名列两遍只会让人以为是两回事。
//
// 纯逻辑单独放：这一行的全部难点是**300px 里放不下两个完整标签**，而那是一条
// 算得出来的规则，不该埋在 JSX 里。

import { fmtCtx } from "./fmtTokens.js";
import type { ModelUsage } from "../../../session/deriveUsage.js";

/** 左边最多画几枚标。三枚 13px 的标 + 「3 款型号」四个字，是 300px 里
    还能给右边那串留出位置的上限 */
export const MAX_MARKS = 3;

export interface ModelFootnoteView {
  /** 画标用的型号 id（按 rows 顺序，最多 MAX_MARKS 枚） */
  marks: string[];
  /** 左边那句：一款就是它的名字，多款是「N 款型号」 */
  label: string;
  /** 右边那串定长事实 */
  stat: string;
  /** 悬停时给出的完整那份（型号全名 + 带单位的数） */
  title: string;
}

/** 缓存统计的形状（`deriveUsage.cacheStats` 的返回值，只取这一行要用的两个数）。
    `null` = 一次调用都没报过 cache 字段 —— 那时整个 cache 那半句不出现：
    一行永远 0% 的指标读起来是「缓存全废」，而事实只是这家 API 不报数 */
export interface FootnoteCache {
  cachedTokens: number;
  measuredPromptTokens: number;
}

export function modelFootnoteView(rows: ModelUsage[], cache: FootnoteCache | null): ModelFootnoteView | null {
  if (rows.length === 0) return null; // 一次模型都没调过就不占地方

  const tokens = rows.reduce((sum, r) => sum + r.promptTokens + r.completionTokens, 0);
  const hit =
    cache !== null && cache.measuredPromptTokens > 0
      ? Math.round((cache.cachedTokens / cache.measuredPromptTokens) * 100)
      : null;

  // 「tokens」这个词在正文里省掉：实测最长的型号名（kimi-k2-turbo-preview）
  // 配上完整右串要 304px，而卡内可用宽度只有 274px —— 省一个单位词比截掉型号名
  // 便宜，何况这张卡上别的数（图例、剩余）本来也是裸数，读法一致。
  // 完整那份进 title：对账的人还得看得到单位
  const stat = `${fmtCtx(tokens)}${hit !== null ? ` · cache ${hit}%` : ""}`;
  const title = `${rows.map((r) => r.model).join("、")} · ${fmtCtx(tokens)} tokens${
    hit !== null ? `，cache 命中 ${hit}%` : ""
  }`;

  return {
    marks: rows.slice(0, MAX_MARKS).map((r) => r.model),
    label: rows.length === 1 ? rows[0]!.model : `${rows.length} 款型号`,
    stat,
    title,
  };
}
