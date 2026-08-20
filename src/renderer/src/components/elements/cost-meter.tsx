"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";
import { pct } from "@/lib/range.js";

export interface CostLine {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: string;
  share: number;
}

export function CostMeter({
  runCost,
  sessionCost,
  lines,
  runLabel,
  sessionLabel,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "runCost" | "sessionCost" | "lines"
> & {
  /** 本仓改动:可省。原件的头行是「最近一次多少钱 + 本会话多少钱」两个数,
      而本仓这张卡挂在上下文浮层里,"最近一次"多半是 $0(免费的本地/免费型号)——
      一个每次都写着 $0 的大号数字占着头行,读者读到的是噪音。省掉时把会话总额
      提到大号位:那一行不能空着,也不该为了填满而报一个没人问的数 */
  runCost?: string;
  sessionCost: string;
  lines: readonly CostLine[];
  /** 本仓改动:两行标签可换。原件写死 "this run"/"session",本仓是中文界面 */
  runLabel?: ReactNode;
  sessionLabel?: ReactNode;
}) {
  return (
    <div
      data-slot="cost-meter"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-4",
        className,
      )}

      {...props}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-medium tracking-tight tabular-nums">
          {runCost ?? sessionCost}
        </span>
        {runCost === undefined ? (
          <span className={cn(mono, "text-foreground/30")}>
            {sessionLabel ?? "session"}
          </span>
        ) : (
          <>
            <span className={cn(mono, "text-foreground/30")}>
              {runLabel ?? "this run"}
            </span>
            <span className={cn(mono, "text-foreground/35 ms-auto tabular-nums")}>
              {sessionCost} {sessionLabel ?? "session"}
            </span>
          </>
        )}
      </div>

      <div className="bg-foreground/[0.06] flex h-1.5 w-full overflow-hidden rounded-full">
        {lines.map((line, i) => (
          <span
            key={line.model}
            className={cn(
              "h-full transition-[width] duration-500 motion-reduce:transition-none",
              i === 0
                ? "bg-blue-500 dark:bg-blue-400"
                : i === 1
                  ? "bg-blue-500/55 dark:bg-blue-400/55"
                  : "bg-foreground/25",
            )}
            style={{ width: `${pct(line.share, 1)}%` }}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        {lines.map((line) => (
          <div key={line.model} className="flex items-baseline gap-2">
            <span className="text-foreground/75 min-w-0 flex-1 truncate text-[13px]">
              {line.model}
            </span>
            <span
              className={cn(mono, "text-foreground/25 shrink-0 tabular-nums")}
            >
              {(line.inputTokens / 1000).toFixed(1)}k in ·{" "}
              {(line.outputTokens / 1000).toFixed(1)}k out
            </span>
            <span
              className={cn(mono, "text-foreground/55 shrink-0 tabular-nums")}
            >
              {line.cost}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
