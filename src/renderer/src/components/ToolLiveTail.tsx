// 执行中的输出直播尾巴 —— 迷你终端视角:只看最新进展。
//
// 从 ToolRow 抽出来:assistant-ui 的 ToolFallback 没有「执行中的输出」这个概念,
// 而 bash 跑长命令时这条尾巴是界面上唯一的进度信号。抽出来两边共用,行为一字不变。
//
// tool_result 落地后 store 会清掉这个 key,组件自然消失——
// 直播只活在「事实到来前」的那个窗口里。

import { useEffect, useRef } from "react";
import { useChat } from "../store.js";

export function ToolLiveTail({ toolCallId, done }: { toolCallId: string; done: boolean }) {
  const live = useChat((s) => s.toolOutputByCall[toolCallId]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // 终端语义:始终看最新输出,新碎片到就滚到底
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [live]);

  if (done || live === undefined || live === "") return null;
  return (
    <pre
      className="mt-[2px] mb-1 px-[10px] py-2 max-h-40 overflow-y-auto bg-muted border border-border rounded-lg font-mono text-xs leading-normal text-muted-foreground whitespace-pre-wrap break-all transition-opacity duration-150 ease-strong starting:opacity-0"
      ref={ref}
    >
      {live}
    </pre>
  );
}
