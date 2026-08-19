// 模型回复下方的动作条(assistant-ui 的 ActionBar 同款):hover 才现身。
//
// 复制的是 markdown 原文不是渲染结果:用户要粘进编辑器的是源码,不是排版。
//
// 重试在 append-only 日志下只有一种诚实的做法——把上一条用户消息的正文
// 原样再发一遍,追加新事件,旧日志一字不动。时间线上会出现两条一样的
// 用户消息,那就是事实:你确实又问了一遍。
// 什么时候不能一键重发由 retryPlan 判断(消息自身带附件 / 此刻输入框
// 暂存区里有待发的附件),按钮改成"填回输入框"——文案随 plan 变,不做静默降级。

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { CopyButton } from "./CopyButton.js";
import { lastUserMessage } from "../lib/lastUserMessage.js";
import { retryPlan } from "../lib/retry.js";
import { retryLastUserMessage } from "../lib/retryAction.js";
import { useChat } from "../store.js";

export function MessageActions({ content, isLast }: { content: string; isLast: boolean }) {
  const events = useChat((s) => s.events);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const staged = useChat((s) => s.staged);
  const prev = lastUserMessage(events);
  const plan = retryPlan(prev, staged.length);
  const canRetry = isLast && status !== "running";

  return (
    <div className="self-stretch -mt-[2px] flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
      <CopyButton text={content} label="复制回复" />
      {canRetry && prev && plan && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={plan.mode === "resend" ? "重试" : "填回输入框"}
              className="w-auto h-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]"
              onClick={() => retryLastUserMessage(prev, plan)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {plan.mode === "resend"
              ? "重试：把上一条消息原样再发一遍"
              : plan.reason === "attachments"
                ? "把上一条消息填回输入框（附件要重新添加）"
                : "输入框里有待发送的附件，先填回正文，你确认后再发"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
