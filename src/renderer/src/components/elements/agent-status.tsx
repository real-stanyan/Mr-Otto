"use client";

// 来自 assistant-ui registry: elements-agent-status
// (https://r.assistant-ui.com/elements-agent-status.json)
// 取回于 2026-08-21（registry 不发版本号，只能记日期：升级时拿这个日期之后的
// upstream diff 对着下面这份改动一览人工合）
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
//  ④′ 加一档 failed —— registry 原版只有 working/waiting/done，于是"被按停的"和
//     "顺利跑完的"长得一模一样（issue #267：日志里写着 status:"error"，卡片挂着
//     绿勾）。失败态是红叉，不是另一种绿。
//  ④ elapsed 之外加一个 fact —— 收口后显示"N 步 · Xk tokens"这类从子会话日志
//     算出来的事实，不是花哨的装饰。fact 存在时优先于 elapsed（done 状态本来
//     就不显示 elapsed，两者不会同时出现）。

import type { ComponentProps, KeyboardEvent } from "react";
import { BotIcon, CheckIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";

export type AgentState = "working" | "waiting" | "done" | "failed";

export interface StatusStep {
  state: AgentState;
  label: string;
}

export function AgentStatus({
  state,
  label,
  elapsed,
  fact,
  model,
  onSelect,
  expanded = false,
  children,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "state" | "label" | "elapsed" | "onClick" | "onKeyDown"
> & {
  /** 点开了:胶囊撑成卡,children(转录面板)挂在头行下面 */
  expanded?: boolean;
  state: AgentState;
  label: string;
  elapsed?: string;
  /** 收口后的一句事实（步数 · token），取代 elapsed 的位置 */
  fact?: string;
  /** 子会话用的模型,钉在最右边 */
  model?: string;
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
      data-expanded={expanded || undefined}
      className={cn(
        paper,
        "flex flex-col gap-2 py-1.5 ps-3.5 pe-3.5",
        expanded ? "w-full max-w-2xl rounded-2xl pb-2.5" : "rounded-full",
        clickable &&
          "cursor-pointer transition-transform duration-[160ms] ease-out active:scale-[0.97]",
        // 点开后整张卡别再跟着按压缩放:里面是要滚着读的东西
        expanded && "active:scale-100",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2.5">
      <BotIcon aria-hidden className="text-foreground/60 size-3.5 shrink-0" />
      {state === "done" ? (
        <CheckIcon aria-hidden className="size-3 shrink-0 text-emerald-500" />
      ) : state === "failed" ? (
        <XIcon aria-hidden className="size-3 shrink-0 text-red-500" />
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
      <span className="min-w-0 max-w-80 flex-1 truncate text-xs">{label}</span>
      {fact !== undefined ? (
        <span className={cn(mono, "text-foreground/35 shrink-0 tabular-nums")}>{fact}</span>
      ) : elapsed !== undefined && state !== "done" && state !== "failed" ? (
        <span className={cn(mono, "text-foreground/30 shrink-0 tabular-nums")}>{elapsed}</span>
      ) : null}
      {model !== undefined && (
        <span className={cn(mono, "text-foreground/50 ms-1 shrink-0 border-s border-foreground/10 ps-2.5")}>
          {model}
        </span>
      )}
      </div>
      {expanded ? children : null}
    </div>
  );
}
