"use client";

import type { ComponentProps, ReactNode } from "react";
import { AlertCircleIcon, Loader2Icon, RotateCwIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, mono, paper } from "@/lib/surfaces.js";

export function ToolError({
  name,
  target,
  message,
  attempt,
  maxAttempts,
  retrying = false,
  onRetry,
  onSkip,
  actions,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "name"
  | "target"
  | "message"
  | "attempt"
  | "maxAttempts"
  | "retrying"
  | "onRetry"
  | "onSkip"
> & {
  name: string;
  target: string;
  message: string;
  /** 本仓改动:重试计数改成可省。本仓没有"自动重试 n 次"这回事 ——
      工具错就是错,下一步由模型看着错误自己决定(它就在上下文里) */
  attempt?: number;
  maxAttempts?: number;
  retrying?: boolean;
  onRetry?: () => void;
  onSkip?: () => void;
  /** 本仓改动:动作条替换,规则同 permission-grant —— undefined 落回自带那排,
      null = 这排不要(本仓没有单条工具的重试/跳过入口:重跑一次工具是一件新的事,
      得有新的 tool_call 落盘,不能拿旧的那条冒充) */
  actions?: ReactNode;
}) {
  return (
    <div
      data-slot="tool-error"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-3.5",
        className,
      )}

      {...props}
    >
      <div className="flex items-center gap-2.5">
        <AlertCircleIcon className="size-3.5 shrink-0 text-red-500" />
        <span className={cn(mono, "text-foreground/55 shrink-0")}>{name}</span>
        <span className="text-foreground/80 min-w-0 flex-1 truncate text-[13px]">
          {target}
        </span>
        {attempt !== undefined && maxAttempts !== undefined && (
          <span className={cn(mono, "text-foreground/30 shrink-0 tabular-nums")}>
            {attempt}/{maxAttempts}
          </span>
        )}
      </div>

      <div
        className={cn(
          field,
          "rounded-xl px-3 py-2 font-mono text-[11px] leading-relaxed text-red-700 dark:text-red-300",
        )}
      >
        {message}
      </div>

      {actions === null ? null : actions !== undefined ? (
        <div className="flex items-center justify-end gap-2">{actions}</div>
      ) : (
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onSkip}
          disabled={!onSkip}
          className="text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/90 h-7 rounded-full px-2.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-30"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground/95 flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none"
        >
          {retrying ? (
            <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <RotateCwIcon className="size-3" />
          )}
          {retrying ? "Retrying" : "Retry"}
        </button>
      </div>
      )}
    </div>
  );
}
