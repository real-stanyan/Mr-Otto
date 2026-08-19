// Thread 的组装 —— assistant-ui 出骨架,本仓只补三样东西。
//
// 「保留 Mr Otto 现有视觉」这条决定的落点在 SystemMessage:八类审计行直接喂回
// 既有的 EventRow,一行没重写,也不需要第二条渲染路径。

import type { ComponentType } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Thread, type ThreadComponents } from "../components/assistant-ui/thread.js";
import { ToolFallback } from "../components/assistant-ui/tool-fallback.js";
import { ToolLiveTail } from "../components/ToolLiveTail.js";
import { EventRow } from "../components/Timeline.js";
import type { SessionEvent } from "../../../session/events.js";

/** 审计行:原始事件挂在 metadata.custom.otto 上(Task 3 的投影)。metadata.custom
    的类型是 Record<string, unknown> ——不认识 SessionEvent,这一转型没有更窄的写法。
    isLast 必须传:turn_ended(error) 那条行只在最后一条上挂重试键 ——
    重发的是「上一条用户消息」,对历史里的旧失败行没有意义 */
const SystemMessage: ComponentType = () => {
  const event = useAuiState(
    (s) => s.message.metadata.custom["otto"] as SessionEvent | undefined,
  );
  const isLast = useAuiState((s) => s.message.isLast);
  if (event === undefined) return null;
  return <EventRow event={event} isLast={isLast} />;
};

/** 工具行:用 assistant-ui 的 ToolFallback,外挂一条直播尾巴 ——
    它没有「执行中的输出」这个概念,而 bash 跑长命令时那条尾巴是唯一的进度信号 */
const ToolFallbackWithLiveTail: NonNullable<ThreadComponents["ToolFallback"]> = (part) => (
  <>
    <ToolFallback {...part} />
    <ToolLiveTail toolCallId={part.toolCallId} done={part.result !== undefined} />
  </>
);

// 模块级常量:每次渲染新建对象会让整棵子树白重挂
const COMPONENTS: ThreadComponents = {
  SystemMessage,
  ToolFallback: ToolFallbackWithLiveTail,
};

export function OttoThread() {
  return <Thread components={COMPONENTS} />;
}
