"use client";

// 会话热力图的画法。**本仓改动一览**（#1022，原来这里带着自己的卡壳与标题行）：
//   · 只画图，不画卡：外面那张卡现在装着两半（左热力图 / 右本周用量），
//     卡壳、标题、脚注都归调用方 —— 元件自己再套一层 paper 就成了卡中卡
//   · 补月份刻度（上游有 MonthLabels，之前没接）：26 列没有刻度时
//     「那一簇蓝的是几月」答不出来
//   · 星期名走中文（上游的 DAY_SHORT 是 Tue/Thu/Sat）
//   · 格子 9px → 12px：卡变宽之后 9px 的图小得像个装饰
//
// 月份刻度和格子共用同一份 `grid-template-columns`，刻度按 column 定位：
// 两套算法各画各的必然错位，而错位在窄窗口下才显形。

import type { ComponentProps } from "react";
import * as HeatGraph from "heat-graph";
import { cn } from "@/lib/utils.js";
import { mono } from "@/lib/surfaces.js";

const LEVEL_TINT = [
  "bg-foreground/[0.06]",
  "bg-blue-500/25 dark:bg-blue-400/25",
  "bg-blue-500/45 dark:bg-blue-400/45",
  "bg-blue-500/70 dark:bg-blue-400/70",
  "bg-blue-500 dark:bg-blue-400",
] as const;

/** 格子边长与间距。刻度行要用同一对数，所以写成常量而不是散在类名里 */
const CELL = 12;
const GAP = 3;
/** 星期列的宽度。刻度行的左留白 = 它 + 一个 gap —— 靠字宽碰运气的话，
    换一种字（英文→中文）刻度就整体偏出去 */
const DAY_COL = 14;

const DAY_CN = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function ActivityGraph({
  data,
  start,
  end,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "data" | "start" | "end"> & {
  data: readonly HeatGraph.DataPoint[];
  start: string | Date;
  end: string | Date;
}) {
  return (
    <div data-slot="activity-graph" className={cn("flex flex-col gap-[7px]", className)} {...props}>
      <HeatGraph.Root
        data={[...data]}
        start={start}
        end={end}
        weekStart="monday"
        className="flex flex-col gap-[7px]"
      >
        {/* 月份刻度：一列 = 一周，按 column 落格，与下面的格子同一套列宽 */}
        <div
          className="grid h-[11px]"
          style={{ marginLeft: DAY_COL + GAP * 2, gap: `${GAP}px`, gridAutoColumns: `${CELL}px`, gridAutoFlow: "column" }}
        >
          <HeatGraph.MonthLabels>
            {({ label }) => (
              <span
                className={cn(mono, "whitespace-nowrap leading-none text-foreground/30")}
                // 跨 3 列 = 与「至少隔 3 列才标一次」同一个数：跨度大于间距时
                // 撞上的那个会被 grid 挤到第二行，而这一行是定高的 —— 第二行会
                // 整个溢出压在格子上（真机上「3月」比后面几个高一截就是这个）
                style={{ gridColumn: `${label.column + 1} / span 3`, gridRow: 1 }}
              >
                {label.month + 1}月
              </span>
            )}
          </HeatGraph.MonthLabels>
        </div>

        <div className="flex gap-[6px]">
          <div
            className="grid shrink-0"
            style={{ width: DAY_COL, gap: `${GAP}px`, gridAutoRows: `${CELL}px` }}
          >
            <HeatGraph.DayLabels>
              {({ label }) => (
                <span
                  className={cn(mono, "flex items-center leading-none text-foreground/30")}
                  style={{ height: CELL }}
                >
                  {label.row % 2 === 1 ? DAY_CN[label.dayOfWeek] : ""}
                </span>
              )}
            </HeatGraph.DayLabels>
          </div>

          {/* `w-fit` 是这张图不被拉伸的全部原因：上游 Grid 写死
              `grid-template-columns: repeat(totalWeeks, 1fr)`，在一个占满宽度的容器里
              1fr 会把格子摊成长方块；收成 fit-content 之后 1fr 落回格子自己的 12px。
              每个格子还按 cell.column/row **显式落位**，不赖 DOM 顺序 —— 上游哪天改了
              cells 的排列顺序，隐式流会把整张图转置，而且不会报任何错 */}
          <HeatGraph.Grid className="grid w-fit" style={{ gap: `${GAP}px` }}>
            {({ cell }) => (
              <HeatGraph.Cell
                className={cn("rounded-[3px]", LEVEL_TINT[cell.level] ?? LEVEL_TINT[0])}
                style={{ width: CELL, height: CELL, gridColumn: cell.column + 1, gridRow: cell.row + 1 }}
              />
            )}
          </HeatGraph.Grid>
        </div>
      </HeatGraph.Root>
    </div>
  );
}

/** 深浅图例。和图分开导出：新版把它摆在卡的脚注行里，和口径说明同一行 */
export function ActivityLegend({ className }: { className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-[4px]", className)}>
      <span className={cn(mono, "text-foreground/30")}>少</span>
      {LEVEL_TINT.map((tint, level) => (
        <span key={level} aria-hidden className={cn("size-[9px] rounded-[2px]", tint)} />
      ))}
      <span className={cn(mono, "text-foreground/30")}>多</span>
    </span>
  );
}
