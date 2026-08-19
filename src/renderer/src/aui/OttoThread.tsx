// Thread 的组装 —— assistant-ui 出骨架,本仓只补三样东西。
//
// 「保留 Mr Otto 现有视觉」这条决定的落点在 SystemMessage:八类审计行直接喂回
// 既有的 EventRow,一行没重写,也不需要第二条渲染路径。

import { useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ThinkingOrb } from "thinking-orbs";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker.js";
import { Thread, type ThreadComponents } from "../components/assistant-ui/thread.js";
import { ToolFallback } from "../components/assistant-ui/tool-fallback.js";
import { ToolLiveTail } from "../components/ToolLiveTail.js";
import { EventRow } from "../components/Timeline.js";
import { RetryButton } from "../components/RetryButton.js";
import { UserAttachments } from "../components/UserAttachments.js";
import { CHIP } from "../timelineStyles.js";
import { useChat } from "../store.js";
import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";
import type { OrbState } from "../lib/toolSummary.js";

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

/** 用户附件:原始事件挂在 metadata.custom.otto 上,交给既有的 UserAttachments 渲染。
    它自己走 window.otter.attachmentDataUrl 懒取图片、自己有内存缓存、
    图片丢失时自己降级成占位卡 —— 这些都不该在投影层重做一遍。
    命名 OttoUserAttachments(不叫 UserMessageAttachments)——那个名字已经是
    thread.tsx 从 attachment.js 引入的上游组件,同名会读着别扭 */
const OttoUserAttachments: ComponentType = () => {
  const event = useAuiState(
    (s) => s.message.metadata.custom["otto"] as SessionEvent | undefined,
  );
  if (event === undefined || event.type !== "user_message") return null;
  return <UserAttachments attachments={event.attachments} textFiles={event.textFiles} />;
};

/** 工具行:用 assistant-ui 的 ToolFallback,外挂一条直播尾巴 ——
    它没有「执行中的输出」这个概念,而 bash 跑长命令时那条尾巴是唯一的进度信号 */
const ToolFallbackWithLiveTail: NonNullable<ThreadComponents["ToolFallback"]> = (part) => (
  <>
    <ToolFallback {...part} />
    <ToolLiveTail toolCallId={part.toolCallId} done={part.result !== undefined} />
  </>
);

// ─── RunIndicator:turn 运行时的相位指示器(补回接线时丢掉的功能,见 Task 11) ───
//
// 投影(toThreadMessages.ts)只在 live.content / live.reasoning 非空时才产出消息,
// turn 开始到第一个 token 到达之间没有任何消息可渲染 —— 这个指示器不认消息,
// 直接订阅 store 的 status/approval,所以它能在"消息还不存在"的这段窗口里出现。
// 以下几个纯函数原样取回自 git show d2e3357:src/renderer/src/App.tsx,不重写:
// fmtTokens(121)、fmtElapsed(126)、TurnMeta(175)、currentTool(618)、agentPhase(633)。
// 没有放回 App.tsx 再 export 回来 —— 那样 App.tsx 就要 import OttoThread.tsx
// (渲染它),OttoThread.tsx 又要 import App.tsx(用这些函数),两个模块互相 import
// 形成循环依赖。这几个函数只有这里一个消费者,直接放在这里最干净

/** 会话累计 token（prompt + completion）——又一个日志投影：重开 app 账不丢。
    App.tsx 也有一份同名函数(供 CtxRing 用),两处消费者不同、没有共同调用方,
    没有为了不重复这八行去建一个新的共享模块 */
function totalTokens(events: SessionEvent[]): number {
  let sum = 0;
  for (const e of events) {
    if ((e.type === "assistant_message" || e.type === "context_compacted") && e.usage) {
      sum += e.usage.promptTokens + e.usage.completionTokens;
    }
  }
  return sum;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** orb 旁的状态文案：耗时 · token · 在干嘛（Claude Code 状态行同款，一行合体）。
    挂载即计时——本组件只在 turn 进行中存在，出生时刻就是 turn 起点 */
function TurnMeta({ events }: { events: SessionEvent[] }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const tokens = useMemo(() => totalTokens(events), [events]);
  return (
    <span className="tabular-nums">
      {fmtElapsed(now - start)} · {fmtTokens(tokens)} tokens
    </span>
  );
}

/** 当前执行中的工具(有请求、无结果 = 还没落地)。纯日志投影:数 tool_result 对号 */
function currentTool(events: SessionEvent[]): ToolCallRequest | null {
  const done = new Set<string>();
  for (const e of events) if (e.type === "tool_result") done.add(e.toolCallId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "assistant_message") {
      for (const c of e.toolCalls ?? []) if (!done.has(c.id)) return c;
    }
  }
  return null;
}

