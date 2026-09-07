"use client";

// 来自 assistant-ui registry: elements-typing-indicator
// (https://r.assistant-ui.com/elements-typing-indicator.json)
// 取回于 2026-09-07（registry 不发版本号，只能记日期：升级时拿这个日期之后的
// upstream diff 对着下面这份改动一览人工合）
//
// 本仓改动一览（升级时要人工合）：
//  ① import 后缀补 `.js`、`paper` 从 `@/lib/surfaces.js` 引（上游是同目录
//     `./surfaces`）—— 同 artifact-card / agent-status 那批的既有做法。
//  ② `aria-label` 从写死的 "Assistant is typing" 开放成可选的 `label` —— 云会话
//     是群聊，同一刻可能有好几只 agent 各自在打字，读屏软件念四遍同一句
//     "Assistant is typing" 等于没说；调用方把 agent 名字拼进去。默认值是中文的
//     「正在输入」，本仓界面语言就是中文。
//
// 两个 variant 都留着（`bubble` 眼下没有消费方）：这是一份 registry 抄件，
// 删一块就等于给将来每一次升级都加一道要重新施加的差异，而它不像
// agent-status 里那两颗按钮那样在本仓是句假话——只是暂时没用上。

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.js";
import { paper } from "@/lib/surfaces.js";

const DOT_DELAYS = ["-0.32s", "-0.16s", "0s"];

export function TypingIndicator({
  variant = "bubble",
  label = "正在输入",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "variant" | "role" | "aria-label"
> & {
  variant?: "bubble" | "bare";
  label?: string;
}) {
  const dots = DOT_DELAYS.map((delay) => (
    <span
      key={delay}
      aria-hidden
      className="bg-foreground/40 size-1.5 animate-bounce rounded-full motion-reduce:animate-none"
      style={{ animationDelay: delay, animationDuration: "1.1s" }}
    />
  ));

  if (variant === "bare") {
    return (
      <div
        data-slot="typing-indicator"
        data-variant="bare"
        role="status"
        aria-label={label}
        className={cn("flex gap-1", className)}
        {...props}
      >
        {dots}
      </div>
    );
  }

  return (
    <div
      data-slot="typing-indicator"
      data-variant="bubble"
      className={cn(paper, "w-fit rounded-full px-4 py-3.5", className)}
      {...props}
    >
      <div role="status" aria-label={label} className="flex gap-1">
        {dots}
      </div>
    </div>
  );
}
