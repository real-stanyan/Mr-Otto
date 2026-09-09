// 上下文浮层里「会话上下文」那一段：hero 数 + 分段占用条 + 图例，回答「这份上下文
// 由什么构成、还剩多少」。全部数字都是投影（contextBreakdown），没有独立状态。
//
// 从 App.tsx 的 CtxDetails 里抽出来（#1138）：云会话输入框也要那枚环，它的浮层要回答
// 的是同一个问题——两处各画一遍，段宽的算法、图例的排序、零值行的处置迟早分家。
// 壳（CtxCard）也在这里，让两张卡同一个尺寸同一张纸；上下两段（套餐额度 / 钱或脚注）
// 仍归各自的调用方：本地那张卡与云会话那张卡差的正是那两段。

import { useMemo, type ReactNode } from "react";
import { TooltipContent } from "@/components/ui/tooltip.js";
import { NumberTicker } from "@/components/elements/number-ticker.js";
import { cn } from "@/lib/utils.js";
import { fmtCtx } from "../lib/fmtTokens.js";
import type { ContextBreakdown } from "../../../shared/contextEstimate.js";

/** 浮层里的一行：左标签右数值（同 App.tsx 的 POP_ROW，那一份还有别的消费方） */
export const CTX_ROW = "flex justify-between items-baseline gap-3 text-muted-foreground py-[2px]";
/** 数值那一格（同 App.tsx 的 V） */
export const CTX_VALUE = "font-mono tabular-nums text-foreground whitespace-nowrap";

/** 四类占用的配色 —— 条形段与图例色块共用一处，两边永远同色。
    对话消息用品牌色（和圆环同源，"主角"一眼认出）；工具用紫，项目指令用青，
    系统提示词用灰。前三段是**每轮都要重付**的固定开销，排在一起，
    条形上看到的第一截就是"这个会话的底噪有多厚"（issue #524） */
const CTX_CATEGORIES = [
  { key: "system" as const, label: "系统提示词", color: "color-mix(in srgb, var(--foreground) 45%, transparent)" },
  { key: "tools" as const, label: "工具", color: "#8b7fe0" },
  { key: "instructions" as const, label: "项目指令", color: "#5fa8b8" },
  { key: "messages" as const, label: "对话消息", color: "var(--brand)" },
];

/** 用量环详情浮层的壳。版式照旧：卡片底色/圆角/阴影都沿用原来的浮窗，只是开合改由
    Tooltip 管。不要箭头:这是一张信息卡,不是一句提示气泡(原先那句 [&>svg]:hidden
    从来没生效,见 ui/tooltip.tsx 里 arrow 这个 prop 的注释) */
export function CtxCard({ children }: { children: ReactNode }) {
  return (
    <TooltipContent
      side="top"
      align="end"
      sideOffset={8}
      arrow={false}
      className="w-[300px] px-3 py-[10px] bg-card border border-border text-foreground text-xs cursor-default"
      aria-label="上下文用量详情"
    >
      {children}
    </TooltipContent>
  );
}

export function CtxBreakdownSection({
  breakdown,
  ctxWindow,
  label = "会话上下文",
}: {
  breakdown: ContextBreakdown;
  ctxWindow: number;
  /** 段头左边那句。本地会话是「会话上下文」；云会话群里几只 agent 各有各的，
      画的是最吃紧那只，段头得说清是谁的 */
  label?: string;
}) {
  const pct = Math.min(100, Math.round((breakdown.total / ctxWindow) * 100));
  /** 条尾那截空白第一次有了名字。原来它只是"没被填满的部分"，而这张卡两半
      现在都在答同一个问题（还剩多少），说出来才对得上 */
  const rest = Math.max(0, ctxWindow - breakdown.total);
  /** 图例按大小降序：行序本身就是"谁吃掉了它"的答案。条形段仍按 CTX_CATEGORIES
      的固定顺序（前三段是每轮重付的固定开销，排在一起才看得出底噪有多厚） */
  const legend = useMemo(
    () => [...CTX_CATEGORIES].sort((a, b) => breakdown[b.key] - breakdown[a.key]),
    [breakdown],
  );
  /** 段宽按窗口占比（不是按三者互相占比）——条尾的空白就是"还剩多少"。
      非零的段至少 1.5px：1.5K 的系统提示词在 1M 窗口里不该被抹成不存在 */
  const width = (v: number) => (v > 0 ? `max(1.5px, ${(v / ctxWindow) * 100}%)` : "0px");

  return (
    <>
      {/* 段头把两半摆成平级的两件事（账号的 / 这个会话的），
          右上角那个数是条尾空白的名字 */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">剩 {fmtCtx(rest)}</span>
      </div>

      {/* 标题位是会滚的数(number-ticker):这张卡的主语就是"现在有多少 token
          在上下文里",而它在一个 turn 里是**活的** —— 每翻一位就是刚发生的事。
          单位跟卡上别的数一致走 K（`865,481` 与 `52.7K` 是两套读法,#1071）;
          说明挪到右边同一条基线上,原来它在数字底下、把这张卡撑高一行 */}
      <div className="flex items-baseline justify-between gap-3 mb-[7px]">
        <NumberTicker
          value={breakdown.total}
          format={fmtCtx}
          valueClassName="text-[22px]"
          className="items-start"
        />
        <span className="font-mono text-[11px] tabular-nums whitespace-nowrap text-muted-foreground">
          已用 {pct}% · 窗口 {fmtCtx(ctxWindow)}
        </span>
      </div>

      {/* 分段占用条：段宽 = 该类占窗口的比例，尾部留白 = 还没被吃掉的部分 */}
      <div
        className="flex h-[6px] rounded-full overflow-hidden bg-foreground/10 gap-[1px]"
        role="img"
        aria-label={`上下文占用 ${pct}%：系统提示词 ${breakdown.system}、工具 ${breakdown.tools}、项目指令 ${breakdown.instructions}、对话消息 ${breakdown.messages} tokens`}
      >
        {CTX_CATEGORIES.map((c) => (
          <i
            key={c.key}
            className="block h-full transition-[width] duration-[400ms] ease-strong"
            style={{ width: width(breakdown[c.key]), background: c.color }}
          />
        ))}
      </div>

      {/* 图例两列:额度那半上了两只 62px 的表,四行一列会把这张卡拉太长。
          零值行留着但压成弱色 —— 删掉会让卡片在类别出现/消失时抖动,
          而"这个类别存在且是空的"本身是信息 */}
      <div className="mt-[8px] grid grid-cols-2 gap-x-3">
        {legend.map((c) => (
          <div key={c.key} className={CTX_ROW}>
            <span className="flex items-center gap-[6px] min-w-0">
              <i
                className="w-[7px] h-[7px] rounded-[2px] shrink-0"
                style={{ background: c.color }}
                aria-hidden="true"
              />
              <span className="truncate">{c.label}</span>
            </span>
            {/* 单位不再逐行写:两列排下来"tokens"要出现四次,而这张卡上的数
                现在是同一把尺子(hero / 剩余 / 脚注都走 fmtCtx) */}
            <span className={cn(CTX_VALUE, "text-[11px]", breakdown[c.key] === 0 && "text-muted-foreground")}>
              {fmtCtx(breakdown[c.key])}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
