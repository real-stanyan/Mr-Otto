"use client";

// 来自 assistant-ui registry: elements-agent-handoff
// (https://r.assistant-ui.com/elements-agent-handoff.json)
//
// 本仓改动一览(升级时要人工合):
//  ① carried 可省 —— 上游是必填数组(演示里永远有东西被带过去);本仓的模型切换
//     不总有"带过去的东西"要列。
//  ② from 可省 —— 会话的第一条 model_changed 之前没有"上一个"(它就是起点),
//     这时只画落点那一枚 chip,不画一个凭空捏的来源。
//  ③ icon —— 上游两侧都是同一枚 lucide 机器人;本仓两侧是不同厂商,
//     厂商标记(ProviderMark)才是这一行真正要分辨的东西。
//  ④ "carried over" → 中文。

import type { ComponentProps, ReactNode } from "react";
import { ArrowRightIcon, BotIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, mono } from "@/lib/surfaces.js";

export function AgentHandoff({
  from,
  fromIcon,
  to,
  toIcon,
  reason,
  carried,
  settled,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "from" | "to" | "reason" | "carried" | "settled"
> & {
  from?: string | undefined;
  fromIcon?: ReactNode;
  to: string;
  toIcon?: ReactNode;
  reason?: ReactNode;
  carried?: readonly string[] | undefined;
  settled: boolean;
}) {
  return (
    <div
      data-slot="agent-handoff"
      className={cn("flex w-full max-w-sm flex-col gap-2", className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        {from !== undefined && (
          <>
            <span
              className={cn(
                field,
                "text-foreground/45 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-opacity duration-500",
                settled && "opacity-45",
              )}
            >
              {fromIcon ?? <BotIcon className="size-3" />}
              {from}
            </span>

            <ArrowRightIcon
              className={cn(
                "size-3.5 shrink-0 transition-colors duration-500",
                settled ? "text-foreground/25" : "text-brand",
              )}
            />
          </>
        )}

        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors duration-500",
            // 本仓改动:高亮用本仓的 brand 色,不是上游写死的蓝 —— 这一行的
            // "现在在用它"和界面别处的"当前/活跃"该是同一种颜色
            settled
              ? cn(field, "text-foreground/80")
              : "bg-brand/12 text-brand",
          )}
        >
          {toIcon ?? <BotIcon className="size-3" />}
          {to}
        </span>
      </div>

      {reason !== undefined && (
        <p className="text-foreground/55 text-xs leading-relaxed">{reason}</p>
      )}

      {carried !== undefined && carried.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={cn(mono, "text-foreground/30")}>一并带过去</span>
          {carried.map((item) => (
            <span
              key={item}
              className="text-foreground/60 border-foreground/12 border-s ps-2.5 text-xs leading-relaxed"
            >
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
