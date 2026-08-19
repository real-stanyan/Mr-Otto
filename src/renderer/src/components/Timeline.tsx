// 消息区的两个渲染单元:一次工具调用一行,一条事件一行。
// 都是事件日志的直接投影——UI 不持有自己的对话状态。
// 从 App.tsx 抽出来:那个文件 2500+ 行,消息区的改动全挤在里面没法看

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ThinkingOrb } from "thinking-orbs";
import type {
  SessionEvent,
  ToolCallRequest,
  ToolExecutionStartedEvent,
  ToolResultEvent,
} from "../../../session/events.js";
import { useChat } from "../store.js";
import { Hl } from "../replay/Replay.js";
import { UserAttachments } from "./UserAttachments.js";
import { toolPhase, toolSummary } from "../lib/toolSummary.js";
import { thinkingLabel } from "../lib/thinkingLabel.js";
import { AUDIT, CHIP, ROW, THINKING_BODY, THINKING_DETAILS, THINKING_SUMMARY, TOOL_PRE, TOOL_SEC } from "../timelineStyles.js";
import { MD_COMPONENTS } from "./CodeBlock.js";
import { MessageActions } from "./MessageActions.js";

/** 一次工具调用 = 一行：请求 + 结果 + 耗时合并展示（都是日志投影，按 toolCallId 配对）。
    点开看详情：完整参数、完整输出、执行耗时（tool_execution_started 配对推导，ADR-0004） */
