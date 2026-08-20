"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils.js";
import { field, mono } from "@/lib/surfaces.js";
import { pct } from "@/lib/range.js";

const fmt = (n: number) => n.toLocaleString("en-US");

export interface EffortLevel {
  key: string;
  label: string;
  /** 本仓改动:预算可省。本仓的挡位只有"档"没有 token 预算
      (shared/thinking.ts 是 off/low/medium/high 几个字,不带数);
      一档都没有预算时,头行那个 x / y 和底下那条进度条整个不画 —— 
      画一条永远是 0% 的条,等于在报一个假数 */
  budget?: number;
}

export function ReasoningEffort({
  levels,
  selectedKey,
  spent,
  onSelect,
  label,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "levels" | "selectedKey" | "spent" | "onSelect"
> & {
  levels: readonly EffortLevel[];
  selectedKey: string;
  /** 本仓改动:花掉多少也可省(同 budget —— 没有预算这个概念,就没有"花掉多少") */
  spent?: number;
  onSelect?: (key: string) => void;
  /** 本仓改动:标题可换。原件写死 "Thinking",本仓是中文界面 */
  label?: ReactNode;
}) {
  const selected = levels.find((level) => level.key === selectedKey);
  const budget = selected?.budget;
  // 有预算才有"用了多少"这回事
  const metered = budget !== undefined && spent !== undefined;
  const used = metered ? pct(spent, budget) : 0;

  return (
    <div
      data-slot="reasoning-effort"
      className={cn("flex w-full max-w-sm flex-col gap-2.5", className)}

      {...props}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[13.5px] font-medium">{label ?? "Thinking"}</span>
        {metered && (
          <span className={cn(mono, "text-foreground/35 tabular-nums")}>
            {fmt(spent)} / {fmt(budget)}
          </span>
        )}
      </div>

      <div className={cn(field, "flex gap-0.5 rounded-full p-0.5")}>
        {levels.map((level) => {
          const active = level.key === selectedKey;
          return (
            <button
              key={level.key}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect?.(level.key)}
              className={cn(
                "flex-1 rounded-full py-1 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.97]",
                active
                  ? "bg-background text-foreground/90"
                  : "text-foreground/45 hover:text-foreground/70",
              )}
            >
              {level.label}
            </button>
          );
        })}
      </div>

      {metered && (
        <span className="bg-foreground/[0.06] h-[3px] w-full overflow-hidden rounded-full">
          <span
            className="block h-full rounded-full bg-blue-500 transition-[width] duration-500 motion-reduce:transition-none dark:bg-blue-400"
            style={{ width: `${used}%` }}
          />
        </span>
      )}
    </div>
  );
}
