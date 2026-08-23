"use client";

// 来自 assistant-ui registry: elements-artifact-card
// (https://r.assistant-ui.com/elements-artifact-card.json)
// 取回于 2026-08-23（registry 不发版本号，只能记日期：升级时拿这个日期之后的
// upstream diff 对着下面这份改动一览人工合）
//
// 本仓改动一览（升级时要人工合）：
//  ① surfaces 从 @/lib/surfaces.js 引（上游是同目录 ./surfaces）。
//  ② 点开就地展开 —— 上游的卡是"点开去别处"（ArrowUpRightIcon 的语义），
//     本仓用它装的是时间线上的一段历史（压缩摘要），不是另一件事：加
//     onSelect / expanded / children，展开面板长在卡里（交互语义同
//     agent-status 的本仓改动 ③）。右上角的 ArrowUpRightIcon 相应换成
//     ChevronRightIcon 转 90°——箭头向外指是在承诺一次跳转，这里没有跳转。
//  ③ hover 的 -translate-y-px 去掉 —— 时间线是刻意静止的界面
//     （同 agent-status 本仓改动 ② 的动效纪律）；按压缩放保留，
//     展开后取消（里面是要滚着读的东西，同 agent-status）。

import type { ComponentProps, KeyboardEvent } from "react";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono, paper, ShimmerLabel } from "@/lib/surfaces.js";

export function ArtifactCard({
  title,
  meta,
  generating = false,
  words = 0,
  onSelect,
  expanded = false,
  children,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "title" | "meta" | "generating" | "words" | "onClick" | "onKeyDown"
> & {
  title: string;
  meta: string;
  generating?: boolean;
  words?: number;
  /** 给了才可点：点这张卡 = 就地展开/收起 children */
  onSelect?: () => void;
  /** 点开了：卡撑宽，children（全文面板）挂在头行下面 */
  expanded?: boolean;
  children?: React.ReactNode;
}) {
  const clickable = onSelect !== undefined;
  return (
    <div
      data-slot="artifact-card"
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-expanded": expanded,
            onClick: onSelect,
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelect();
            },
          }
        : {})}
      data-expanded={expanded || undefined}
      className={cn(
        paper,
        "group flex w-full flex-col rounded-[20px] p-3.5",
        expanded ? "max-w-2xl" : "max-w-xs",
        clickable && "cursor-pointer transition-transform duration-150 active:scale-[0.98]",
        expanded && "active:scale-100",
        className,
      )}
      {...props}
    >
      <div className="flex w-full items-center gap-3">
        <span className="bg-foreground/[0.05] text-foreground/45 flex size-9 shrink-0 items-center justify-center rounded-xl">
          <FileTextIcon
            className={cn(
              "size-4",
              generating && "animate-pulse motion-reduce:animate-none",
            )}
          />
        </span>
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate text-[13.5px] font-medium">{title}</p>
          {generating ? (
            <p className={cn(mono, "text-foreground/40 flex items-center gap-1")}>
              <ShimmerLabel className="relative inline-block leading-none">
                Writing
              </ShimmerLabel>
              <span>·</span>
              <span className="tabular-nums">{words} words</span>
            </p>
          ) : (
            <p
              className={cn(
                mono,
                "fade-in blur-in-[2px] animate-in text-foreground/40 duration-300 motion-reduce:animate-none",
              )}
            >
              {meta}
            </p>
          )}
        </div>
        {clickable && (
          <ChevronRightIcon
            className={cn(
              "text-foreground/35 size-3.5 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
        )}
      </div>
      {expanded ? children : null}
    </div>
  );
}
