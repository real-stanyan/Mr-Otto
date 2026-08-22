"use client";

import type { ComponentProps } from "react";
import { BrainIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, ghostButton, mono } from "@/lib/surfaces.js";

export type MemoryChange = "added" | "updated" | "existing";

export interface MemoryChip {
  id: string;
  text: string;
  change: MemoryChange;
}

export function MemoryChips({
  chips,
  onForget,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "chips" | "onForget"> & {
  chips: readonly MemoryChip[];
  onForget?: (id: string) => void;
}) {
  const fresh = chips.filter((chip) => chip.change !== "existing").length;

  return (
    <div
      data-slot="memory-chips"
      className={cn("flex w-full max-w-sm flex-col gap-2", className)}
      {...props}
    >
      <div className="flex items-center gap-1.5">
        <BrainIcon className="text-foreground/30 size-3.5" />
        {/* 本仓改动:中文文案(原件是英文 "memory"/"remembered N")*/}
        <span className={cn(mono, "text-foreground/35")}>
          {fresh > 0 ? `记忆 · ${fresh}` : "记忆"}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.id}
            // 本仓改动:原件的 animate-in/zoom-in-95 是 tailwindcss-animate 的类名,
            // 本仓没装那个插件(app.css 顶部 dialog 那条注释同款理由),那两个类是死的。
            // 换成本仓通用的 @starting-style 写法(Tailwind v4 原生 `starting:` 变体):
            // opacity + translateY(4px) → 0,200ms,--ease-strong——和设计铁律的入场规格对齐
            className={cn(
              "transition-[opacity,transform] duration-200 ease-strong starting:opacity-0 starting:translate-y-1 motion-reduce:transition-none group flex items-center gap-1 rounded-full py-1 pr-1 pl-2.5 text-xs",
              chip.change === "existing"
                ? cn(field, "text-foreground/55")
                : "bg-blue-500/12 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
            )}
          >
            {chip.text}
            <button
              type="button"
              aria-label={`忘掉「${chip.text}」`}
              onClick={() => onForget?.(chip.id)}
              className={cn(ghostButton, "size-4")}
            >
              <XIcon className="size-2.5" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
