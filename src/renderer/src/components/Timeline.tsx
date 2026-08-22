// 消息区的两个渲染单元:一次工具调用一行,一条事件一行。
// 都是事件日志的直接投影——UI 不持有自己的对话状态。
// 从 App.tsx 抽出来:那个文件 2500+ 行,消息区的改动全挤在里面没法看

import { memo, useEffect, useMemo, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type {
  ModelChangedEvent,
  SessionEvent,
  SubagentSpawnedEvent,
  ToolCallRequest,
} from "../../../session/events.js";
import { Hl } from "../replay/HlText.js";
import { toolPhase, toolSummary } from "../lib/toolSummary.js";
import { compactedHeadline } from "../lib/autoCompactCopy.js";
import { buildToolIndex, type ToolIndex } from "../lib/toolIndex.js";
import { AUDIT, ROW, THINKING_BODY, THINKING_DETAILS, THINKING_SUMMARY, TOOL_PRE, TOOL_SEC } from "../timelineStyles.js";
import { TurnErrorState } from "./TurnErrorState.js";
import { TurnStoppedState } from "./TurnStoppedState.js";
import { ToolLiveTail } from "./ToolLiveTail.js";
import { AgentHandoff } from "./elements/agent-handoff.js";
import { AgentStatus } from "./elements/agent-status.js";
import { SubagentList, type SubagentItem } from "./elements/subagent-list.js";
import { SubagentTranscriptPanel } from "./SubagentTranscriptPanel.js";
import { ProviderMark } from "./ProviderMark.js";
import { modelHandoff, modelSideLabel, type ModelSide } from "../lib/modelHandoff.js";
import { modelChipLabel } from "../lib/modelChip.js";
import {
  formatElapsed,
  groupSubagentSpawns,
  subagentFact,
  subagentModel,
  subagentRowState,
  taskHeadline,
} from "../lib/subagentTimeline.js";
import { findProvider, type ProviderId } from "../../../shared/providerCatalog.js";
import { findModel } from "../../../shared/modelCatalog.js";
import { useChat } from "../store.js";

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
      <ToolLiveTail
        toolCallId={call.id}
        command={target || call.name}
        done={result !== undefined}
      />
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

/** 模型切换 = 一次交接:谁交给谁、之后的话由谁来说。
    渲染用 elements/agent-handoff —— 原来那行「模型切换 → glm/glm-4.6」把
    两件事压成了一件:它只说了落点,读的人得自己往上翻才知道刚才用的是谁,
    而"从谁换到谁"正是这一行唯一的信息。

    来处要看整份日志才知道(它是上一条 model_changed),所以这里订阅 events;
    modelHandoff 是纯函数(有测试钉着),这个组件只管把它画出来 */
function sideMark(side: ModelSide) {
  // 目录外的厂商(自定义 endpoint / 没收录的)没有标记可画,交给元件的默认机器人图标
  const known = findProvider(side.provider as ProviderId);
  return known ? <ProviderMark provider={side.provider as ProviderId} size={13} className="rounded-[4px]" /> : undefined;
}

const ModelHandoffRow = memo(function ModelHandoffRow({ event }: { event: ModelChangedEvent }) {
  const events = useChat((s) => s.events);
  const handoff = modelHandoff(events, event.seq);
  // 投影不出来(日志里找不到这条)时退回一行朴素文字:交接行画不了,
  // 但"换过模型"这个事实还是得留在时间线上
  if (!handoff) {
    return <div className={AUDIT}>模型切换 → {modelChipLabel(event.provider, event.model)}</div>;
  }
  return (
    <div className={AUDIT}>
      <AgentHandoff
        {...(handoff.from ? { from: modelSideLabel(handoff.from), fromIcon: sideMark(handoff.from) } : {})}
        to={modelSideLabel(handoff.to)}
        toIcon={sideMark(handoff.to)}
        // reason / carried 都不给:这一行要回答的只有"从谁换到了谁",
        // 两枚 chip 已经说完了。补一句"此后的回复由它生成"是把读者已经知道的事
        // 又讲一遍——切换行下面本来就跟着新模型说的话
        settled={handoff.settled}
      />
    </div>
  );
});

/** 跑着/等着的行需要一颗会走的表——父会话自己的日志在子会话跑的时候纹丝不动
    (task 调用是 await 的,父 turn 整段卡在这里,没有新事件可落),不挂个定时器
    elapsed 就会在初次渲染的那个数字上钉死。intervalMs=null 时不走表(收口的
    行不需要再滴答) */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** 卡右边那个模型名:优先子日志里 subagent_briefed 的快照(派活那一刻真用的),
    子日志还没取到(跑着 / 刚收口)才退回定义文件当前的 model。显示用目录里的
    label,目录里没有(自填的型号)就印原 id */
function modelLabelFor(
  spawn: SubagentSpawnedEvent,
  cache: Record<string, readonly SessionEvent[] | undefined>,
  defs: readonly { name: string; model?: string | undefined }[],
): string | null {
  const id = subagentModel(cache[spawn.childSessionId]) ?? defs.find((d) => d.name === spawn.agent)?.model;
  if (!id) return null;
  return findModel(id)?.label ?? id;
}

/** 派活卡:一条 subagent_spawned 落在时间线上的样子。
    分组、状态推导全部走 lib/subagentTimeline.ts 的纯函数(有测试钉着) ——
    这个组件只管订阅、拼 props、画出来。

    一个组只画一张卡:组里最后一个成员的位置渲染完整的卡(单个 AgentStatus /
    多个 SubagentList),更早的成员在自己的位置上返回 null——同一组不该在
    时间线上出现两张卡。执行是串行的,组会随日志节奏从 1 长到 N,卡自然跟着
    "长"到最新落盘的那个位置,不需要额外的过渡去模拟"多出一行" */
const SubagentSpawnedRow = memo(function SubagentSpawnedRow({ event }: { event: SubagentSpawnedEvent }) {
  const events = useChat((s) => s.events);
  const sessionId = useChat((s) => s.sessionId);
  const pendingApproval = useChat((s) => s.approvals[s.sessionId] !== undefined);
  const pendingAsk = useChat((s) => s.asks[s.sessionId] !== undefined);
  const subagents = useChat((s) => s.subagents);
  const subagentLogCache = useChat((s) => s.subagentLogCache);
  const loadSubagentLog = useChat((s) => s.loadSubagentLog);
  // 子会话此刻在跑哪个 toolCallId——ToolLiveTail 订阅的是 toolCallId 不是
  // sessionId,这份索引把两者接起来(Task 8 review Important 1)
  const runningToolCallBySession = useChat((s) => s.runningToolCallBySession);

  // 点开的那一行(按 toolCallId 记,不按下标:组会随日志长,下标会漂)。
  // 一次只开一个:看完收起看下一个,这是卡片内展开而不是整屏切过去的意义
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  const index = useMemo(() => buildToolIndex(events), [events]);
  const groups = useMemo(() => groupSubagentSpawns(events), [events]);
  const group = groups.find((g) => g.some((e) => e.toolCallId === event.toolCallId)) ?? [event];
  const isLastOfGroup = group[group.length - 1]?.toolCallId === event.toolCallId;
  const anyRunning = group.some((e) => !index.results.has(e.toolCallId));
  const now = useNow(anyRunning ? 1000 : null);

  // 收口了才去问子会话日志(还没收口时那份日志本来就还没定型,问了也白问)
  useEffect(() => {
    for (const e of group) {
      if (index.results.has(e.toolCallId)) void loadSubagentLog(e.childSessionId);
    }
    // group/index 每次渲染都可能是新引用,但 loadSubagentLog 内部有缓存闸,
    // 重复调用是空操作——这里不为了省这一层 useMemo 再多包一层
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, sessionId]);

  if (!isLastOfGroup) return null; // 早于当前组最新成员的位置,让最新那张卡说话

  if (group.length === 1) {
    const spawn = group[0]!;
    const state = subagentRowState(spawn, index, pendingApproval, pendingAsk);
    const resultTs = index.results.get(spawn.toolCallId)?.ts;
    const elapsedMs = (state === "done" ? (resultTs ?? now) : now) - spawn.ts;
    const fact = state === "done" ? subagentFact(subagentLogCache[spawn.childSessionId]) : null;
    const model = modelLabelFor(spawn, subagentLogCache, subagents);
    const runningToolCallId = runningToolCallBySession[spawn.childSessionId];
    return (
      <div className={`${AUDIT} flex flex-col items-center gap-1.5`}>
        <AgentStatus
          state={state}
          label={`${spawn.agent} · ${taskHeadline(spawn.task)}`}
          onSelect={() => toggle(spawn.toolCallId)}
          expanded={expandedId === spawn.toolCallId}
          {...(fact !== null ? { fact } : { elapsed: formatElapsed(elapsedMs) })}
          {...(model !== null ? { model } : {})}
        >
          <SubagentTranscriptPanel childSessionId={spawn.childSessionId} done={state === "done"} />
        </AgentStatus>
        {/* 直播尾巴:只在跑着、且子会话真有一个工具调用开着的时候才挂——
            没有就没有,不摆一个空壳子(同 ToolRow 的做法) */}
        {state === "working" && runningToolCallId !== undefined && (
          <ToolLiveTail toolCallId={runningToolCallId} command={spawn.agent} done={false} />
        )}
      </div>
    );
  }

  const items: SubagentItem[] = group.map((spawn) => {
    const done = index.results.has(spawn.toolCallId);
    const fact = done ? subagentFact(subagentLogCache[spawn.childSessionId]) : null;
    const model = modelLabelFor(spawn, subagentLogCache, subagents) ?? "";
    return {
      name: spawn.agent,
      model,
      task: taskHeadline(spawn.task),
      // key 用 toolCallId：同一条消息里把同一个 agent 派两次是常事，
      // 按名字做 key 就是两个一模一样的 key（React 会认错行）
      id: spawn.toolCallId,
      ...(fact !== null ? { fact } : {}),
    };
  });
  const completedCount = group.filter((spawn) => index.results.has(spawn.toolCallId)).length;
  // 二值色带,不是真进度:我们不知道子 agent 跑到几成了(design brief 的
  // "no fake progress")——done=完整色带,working=四成占位,只区分两态
  const progress = group.map((spawn) => (index.results.has(spawn.toolCallId) ? 100 : 40));
  // 执行是串行的:任一时刻至多一个成员还没结果,直播尾巴只可能属于它
  // (Task 8 review Important 1)
  const runningSpawn = group.find((spawn) => !index.results.has(spawn.toolCallId));
  const runningToolCallId = runningSpawn && runningToolCallBySession[runningSpawn.childSessionId];

  return (
    <div className={`${AUDIT} flex flex-col items-center gap-1.5`}>
      <SubagentList
        agents={items}
        completedCount={completedCount}
        progress={progress}
        showSummary={false}
        summaryAgent={items[0]!}
        onSelectAgent={(i) => toggle(group[i]!.toolCallId)}
        expandedIndex={group.findIndex((spawn) => spawn.toolCallId === expandedId)}
        renderDetail={(i) => (
          <SubagentTranscriptPanel
            childSessionId={group[i]!.childSessionId}
            done={index.results.has(group[i]!.toolCallId)}
          />
        )}
      />
      {runningToolCallId !== undefined && (
        <ToolLiveTail toolCallId={runningToolCallId} command={runningSpawn!.agent} done={false} />
      )}
    </div>
  );
});

/** subagent 就位存档(落子会话):同 skill_invoked 的折叠版式——全文是"模型看到的
    说明书"快照,不是对话内容,默认收着,想查就摊开 */
function SubagentBriefedRow({ agent, instructions, tools, model }: {
  agent: string; instructions: string; tools: string[]; model: string;
}) {
  return (
    <details className={THINKING_DETAILS}>
      <summary className={`${THINKING_SUMMARY} text-brand`}>
        ✦ 作为 subagent「{agent}」就位——{model} · {tools.length} 把工具
      </summary>
      <div className={THINKING_BODY}>{instructions}</div>
    </details>
  );
}

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
          ✻ {compactedHeadline(event.trigger)}——此前对话折叠为摘要（{event.model}
          {event.usage ? ` · 耗 ${event.usage.promptTokens + event.usage.completionTokens} tokens` : ""}）
        </div>
      );

    case "model_changed":
      return <ModelHandoffRow event={event} />;

    case "subagent_spawned":
      return <SubagentSpawnedRow event={event} />;

    case "subagent_briefed":
      return (
        <SubagentBriefedRow
          agent={event.agent}
          instructions={event.instructions}
          tools={event.tools}
          model={event.model}
        />
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

    // 跟进建议挂在输入框上方(见 aui/OttoThread.tsx 的 FollowupSuggestions),不进正文
    case "suggestions_generated":
      return null;

    // lifecycle 事件（ADR-0004）：聊天区是对话投影，系统脉搏不在这渲染（回放里看）。
    // 唯一例外：turn 暴死——错误从此是日志事实，重开 app 还在
    case "tool_execution_started":
      return null;
    case "turn_ended":
      // aborted 也上时间线：用户的停止是事实，得看得见——但用中性灰，不是故障红
      return event.outcome === "error" ? (
        // 重试只挂最后一条(interactive):它重发的是"上一条用户消息",对历史里的
        // 旧失败行没有意义 ——那条失败之后用户早就又说过别的话了,点它会重发一句不相干的
        <TurnErrorState
          title="turn 失败"
          detail={event.error ?? "没有错误信息"}
          interactive={isLast}
          className="max-w-none"
        />
      ) : event.outcome === "aborted" ? (
        // 中断 = 用户意志,中性灰——不是故障,不用红。
        // 「继续」只挂最后一条(interactive),理由同上:旧中断后面早有别的话了
        <TurnStoppedState interactive={isLast} className="max-w-none" />
      ) : null;
  }
});
