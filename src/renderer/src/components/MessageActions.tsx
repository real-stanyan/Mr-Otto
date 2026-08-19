// 模型回复下方的动作条(assistant-ui 的 ActionBar 同款):hover 才现身。
//
// 复制的是 markdown 原文不是渲染结果:用户要粘进编辑器的是源码,不是排版。
//
// 重试在 append-only 日志下只有一种诚实的做法——把上一条用户消息的正文
// 原样再发一遍,追加新事件,旧日志一字不动。时间线上会出现两条一样的
// 用户消息,那就是事实:你确实又问了一遍。
// 原消息带附件时不能一键重发(附件本体在附件库,重新暂存要新增 bridge 方法),
// 按钮改成"填回输入框"让用户自己重新拖图——文案随状态变,不做静默降级。

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { CopyButton } from "./CopyButton.js";
import { hasUnretryableAttachments, lastUserMessage } from "../lib/lastUserMessage.js";
import { useChat } from "../store.js";
import type { UserMessageEvent } from "../../../session/events.js";

// 动作条(图标钮)和错误行(App.tsx 的 RetryButton,红色文字钮)外观不同,
// 但"点了发生什么"是同一件事——抽出来避免两处 onClick 逐字重复、将来改一处漏一处
export function retryLastUserMessage(prev: UserMessageEvent): void {
  if (hasUnretryableAttachments(prev)) {
    useChat.getState().injectComposer(prev.content, false);
    return;
  }
  void useChat.getState().send(prev.content);
}

export function MessageActions({ content, isLast }: { content: string; isLast: boolean }) {
  const events = useChat((s) => s.events);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const prev = lastUserMessage(events);
  const hasAttachments = hasUnretryableAttachments(prev);
  const canRetry = isLast && status !== "running";

  return (
    <div className="self-stretch -mt-[2px] flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
      <CopyButton text={content} label="复制回复" />
      {canRetry && prev && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={hasAttachments ? "填回输入框" : "重试"}
              className="w-auto h-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08]"
              onClick={() => retryLastUserMessage(prev)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {hasAttachments
              ? "把上一条消息填回输入框（附件要重新添加）"
              : "重试：把上一条消息原样再发一遍"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
