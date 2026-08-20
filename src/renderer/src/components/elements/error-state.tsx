"use client";

import type { ComponentProps } from "react";
import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { ShimmerLabel } from "@/lib/surfaces.js";

export interface ErrorStateProps extends Omit<
  ComponentProps<"div">,
  "children" | "role"
> {
  title: string;
  detail: string;
  retrying: boolean;
  /** 本仓改动:可选。上游假设"失败必然可重试",本仓不是 ——
      历史里的旧失败行不挂重试(它重发的是"上一条用户消息",而那之后用户早说过别的话了),
      turn 正在跑时也不挂。没有出口时整个钮不出现,而不是出现一个点了没反应的钮 */
  onRetry?: (() => void) | undefined;
  /** 本仓改动:钮的文案随出口变。本仓的"重试"有两档(见 lib/retry.ts):
      原样重发 / 只把正文填回输入框(原消息带附件时)。写死 "Retry" 会骗人 */
  retryLabel?: string;
  retryTitle?: string;
  retryingLabel?: string;
}

export function ErrorState({
  title,
  detail,
  retrying,
  onRetry,
  retryLabel = "重试",
  retryTitle,
  retryingLabel = "重试中",
  className,
  ...props
}: ErrorStateProps) {
  if (retrying) {
    return (
      <div
        data-slot="error-state"
        key="retrying"
        role="status"
        className={cn(
          "fade-in animate-in flex w-full max-w-sm items-center gap-2.5 text-sm duration-300 motion-reduce:animate-none",
          className,
        )}

        {...props}
      >
        <RefreshCwIcon className="text-foreground/45 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        <ShimmerLabel className="text-foreground/55 relative inline-block">
          {retryingLabel}
        </ShimmerLabel>
      </div>
    );
  }

  return (
    <div
      data-slot="error-state"
      key="error"
      role="alert"
      className={cn(
        "fade-in animate-in flex w-full max-w-sm items-start gap-2.5 rounded-2xl bg-red-500/[0.06] px-4 py-3 text-sm duration-300 motion-reduce:animate-none dark:bg-red-500/10",
        className,
      )}

      {...props}
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-red-500/80" />
      <div>
        <p className="font-medium text-red-600 dark:text-red-400">{title}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-red-600/60 dark:text-red-400/60">
          {detail}
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          {...(retryTitle !== undefined ? { title: retryTitle } : {})}
          // 本仓改动:self-center。外层是 items-start(图标要和标题第一行对齐),
          // 于是这颗钮也被钉在顶上 —— 错误正文长起来时它孤零零挂在右上角。
          // 它是**整条**错误的出口,不属于标题那一行,竖直居中才对得上整块
          className="ms-auto flex shrink-0 items-center gap-1.5 self-center rounded-full px-3 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
        >
          <RefreshCwIcon className="size-3" />
          {retryLabel}
        </button>
      )}
    </div>
  );
}
