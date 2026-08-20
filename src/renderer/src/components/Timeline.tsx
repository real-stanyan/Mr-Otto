// 消息区的两个渲染单元:一次工具调用一行,一条事件一行。
// 都是事件日志的直接投影——UI 不持有自己的对话状态。
// 从 App.tsx 抽出来:那个文件 2500+ 行,消息区的改动全挤在里面没法看

import { memo, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";
import { Hl } from "../replay/Replay.js";
import { toolPhase, toolSummary } from "../lib/toolSummary.js";
import type { ToolIndex } from "../lib/toolIndex.js";
import { AUDIT, CHIP, ROW, THINKING_BODY, THINKING_DETAILS, THINKING_SUMMARY, TOOL_PRE, TOOL_SEC } from "../timelineStyles.js";
import { RetryButton } from "./RetryButton.js";
import { ToolLiveTail } from "./ToolLiveTail.js";

/** 一次工具调用 = 一行：请求 + 结果 + 耗时合并展示（都是日志投影，按 toolCallId 配对）。
    点开看详情：完整参数、完整输出、执行耗时（tool_execution_started 配对推导，ADR-0004）。
    memo:流式输出时 App 每个 token 重渲染一次,而这一行的入参(call/index)只随事件变——
    不 memo 的话整屏工具行陪着白跑(#115)。直播尾巴走自己的 store 订阅,memo 挡不住 */
export const ToolRow = memo(function ToolRow({ call, index }: { call: ToolCallRequest; index: ToolIndex }) {
  const [open, setOpen] = useState(false);
  const result = index.results.get(call.id);
  const started = index.starts.get(call.id);
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
      <ToolLiveTail toolCallId={call.id} done={result !== undefined} />
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
});

// memo 同上:现在只渲染审计事件(见下方 switch 里的注释),但入参(event/isLast)
// 同样只随事件变——不 memo 的话流式期间还是陪着白跑一遍(#115)
export const EventRow = memo(function EventRow({ event, isLast = false }: { event: SessionEvent; isLast?: boolean }) {
  switch (event.type) {
    // user_message / assistant_message 两个分支从此到不了:EventRow 现在只剩一个
    // 调用点(OttoThread 的 SystemMessage override),而那里只会拿到审计事件——
    // 两类事件各自的渲染已经进了 assistant-ui 自己的 role:"user"/"assistant" 分支
    // (Task 8 的 UserAttachments override、Task 9 的 streamdown)
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

    // 分区目录挂在左侧竖轨上，不进正文——每换一段话题就插一条系统行，
    // 等于把导航噪音倒进对话里
    case "section_classified":
      return null;

    // lifecycle 事件（ADR-0004）：聊天区是对话投影，系统脉搏不在这渲染（回放里看）。
    // 唯一例外：turn 暴死——错误从此是日志事实，重开 app 还在
    case "tool_execution_started":
      return null;
    case "turn_ended":
      // aborted 也上时间线：用户的停止是事实，得看得见——但用中性灰，不是故障红
      return event.outcome === "error" ? (
        // 重试只挂最后一条:它重发的是"上一条用户消息",对历史里的旧失败行没有意义
        // ——那条失败之后用户早就又说过别的话了,点它会重发一句不相干的
        <div className={`${CHIP} border-err text-err flex items-center gap-2`}>
          <span>[turn 失败] {event.error}</span>
          {isLast && <RetryButton />}
        </div>
      ) : event.outcome === "aborted" ? (
        // 中断 = 用户意志,中性灰居中——不是故障,不用红
        <div className={`${CHIP} self-center`}>已中断</div>
      ) : null;
  }
});