/** agent 当前阶段 → orb 动画 + 文案。审批等待最优先,其后按「在跑哪个环节」细分:
     检索(read_file) / 执行(bash·write_file) / 思考(reasoning) / 作答(正文)——都是日志投影。
     四段对应 orbs 的 Searching / Working / Thinking / Solving */
function agentPhase(opts: {
  status: "idle" | "running";
  hasApproval: boolean;
  streamingThinking: string;
  streamingText: string;
  tool: ToolCallRequest | null;
}): { orb: OrbState; label: string } {
  if (opts.hasApproval) return { orb: "listening", label: "等待审批…" };
  if (opts.status !== "running") return { orb: "breathing", label: "空闲" };
  if (opts.tool?.name === "read_file") return { orb: "searching", label: "检索中…" };
  if (opts.tool) return { orb: "working", label: "执行中…" };
  if (opts.streamingText) return { orb: "solving", label: "作答中…" };
  return { orb: "composing", label: "思考中…" }; // reasoning 或模型首次调用:都还在想
}

// ─── ErrorBanner:IPC 层瞬时发送失败的提示条(补回接线时丢掉的功能,见 Task 11) ───
//
// store.error 与 turn_ended(error) 是刻意分开的两类失败(见 store.ts send() 的
// 注释):这一类是消息压根没进事件日志(会话不存在/turn 冲突),不是投影
// (toThreadMessages.ts)能表达的东西——它不对应任何 SessionEvent。只能像
// RunIndicator 一样直接订阅 store、挂在 ViewportFooter,而不是走消息流。
// 没有放进 RunIndicator 里合并:两者语义不同(一个是"turn 正在跑",一个是
// "消息没发出去、turn 根本没起来"),经验上互斥但概念上不该揉成一个组件。
// 样式照抄旧 App.tsx 的 chip(`git show 88703d1` 的 `[turn 失败]` 那行),
// 重试钮复用 RetryButton——它自己会在 status==="running" 或没有上一条用户
// 消息时隐身,这里不用重复判断
const ErrorBanner: ComponentType = () => {
  const error = useChat((s) => s.error);
  if (!error) return null;
  return (
    <div className={`${CHIP} border-err text-err flex items-center gap-2`}>
      <span>[turn 失败] {error}</span>
      <RetryButton />
    </div>
  );
};

/** ViewportFooter 里的相位指示器:数据照旧从 store 订阅(statusBySession / approvals /
    events / streamingBySession)。status 不是 running 且没有挂起审批就不渲染——
    这两个条件合起来正是原来 App.tsx 里 `(status === "running" || approval !== null)` */
const RunIndicator: ComponentType = () => {
  const events = useChat((s) => s.events);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  const streamingText = useChat((s) => s.streamingBySession[s.sessionId]?.content ?? "");
  const streamingThinking = useChat((s) => s.streamingBySession[s.sessionId]?.reasoning ?? "");

  const turnPhase = agentPhase({
    status,
    hasApproval: approval !== null,
    streamingThinking,
    streamingText,
    tool: currentTool(events),
  });

  if (status !== "running" && approval === null) return null;

  return (
    <Marker role="status" className="py-[2px] text-[13px]">
      <MarkerIcon className="size-5">
        <ThinkingOrb state={turnPhase.orb} size={20} theme="auto" />
      </MarkerIcon>
      <MarkerContent className="shimmer">{turnPhase.label}</MarkerContent>
      <span className="ml-auto shrink-0 text-xs">
        <TurnMeta events={events} />
      </span>
    </Marker>
  );
};

// 模块级常量:每次渲染新建对象会让整棵子树白重挂
const COMPONENTS: ThreadComponents = {
  SystemMessage,
  UserAttachments: OttoUserAttachments,
  ToolFallback: ToolFallbackWithLiveTail,
  RunIndicator,
  ErrorBanner,
};

export function OttoThread() {
  return <Thread components={COMPONENTS} />;
}
