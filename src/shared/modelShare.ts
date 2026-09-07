// modelShare —— 「这段时间里 token 烧在哪几款模型上」的纯投影（#1022）。
//
// 和邻居的分工：`usageStats.ts` 按**厂商**、按天投影（模型配置页那几张柱状图），
// `session/deriveUsage.ts` 按**一个会话**投影（浮层里的花费面板），这边按
// **整个日志库、按型号、只报占比**（账号页那半张卡）。
//
// 三条判据都是为了绕开审计在 usageStats 那条路上查出来的坑：
//
// ① **按型号 id 归并，不按厂商**。usageStats 里 `describeModel` 认不出的型号
//    整行 `continue` —— 那条规则在按厂商归并时是对的（硬塞进某一家会让那家的
//    数字凭空变大），但代价是本机真实存在的调用**静默消失**，界面上没有任何地方
//    说这件事。按型号归并就没有归属问题：认得出用显示名，认不出用裸 id，一行都不丢。
//
// ② **只报占比，不报 token 数也不报钱**。钱那一列本来要同时处理 `$`（自带 key）、
//    `credit`（托管）、`—`（查不到价）、`托管`（没记到）四种写法，而占比只有一种；
//    这也顺带绕开了 modelPricing 里缺键的型号（本机 `k3` 就查不到价）。
//    代价写在界面上那行脚注里：**占比按 token 算不是按钱算** —— 一款便宜模型的
//    token 和一款贵的一样大。
//
// ③ **口径与热力图不同，说出口不硬对齐**。这里算所有计费行（含子会话派出去的调用、
//    含已归档会话），而热力图刻意只数「你自己开的主会话」。两个数摆同一张卡上必然
//    被读成该对得上，所以两半各自带一行说明自己的口径。
//
// tokens = prompt + completion，**不加 cached**：后者是前者的子集
// （llmGateway 计价用 `Math.min(cached, prompt)`），加上就是重复计数。

import { describeModel } from "./modelCatalog.js";
import type { ProviderId } from "./providerCatalog.js";
import type { BilledRow } from "./usageStats.js";

/** 一款型号在窗口里的占比 */
export interface ModelShareRow {
  /** 目录主键 / 日志里那个 id。认不出的型号这就是它唯一的名字 */
  model: string;
  /** 显示名。目录认得就用它的短名，认不出就用裸 id —— 不丢行 */
  label: string;
  /** 画 logo 用。认不出的型号是 null：**硬塞进某一家比不画更坏** */
  provider: ProviderId | null;
  /** prompt + completion（不含 cached，它是 prompt 的子集） */
  tokens: number;
  /** 占窗口内总量的百分比，一位小数。总量为 0 时是 0 */
  share: number;
}

export interface ModelShareWindow {
  since: number;
  until: number;
  totalTokens: number;
  /** 按 tokens 降序的前 N 款 */
  rows: ModelShareRow[];
  /** 没进前 N 的那些：**合成一行说出来，不静默截断** */
  rest: { models: number; tokens: number; share: number };
}

/** 默认列几行。第 6 行起并进「其余 N 款」—— 再多就把这半张卡撑得比热力图高一截 */
export const MODEL_SHARE_TOP = 5;

const pct = (part: number, total: number): number =>
  total <= 0 ? 0 : Math.round((part / total) * 1000) / 10;

/**
 * @param rows  计费行（至少覆盖 [since, until] 这个窗口；窗口外的行这里再滤一遍）
 * @param since 窗口起点（含）
 * @param until 窗口终点（含）——显式传入，函数才是纯的
 */
export function modelShares(
  rows: readonly BilledRow[],
  { since, until, top = MODEL_SHARE_TOP }: { since: number; until: number; top?: number },
): ModelShareWindow {
  const byModel = new Map<string, number>();
  for (const r of rows) {
    if (r.ts < since || r.ts > until) continue;
    byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.promptTokens + r.completionTokens);
  }

  const all: ModelShareRow[] = [...byModel.entries()]
    .map(([model, tokens]) => {
      const choice = describeModel(model);
      return { model, label: choice?.label ?? model, provider: choice?.provider ?? null, tokens, share: 0 };
    })
    // 同量时按型号名排，再按 id 排：同一份日志两次投影不能给出不同顺序
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label) || a.model.localeCompare(b.model));

  const totalTokens = all.reduce((sum, r) => sum + r.tokens, 0);
  const shown = all.slice(0, Math.max(0, top)).map((r) => ({ ...r, share: pct(r.tokens, totalTokens) }));
  const restRows = all.slice(shown.length);
  const restTokens = restRows.reduce((sum, r) => sum + r.tokens, 0);

  return {
    since,
    until,
    totalTokens,
    rows: shown,
    rest: { models: restRows.length, tokens: restTokens, share: pct(restTokens, totalTokens) },
  };
}
