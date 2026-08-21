"use client";

// 来自 assistant-ui registry: elements-agent-status
// (https://r.assistant-ui.com/elements-agent-status.json)
//
// 本仓改动一览（升级时要人工合）：
//  ① 去掉右侧的暂停/重跑按钮 —— 本仓没有单个 subagent 的暂停能力，子会话自己
//     没有停止键（ADR-0047：父 turn 的停止键往下传给子会话，子会话自己不单独
//     持有一颗）；"重新运行"这件事也没有实现。按下去什么都不发生的按钮是在
//     说谎——同 job-progress 里"没给 onCancel 就不画那颗 ×"的先例。
//  ② label 的入场动效（fade-in blur-in animate-in）去掉 —— 本仓的设置/时间线
//     是刻意静止的界面，没有入场/交错动效这一档预算（Task 8 的动效纪律）。
//  ③ 加一个 onSelect —— 整张卡可点，点进去是这一行对应的子会话（时间线上这
//     张卡存在的意义就是"点进去看过程"）。给了 onSelect 才具备按钮语义
//     （role/tabIndex/回车-空格键），没给就保持纯展示，不强加交互。
//  ④ elapsed 之外加一个 fact —— 收口后显示"N 步 · Xk tokens"这类从子会话日志
//     算出来的事实，不是花哨的装饰。fact 存在时优先于 elapsed（done 状态本来
//     就不显示 elapsed，两者不会同时出现）。

import type { ComponentProps, KeyboardEvent } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";

export type AgentState = "working" | "waiting" | "done";

export interface StatusStep {
  state: AgentState;
  label: string;
}

export function AgentStatus({
  state,
  label,
  elapsed,
  fact,
  onSelect,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "state" | "label" | "elapsed" | "onClick" | "onKeyDown"
> & {
  state: AgentState;
  label: string;
  elapsed?: string;
  /** 收口后的一句事实（步数 · token），取代 elapsed 的位置 */
  fact?: string;
  /** 给了才可点：点这一行 = 进这个 subagent 对应的子会话 */
  onSelect?: () => void;
}) {
  const clickable = onSelect !== undefined;
  return (
    <div
      data-slot="agent-status"
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: onSelect,
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelect();
            },
          }
        : {})}
      className={cn(
        paper,
        "flex items-center gap-2.5 rounded-full py-1.5 ps-3.5 pe-3.5",
        clickable &&
          "cursor-pointer transition-transform duration-[160ms] ease-out active:scale-[0.97]",
        className,
      )}
      {...props}
    >
      {state === "done" ? (
        <CheckIcon aria-hidden className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full motion-reduce:animate-none",
            state === "working"
              ? "animate-pulse bg-blue-500 dark:bg-blue-400"
              : "animate-pulse bg-foreground/25",
          )}
        />
      )}
      <span className="max-w-44 truncate text-xs">{label}</span>
      {fact !== undefined ? (
        <span className={cn(mono, "text-foreground/35 tabular-nums")}>{fact}</span>
      ) : elapsed !== undefined && state !== "done" ? (
        <span className={cn(mono, "text-foreground/30 tabular-nums")}>{elapsed}</span>
      ) : null}
    </div>
  );
}
