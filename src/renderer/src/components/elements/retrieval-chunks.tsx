"use client";

import type { ComponentProps, ReactNode } from "react";
import { DatabaseIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, mono, paper, ShimmerLabel } from "@/lib/surfaces.js";
import { pct, take } from "@/lib/range.js";

export interface RetrievalChunk {
  id: string;
  source: string;
  locator: string;
  score: number;
  text: string;
}

export function RetrievalChunks({
  query,
  chunks,
  visibleCount,
  searching,
  statusLabel,
  searchingLabel,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "query" | "chunks" | "visibleCount" | "searching"
> & {
  query: string;
  chunks: readonly RetrievalChunk[];
  visibleCount: number;
  searching: boolean;
  /** 本仓改动:检索完那行字。原件写死 "{N} passages above threshold"
      (演示里数字是假的),真实条数/措辞得由调用方说,而且本仓是中文界面 */
  statusLabel?: ReactNode;
  /** 本仓改动:检索中那行字。理由同 statusLabel */
  searchingLabel?: ReactNode;
}) {
  return (
    <div
      data-slot="retrieval-chunks"
      className={cn("flex w-full max-w-sm flex-col gap-2.5", className)}

      {...props}
    >
      <span
        className={cn(
          field,
          "text-foreground/70 inline-flex w-fit items-center gap-1.5 rounded-full px-3.5 py-2 text-xs",
        )}
      >
        <DatabaseIcon className="text-foreground/40 size-3" />
        {query}
      </span>

      <div className="text-foreground/45 text-xs">
        {searching ? (
          <ShimmerLabel className="relative inline-block leading-none">
            {searchingLabel ?? "Retrieving"}
          </ShimmerLabel>
        ) : (
          // 本仓改动:原件的 animate-in/fade-in 是 tailwindcss-animate 的类名,本仓没装
          // 那个插件(见 memory-chips.tsx 同款注释),换成 Tailwind v4 原生 `starting:` 变体
          <span className="opacity-100 transition-opacity duration-200 ease-strong starting:opacity-0 motion-reduce:transition-none">
            {statusLabel ?? `${chunks.length} passages above threshold`}
          </span>
        )}
      </div>

      <div className="flex min-h-[7rem] flex-col gap-1.5">
        {take(chunks, visibleCount).map((chunk) => (
          <div
            key={chunk.id}
            className={cn(
              paper,
              // 本仓改动:同上,animate-in/slide-in-from-bottom-1/fill-mode-both 换成
              // starting: 写法 —— opacity + translateY(4px),200ms,ease-strong
              "flex flex-col gap-1.5 rounded-2xl px-3.5 py-2.5 transition-[opacity,transform] duration-200 ease-strong starting:opacity-0 starting:translate-y-1 motion-reduce:transition-none",
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-foreground/90 min-w-0 flex-1 truncate text-[13px] font-medium">
                {chunk.source}
              </span>
              <span className={cn(mono, "text-foreground/30 shrink-0")}>
                {chunk.locator}
              </span>
              <span
                className={cn(
                  mono,
                  "shrink-0 tabular-nums",
                  chunk.score >= 0.8
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-foreground/35",
                )}
              >
                {chunk.score.toFixed(2)}
              </span>
            </div>
            <p className="text-foreground/55 line-clamp-2 text-xs leading-relaxed">
              {chunk.text}
            </p>
            <span className="bg-foreground/[0.06] h-[2px] w-full overflow-hidden rounded-full">
              <span
                className="block h-full rounded-full bg-blue-500/70 transition-[width] duration-500 dark:bg-blue-400/70"
                style={{ width: `${pct(chunk.score, 1)}%` }}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
