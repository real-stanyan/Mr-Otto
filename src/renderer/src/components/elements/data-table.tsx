"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";

/** 本仓改动:原件是写死的三列（Model / Context / Cost）+ 写死的行结构
    { name, context, cost }，因为它在画廊里演示的就是"模型用量表"那一张。
    本仓拿它接的是**模型正文里的 markdown 表格**——列数、列名都是当场才知道的，
    所以列头和行都改成传进来。行仍是字符串矩阵:调用方（markdown-text 的 table
    渲染器）只在整张表都是纯文本时才走这条路，带链接/代码的单元格退回原生 <table>。 */
export interface DataTableProps
  extends Omit<ComponentProps<"div">, "children" | "rows"> {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  /** 首列前面那枚首字母徽章。原件常开（模型名有 logo 的位置感），
      但一张普通表格的首列可能是日期、序号，加个徽章只是噪音 —— 默认关 */
  leadingBadge?: boolean;
  /** 换一批数据时重放入场动画。原件叫 cycle，本仓 markdown 表格是一次性的，可省 */
  cycle?: number;
}

/** 首列吃剩余宽度、其余各列右对齐:表格里除了第一列（名字/项目）之外，
    绝大多数是数字或短标签，右对齐才对得上位。等宽字体也只给这些列 */
const cellClass = (index: number) =>
  index === 0
    ? "text-foreground/90 flex-1 min-w-0 truncate"
    : cn(mono, "text-foreground/55 w-20 shrink-0 truncate text-end tabular-nums");

export function DataTable({
  columns,
  rows,
  leadingBadge = false,
  cycle,
  className,
  ...props
}: DataTableProps) {
  return (
    <div
      data-slot="data-table"
      className={cn(
        paper,
        "w-full overflow-hidden rounded-2xl text-[13px]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
        {leadingBadge && <span className="size-5 shrink-0" aria-hidden />}
        {columns.map((col, index) => (
          <span
            key={index}
            className={cn(
              mono,
              "text-foreground/35 truncate",
              index === 0 ? "flex-1 min-w-0" : "w-20 shrink-0 text-end",
            )}
          >
            {col}
          </span>
        ))}
      </div>
      <div className="bg-foreground/[0.06] mx-4 h-px" />
      <div key={cycle}>
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both hover:bg-foreground/[0.03] flex items-center gap-2.5 px-4 py-2.5 transition-colors duration-300 motion-reduce:animate-none"
            style={{ animationDelay: `${rowIndex * 80}ms` }}
          >
            {leadingBadge && (
              <span className="bg-foreground/[0.06] text-foreground/45 flex size-5 shrink-0 items-center justify-center rounded-md text-[9px] font-medium">
                {row[0]?.[0] ?? ""}
              </span>
            )}
            {columns.map((_, colIndex) => (
              <span key={colIndex} className={cellClass(colIndex)}>
                {row[colIndex] ?? ""}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
