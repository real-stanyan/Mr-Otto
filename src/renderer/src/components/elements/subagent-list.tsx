"use client";

// 来自 assistant-ui registry: elements-subagent-list
// (https://r.assistant-ui.com/elements-subagent-list.json)
//
// 本仓改动一览（升级时要人工合）：
//  ① progress 不是进度条，是状态色带 —— 我们没有真百分比（子 agent 是黑箱，
//     不报"跑到几成了"），调用方只会传两档：完成 100、跑着 40。这里不改数值
//     语义（照样是 0–100 的 width%），改的是使用约定，落在调用侧（Timeline）。
//  ② SubagentItem 加一个 fact —— 收口后那一行显示"N 步 · Xk tokens"，存在时
//     盖过 model 的位置（完成的行不需要再看"用的什么型号"，步数和 token 才是
//     这一刻的事实）。
//  ③ 加一个 onSelectAgent —— 每一行可点，点进去是这一行对应的子会话。给了才
//     具备按钮语义（role/tabIndex/回车-空格键），没给保持纯展示。
//  ③′ 加 task / id 两个字段 —— 见 SubagentItem 上的注释（同一个 agent 被派
//     两次时，registry 原版的 key={name} 会撞车）。
//  ④ 去掉入场/交错动效（完成时 CheckIcon 的 zoom-in、summary 卡的 slide-in）
//     —— 本仓的时间线是刻意静止的界面，没有这一档预算（Task 8 的动效纪律）。
//     width 的过渡（状态从"跑着"切到"完成"）留着：那是状态指示，不是装饰性
//     的入场。
//  ⑤ 这条过渡的 duration-700 严格说超出了"可点元素 160ms ease-out"那份预算
//     ——是有意的：色带切换不是按压反馈，是状态指示（同 job-progress 现有的
//     duration-500 先例），700ms 让"跑着→完成"这个切换看得清，不是漏改。
//     写在这里而不是当成疏漏，免得下一次升级/复核把它"修"回 160ms。

import type { ComponentProps, KeyboardEvent } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono, paper } from "@/lib/surfaces.js";
import { pct } from "@/lib/range.js";

export interface SubagentItem {
  name: string;
  model: string;
  /** 收口后的一句事实（步数 · token）。存在时取代 model 的展示位置 */
  fact?: string;
  /** 派下去那件事的首行（spec §五：名字 + 任务首行）。同一条消息里把同一个
      agent 派两次是常事，只印名字的话两行一模一样，看不出谁是谁 */
  task?: string;
  /** React key。**不能用 name**：同一个 agent 派两次，两行同名 = 重复 key，
      React 会认错行（状态串行、重排丢失）。调用方传 toolCallId */
  id?: string;
}

export function SubagentList({
  agents,
  completedCount,
  progress,
  showSummary,
  summaryAgent,
  onSelectAgent,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "agents"
  | "completedCount"
  | "progress"
  | "showSummary"
  | "summaryAgent"
> & {
  agents: readonly SubagentItem[];
  completedCount: number;
  progress: readonly number[];
  showSummary: boolean;
  summaryAgent: SubagentItem;
  /** 给了才可点：点某一行 = 进那一行对应的子会话 */
  onSelectAgent?: (index: number) => void;
}) {
  return (
    <div
      data-slot="subagent-list"
      className={cn(
        "flex min-h-[14.5rem] w-full max-w-xs flex-col gap-2",
        className,
      )}
      {...props}
    >
      {agents.map((agent, index) => {
        const done = index < completedCount;
        const width = progress[index] ?? 0;
        const clickable = onSelectAgent !== undefined;

        return (
          <div
            key={agent.id ?? agent.name}
            {...(clickable
              ? {
                  role: "button" as const,
                  tabIndex: 0,
                  onClick: () => onSelectAgent(index),
                  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onSelectAgent(index);
                  },
                }
              : {})}
            className={cn(
              paper,
              "flex flex-col gap-2 rounded-2xl px-3.5 py-2.5",
              clickable &&
                "cursor-pointer transition-transform duration-[160ms] ease-out active:scale-[0.97]",
            )}
          >
            <div className="flex items-center gap-2">
              {done ? (
                <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
              ) : (
                <Loader2Icon className="text-foreground/35 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
              )}
              <span className="flex-1 truncate text-[13.5px]">
                {agent.name}
                {agent.task ? (
                  <span className="text-foreground/45"> · {agent.task}</span>
                ) : null}
              </span>
              <span className={cn(mono, "text-foreground/35 shrink-0")}>
                {agent.fact ?? agent.model}
              </span>
            </div>
            <span className="bg-foreground/[0.06] h-[3px] w-full overflow-hidden rounded-full">
              <span
                className={cn(
                  "block h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none",
                  done ? "bg-emerald-500/70" : "bg-foreground/60",
                )}
                style={{ width: `${pct(width, 100)}%` }}
              />
            </span>
          </div>
        );
      })}
      {showSummary && (
        <div
          className={cn(
            paper,
            "flex flex-col gap-2 rounded-2xl px-3.5 py-2.5",
          )}
        >
          <div className="flex items-center gap-2">
            <Loader2Icon className="text-foreground/35 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            <span className="flex-1 truncate text-[13.5px]">
              {summaryAgent.name}
            </span>
            <span className={cn(mono, "text-foreground/35")}>
              {summaryAgent.fact ?? summaryAgent.model}
            </span>
          </div>
          <span className="bg-foreground/[0.06] h-[3px] w-full overflow-hidden rounded-full">
            <span
              className="bg-foreground/60 block h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none"
              style={{ width: "42%" }}
            />
          </span>
        </div>
      )}
    </div>
  );
}
