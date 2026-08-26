"use client";

// 一段工具调用的折叠时间线（assistant-ui elements 的 tool-timeline 版式）。
// 折叠头一行（工具图标 + 标签 + 右侧 chevron，跑的时候 shimmer），展开后每步一行。
// 版式跟思考折叠头（assistant-ui/reasoning.tsx 的 ReasoningTrigger）对齐：
// 左边一枚 size-4 图标定住行首，chevron 收到标签右边——两种折叠头在时间线里
// 交替出现，头一个字对不齐会看成两套控件。
// 本仓的步是真实工具行：调用方把 ToolFallback 传进来当 children——
// 每一步自己还是能展开看参数和输出，这条时间线只收「这一段干了什么」的头。
// 原版自带的 stats（文件增删行）本仓没接：事件日志里没有 diff 统计，
// 硬造一份是对读者说假话；哪天 write_file 落了行数统计再加回来。

import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon, WrenchIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/lib/utils.js";
import { collapsePanel, ShimmerLabel } from "@/lib/surfaces.js";

export function ToolTimeline({
  streaming = false,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  children,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  /** 组里还有工具在跑：折叠头换成 activeLabel + shimmer */
  streaming?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 收工后的折叠头文案（比如「读取 ×5 · 终端 ×2」） */
  restingLabel: ReactNode;
  /** 跑的时候的折叠头文案；没给就用 restingLabel */
  activeLabel?: ReactNode;
  /** 展开后的步骤行，调用方逐个传 */
  children?: ReactNode;
}) {
  return (
    <Collapsible
      data-slot="tool-timeline"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("group/tool-timeline w-full", className)}
      {...props}
    >
      <CollapsibleTrigger className="group/trigger text-foreground/55 hover:text-foreground/90 flex items-center gap-2 rounded-md py-1 text-[13.5px] transition-colors outline-none">
        <WrenchIcon className="size-4 shrink-0" />
        {streaming ? (
          // 跑着时直接 shimmer 标签——两层叠放的 SwapLabel 会在 streaming 翻转
          // 那一帧闪一下(SwapLabel 为宽度动画做了双份 DOM),这里是"加载中"语义,
          // 闪一下反而对;收工后的静态标签不需要 swap
          <ShimmerLabel active className="relative inline-block leading-none">
            {activeLabel ?? restingLabel}
          </ShimmerLabel>
        ) : (
          <span className="tabular-nums">{restingLabel}</span>
        )}
        <ChevronDownIcon className="mt-0.5 size-4 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] -rotate-90 group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div className="flex flex-col gap-1 ps-6 pt-1.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