export function ToolRow({ call, all }: { call: ToolCallRequest; all: SessionEvent[] }) {
  const [open, setOpen] = useState(false);
  const result = all.find(
    (e): e is ToolResultEvent => e.type === "tool_result" && e.toolCallId === call.id
  );
  const started = all.find(
    (e): e is ToolExecutionStartedEvent =>
      e.type === "tool_execution_started" && e.toolCallId === call.id
  );
  // 执行中的直播尾巴（bash 的 stdout/stderr 碎片）。tool_result 落地后 store
  // 会清掉这个 key，这里自然消失——直播只活在"事实到来前"的窗口里
  const live = useChat((s) => s.toolOutputByCall[call.id]);
  const liveRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // 终端语义：始终看最新输出，新碎片到就滚到底
    liveRef.current?.scrollTo(0, liveRef.current.scrollHeight);
  }, [live]);
  const { verb, target, stat } = toolSummary(call);
  const status = result?.status ?? "running";

  return (
    <div className={`${ROW} p-0`}>
      {/* 高频摘要行零动画;宽行按压不缩放(读感怪) */}
      <button
        className="flex items-center gap-2 text-left bg-transparent border-none rounded-lg py-[5px] px-2 -mx-2 w-[calc(100%+16px)] text-[13px] text-muted-foreground transition-colors duration-[120ms] hover:bg-foreground/5"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span
          className={
            "font-[550] shrink-0 " +
            (status === "error" || status === "denied" ? "text-deny" : "text-foreground")
          }
        >
          {verb}
        </span>
        {target && <span className="font-mono text-xs text-muted-foreground truncate">{target}</span>}
        {stat && <span className="text-ok tabular-nums shrink-0">{stat}</span>}
        {status === "running" && (
          <span className="flex items-center gap-1.5 text-muted-foreground shrink-0">
            <ThinkingOrb state={toolPhase(call.name).orb} size={20} theme="auto" />
            <span className="shimmer">{toolPhase(call.name).label}</span>
          </span>
        )}
        {status === "error" && <span className="text-deny shrink-0">出错</span>}
        {status === "denied" && <span className="text-deny shrink-0">已拒绝</span>}
        <span
          className={
            "ml-auto shrink-0 text-muted-foreground transition-transform duration-150 ease-strong motion-reduce:transition-none" +
            (open ? " rotate-90" : "")
          }
        >
          ›
        </span>
      </button>
      {!result && live && (
        // 执行中的输出直播:迷你终端尾巴。低亮度——它是过程噪音,不是结果
        <pre
          className="mt-[2px] mb-1 px-[10px] py-2 max-h-40 overflow-y-auto bg-muted border border-border rounded-lg font-mono text-xs leading-normal text-muted-foreground whitespace-pre-wrap break-all transition-opacity duration-150 ease-strong starting:opacity-0"
          ref={liveRef}
        >
          {live}
        </pre>
      )}
      {open && (
        // 详情展开是偶发动作:150ms ease-out 入场,从触发行长出来(origin 左上)
        <div className="mt-[2px] mb-1 px-3 py-[10px] bg-card border border-border rounded-[10px] origin-top-left transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:-translate-y-[2px] starting:scale-[0.99] motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 motion-reduce:starting:scale-100">
          <div className="text-xs text-muted-foreground tabular-nums mb-[6px]">
            {call.name} · {status}
            {result && started ? ` · 执行耗时 ${result.ts - started.ts} ms` : ""}
          </div>
          <div className={TOOL_SEC}>参数</div>
          <pre className={TOOL_PRE}><Hl src={JSON.stringify(call.args, null, 2)} /></pre>
          {result && (
            <>
              <div className={TOOL_SEC}>输出</div>
              <pre className={TOOL_PRE}><Hl src={result.output || "（空）"} /></pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function EventRow({ event, isLast = false }: { event: SessionEvent; isLast?: boolean }) {
  switch (event.type) {
    case "user_message":
      // 附件不进气泡:图片/文件是"随话递过来的东西",不是话的一部分——
      // 各自成卡片摆在气泡上方(UserAttachments),气泡只留给用户正文。
      // 只带附件不带字时不出空气泡:没说话就是没说话
      return (
        <div className={`${ROW} self-end flex flex-col items-end gap-[6px]`}>
          <UserAttachments attachments={event.attachments} textFiles={event.textFiles} />
          {event.content.trim() !== "" && (
            // 多行输入原样展示(pre-wrap):换行是用户打的事实,别折叠成一行
            <div className="max-w-full whitespace-pre-wrap break-words bg-primary text-primary-foreground rounded-[12px_12px_2px_12px] px-3 py-2">
              {event.content}
            </div>
          )}
        </div>
      );

    case "assistant_message":
      // 工具调用不在这渲染:它们被 groupThread 抽出去按"相邻成组"重新编排了
      // (同一条消息的调用可能和下一条消息的调用属于同一组)
      // 模型输出按 Markdown 渲染（react-markdown 默认转义 HTML，无注入面）；
      // 用户消息保持原文——用户打的不是 markdown，别替他排版
      return (
        <>
          {event.reasoning && (
            // 思考默认折叠：它是"怎么想的"的档案，不是回复本身。
            // 纯文本渲染（pre-wrap）——思考不是给人排版的 markdown
            <details className={THINKING_DETAILS}>
              <summary className={THINKING_SUMMARY}>
                {thinkingLabel(event.reasoning, event.reasoningMs)}
              </summary>
              <div className={THINKING_BODY}>{event.reasoning}</div>
            </details>
          )}
          {event.content.trim() !== "" && (
            // 与 threadGroups 的分组判定同口径,避免纯空白消息渲染不一致
            // group/msg:动作条只在悬停这条回复时现身
            <div className="group/msg self-stretch max-w-full flex flex-col">
              {/* 模型回复无框:正文直接躺在背景上,占满行宽(气泡只留给用户消息) */}
              <div className="md max-w-full py-[2px]">
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS}>
                  {event.content}
                </Markdown>
              </div>
              <MessageActions content={event.content} isLast={isLast} />
            </div>
          )}
        </>
      );

    case "tool_result":
      return null; // 已被 ToolRow 吸收（按 toolCallId 配对进请求行）

    case "approval_decision":
      // 批准(含 bypass 自动批准)只是"正常放行",不是对话事实,时间线不显示——
      // 免审模式下一长串「已批准」纯属噪音。拒绝才上时间线:它中断了流程,
      // 且 ToolRow 的「已拒绝」只是结果态,审批卡/理由值得在时间线留档
      if (event.decision === "approved") return null;
      return (
        <div className={AUDIT}>
          审批：已拒绝{event.reason ? `（${event.reason}）` : ""}
        </div>
      );

    case "session_created":
      return <div className={AUDIT}>会话已创建</div>;

    case "session_archived":
      return <div className={AUDIT}>会话已归档</div>;

    case "session_renamed":
      return <div className={AUDIT}>会话改名 → {event.title}</div>;

    case "context_compacted":
      return (
        <div className={AUDIT}>
          ✻ 上下文已压缩——此前对话折叠为摘要（{event.model}
          {event.usage ? ` · 耗 ${event.usage.promptTokens + event.usage.completionTokens} tokens` : ""}）
        </div>
      );

    case "model_changed":
      return (
        <div className={AUDIT}>
          模型切换 → {event.provider}/{event.model}
        </div>
      );

    case "skill_invoked":
      // 默认折叠：全文是"给模型的说明书"的存档快照，不是对话内容
      return (
        <details className={THINKING_DETAILS}>
          {/* skill 注入行:thinking 折叠版式 + accent 点题 */}
          <summary className={`${THINKING_SUMMARY} text-brand`}>
            ✦ 启用 skill「{event.name}」——指令已注入上下文
          </summary>
          <div className={THINKING_BODY}>{event.content}</div>
        </details>
      );

    case "image_described":
      // vision-bridge 代读存档：默认折叠——它是给无视觉模型的"图片字幕"，
      // 不是对话内容；摊开能看到视觉模型到底读出了什么（解析质量一目了然）
      return (
        <details className={THINKING_DETAILS}>
          <summary className={THINKING_SUMMARY}>👁 图片解析（由 {event.model} 代读）——已注入上下文</summary>
          <div className={THINKING_BODY}>{event.content}</div>
        </details>
      );

    // lifecycle 事件（ADR-0004）：聊天区是对话投影，系统脉搏不在这渲染（回放里看）。
    // 唯一例外：turn 暴死——错误从此是日志事实，重开 app 还在
    case "tool_execution_started":
      return null;
    case "turn_ended":
      // aborted 也上时间线：用户的停止是事实，得看得见——但用中性灰，不是故障红
      return event.outcome === "error" ? (
        <div className={`${CHIP} border-err text-err`}>[turn 失败] {event.error}</div>
      ) : event.outcome === "aborted" ? (
        // 中断 = 用户意志,中性灰居中——不是故障,不用红
        <div className={`${CHIP} self-center`}>已中断</div>
      ) : null;
  }
}
