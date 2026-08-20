"use client";

import type { ComponentProps } from "react";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { ghostButton, mono, paper } from "@/lib/surfaces.js";
import { clamp, pct, progressOf, take } from "@/lib/range.js";

export interface JobStage {
  name: string;
  weight: number;
}

export function JobProgress({
  title,
  stages,
  stageIndex,
  stageProgress,
  eta,
  onCancel,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "title"
  | "stages"
  | "stageIndex"
  | "stageProgress"
  | "eta"
  | "onCancel"
> & {
  title: string;
  stages: readonly JobStage[];
  stageIndex: number;
  stageProgress: number;
  eta: string;
  onCancel?: () => void;
}) {
  const stage = progressOf(stageIndex, stages.length);
  const progress = clamp(stageProgress, 0, 1);
  const totalWeight = stages.reduce((sum, item) => sum + item.weight, 0) || 1;
  const completed = take(stages, stage).reduce(
    (sum, item) => sum + item.weight,
    0,
  );
  const current = stages[stage];
  const overall = pct(
    completed + (current ? current.weight * progress : 0),
    totalWeight,
  );
  const finished = stage >= stages.length;

  return (
    <div
      data-slot="job-progress"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-4",
        className,
      )}

      {...props}
    >
      <div className="flex items-center gap-2.5">
        {finished ? (
          <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <Loader2Icon className="text-foreground/35 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
          {title}
        </span>
        <span className={cn(mono, "text-foreground/35 shrink-0 tabular-nums")}>
          {finished ? "done" : eta}
        </span>
        {/* 本仓改动:没给 onCancel 就不画这颗 ×。原件只看"做完没有"，
            而本仓这张卡报的是模型自己声明的进度 —— 消息落盘就定格了，
            没有任何东西可以被取消。一颗按下去什么都不发生的 × 是在说谎 */}
        {!finished && onCancel && (
          <button
            type="button"
            aria-label="Cancel the job"
            onClick={onCancel}
            className={cn(ghostButton, "size-6 shrink-0")}
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      <span className="bg-foreground/[0.06] h-1 w-full overflow-hidden rounded-full">
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            finished ? "bg-emerald-500" : "bg-blue-500 dark:bg-blue-400",
          )}
          style={{ width: `${overall}%` }}
        />
      </span>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {stages.map((item, i) => (
          <span
            key={item.name}
            className={cn(
              mono,
              i < stage
                ? "text-foreground/35"
                : i === stage
                  ? "text-foreground/90"
                  : "text-foreground/20",
            )}
          >
            {item.name}
          </span>
        ))}
      </div>
    </div>
  );
}
