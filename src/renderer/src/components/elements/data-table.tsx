"use client";

import type { ComponentProps } from "react";
import { useMemo } from "react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";
import { isNumericColumn } from "@/lib/tableColumns.js";

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

/** 一列的排版。数字列:窄、右对齐、等宽;正文列:分摊剩余宽度、左对齐、**换行不截断** */
const colClass = (numeric: boolean, first: boolean) =>
  numeric
    ? "w-20 shrink-0 text-end"
    : cn("min-w-0 flex-1 break-words", first && "font-medium");

export function DataTable({
  columns,
  rows,
  leadingBadge = false,
  cycle,
  className,
  ...props
}: DataTableProps) {
  // 每列量一次:排版靠它,表头和数据行必须用同一份判断,否则列头会和列错位
  const numeric = useMemo(
    () => columns.map((_, i) => isNumericColumn(rows, i)),
    [columns, rows],
  );

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
      <div className="flex items-start gap-2.5 px-4 pt-3 pb-2">
        {leadingBadge && <span className="size-5 shrink-0" aria-hidden />}
        {columns.map((col, index) => (
          <span
            key={index}
            className={cn(mono, "text-foreground/35", colClass(numeric[index] === true, false))}
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
            className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both hover:bg-foreground/[0.03] flex items-start gap-2.5 px-4 py-2.5 transition-colors duration-300 motion-reduce:animate-none"
            style={{ animationDelay: `${rowIndex * 80}ms` }}
          >
            {leadingBadge && (
              <span className="bg-foreground/[0.06] text-foreground/45 flex size-5 shrink-0 items-center justify-center rounded-md text-[9px] font-medium">
                {row[0]?.[0] ?? ""}
              </span>
            )}
            {columns.map((_, colIndex) => {
              const num = numeric[colIndex] === true;
              return (
                <span
                  key={colIndex}
                  className={cn(
                    num ? cn(mono, "text-foreground/55 tabular-nums") : "text-foreground/90",
                    colClass(num, colIndex === 0),
                  )}
                >
                  {row[colIndex] ?? ""}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
