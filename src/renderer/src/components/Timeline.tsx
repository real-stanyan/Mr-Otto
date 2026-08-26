// 消息区的两个渲染单元:一次工具调用一行,一条事件一行。
// 都是事件日志的直接投影——UI 不持有自己的对话状态。
// 从 App.tsx 抽出来:那个文件 2500+ 行,消息区的改动全挤在里面没法看

import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { GitBranch } from "lucide-react";
import type {
  ContextCompactedEvent,
  ModelChangedEvent,
  SessionEvent,
  SkillInvokedEvent,
  SubagentSpawnedEvent,
  ToolCallRequest,
} from "../../../session/events.js";
import { Hl } from "../replay/HlText.js";
import { toolPhase, toolSummary } from "../../../shared/toolSummary.js";
import { compactedCardMeta, microCompactedHeadline } from "../lib/autoCompactCopy.js";
import { buildToolIndex, type ToolIndex } from "../lib/toolIndex.js";
import { AUDIT, ROW, THINKING_BODY, THINKING_DETAILS, THINKING_SUMMARY, TOOL_PRE, TOOL_SEC } from "../timelineStyles.js";
import { TurnErrorState } from "./TurnErrorState.js";
import { TurnStoppedState } from "./TurnStoppedState.js";
import { ToolLiveTail } from "./ToolLiveTail.js";
import { AgentHandoff } from "./elements/agent-handoff.js";
import { ArtifactCard } from "./elements/artifact-card.js";
import { AgentStatus } from "./elements/agent-status.js";
import { SubagentList, type SubagentItem } from "./elements/subagent-list.js";
import { SubagentTranscriptPanel } from "./SubagentTranscriptPanel.js";
import { ProviderMark } from "./ProviderMark.js";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker.js";
import { Button } from "@/components/ui/button.js";
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
import { estimateTokens } from "../../../shared/contextEstimate.js";
import { skillCardLabel } from "../../../shared/skillCard.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { activeSkills } from "../../../session/activeSkills.js";
import { barrenEventIndexes } from "../../../session/barrenTurns.js";
import { useChat } from "../store.js";

/** 时间线行共读的日志投影,OttoThread 顶层每次事件追加算一次、Context 分发。
    原来 SubagentSpawnedRow 每张卡各订阅 events、各自 buildToolIndex +
    groupSubagentSpawns 全量扫两遍——O(卡数×事件数),正是 #115 教训的复发。
    没有 Provider 时值为 null,行组件自己退回从 store 算(单测/孤立渲染还能用) */
export const TimelineProjectionContext = createContext<{
  index: ToolIndex;
  groups: SubagentSpawnedEvent[][];
  events: SessionEvent[];
} | null>(null);

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
  // Provider 在场就读共享投影;不在场(孤立渲染)才自己订阅 store。
  // proj 在场时选择器恒返回 null——订阅还挂着但值不再变,不会跟着 events 白重渲染
  const proj = useContext(TimelineProjectionContext);
  const storeEvents = useChat((s) => (proj ? null : s.events));
  const events = proj?.events ?? storeEvents ?? [];
  const handoff = useMemo(() => modelHandoff(events, event.seq), [events, event.seq]);
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
  // 共享投影同 ModelHandoffRow:Provider 在场就不订阅 events、不自己扫日志
  const proj = useContext(TimelineProjectionContext);
  const storeEvents = useChat((s) => (proj ? null : s.events));
  const events = proj?.events ?? storeEvents ?? [];
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

  const index = useMemo(() => proj?.index ?? buildToolIndex(events), [proj, events]);
  const groups = useMemo(() => proj?.groups ?? groupSubagentSpawns(events), [proj, events]);
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
    const elapsedMs = (state === "done" || state === "failed" ? (resultTs ?? now) : now) - spawn.ts;
    const settled = state === "done" || state === "failed";
    const fact = settled ? subagentFact(subagentLogCache[spawn.childSessionId]) : null;
    const model = modelLabelFor(spawn, subagentLogCache, subagents);
    const runningToolCallId = runningToolCallBySession[spawn.childSessionId];
    return (
      <div className={`${AUDIT} flex flex-col items-center gap-1.5`}>
        <AgentStatus
          state={state}
          // 分隔符跟着标题走:taskHeadline 可能是空串(现在被 task.ts:parseArgs 的
          // 空 task 拦着,但那是别人的不变量,不该由这里的排版依赖它,issue #141)
          label={taskHeadline(spawn.task) ? `${spawn.agent} · ${taskHeadline(spawn.task)}` : spawn.agent}
          onSelect={() => toggle(spawn.toolCallId)}
          expanded={expandedId === spawn.toolCallId}
          {...(fact !== null ? { fact } : { elapsed: formatElapsed(elapsedMs) })}
          {...(model !== null ? { model } : {})}
        >
          {/* done 在这儿的意思是"日志定型了没",不是"跑成功了没"——被中断的那份
              同样定了型，`state === "done"` 会让它的转录永远停在「还在跑」 */}
          <SubagentTranscriptPanel childSessionId={spawn.childSessionId} done={settled} />
        </AgentStatus>
        {/* 直播尾巴:只在跑着、且子会话真有一个工具调用开着的时候才挂——
            没有就没有,不摆一个空壳子(同 ToolRow 的做法) */}
        {state === "working" && runningToolCallId !== undefined && (
          <ToolLiveTail toolCallId={runningToolCallId} command={spawn.agent} done={false} />
        )}
      </div>
    );
  }

  const states = group.map((spawn) => subagentRowState(spawn, index, pendingApproval, pendingAsk));
  const items: SubagentItem[] = group.map((spawn, i) => {
    const state = states[i]!;
    // 收口了才有"步数/token"这条事实——失败/被中断的也收口了，它的 0 步 0 token
    // 同样是事实（红叉在旁边说清楚了那是怎么个 0，issue #267）
    const settled = state === "done" || state === "failed";
    const fact = settled ? subagentFact(subagentLogCache[spawn.childSessionId]) : null;
    const model = modelLabelFor(spawn, subagentLogCache, subagents) ?? "";
    return {
      name: spawn.agent,
      model,
      task: taskHeadline(spawn.task),
      // key 用 toolCallId：同一条消息里把同一个 agent 派两次是常事，
      // 按名字做 key 就是两个一模一样的 key（React 会认错行）
      id: spawn.toolCallId,
      state,
      ...(fact !== null ? { fact } : {}),
    };
  });
  const completedCount = states.filter((s) => s === "done").length;
  // 二值色带,不是真进度:我们不知道子 agent 跑到几成了(design brief 的
  // "no fake progress")——收口(不论成败)=完整色带,还在跑=四成占位,只区分两态；
  // 成败之分靠颜色（绿/红），不靠长短
  const progress = states.map((s) => (s === "done" || s === "failed" ? 100 : 40));
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

/** 压缩摘要卡（#128）：summary 是"此前那半个会话现在还剩什么"——压缩之后模型
    只看得见它，日志里有、界面上没有是净缺口。原来那行审计文字的信息
    （auto/manual + 模型 + 烧的 token）全在卡的 meta 行里；点开就地展开全文
    ——它是时间线上的一段历史，不是另一件事，不弹窗 */
const CompactSummaryRow = memo(function CompactSummaryRow({ event }: { event: ContextCompactedEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={AUDIT}>
      <ArtifactCard
        title="会话摘要"
        meta={compactedCardMeta(event.model, event.usage, event.trigger)}
        onSelect={() => setOpen(!open)}
        expanded={open}
      >
        <div className={`${THINKING_BODY} text-left`}>{event.summary}</div>
      </ArtifactCard>
    </div>
  );
});

/** skill 启用卡:折叠版式同旧版(全文是"给模型的说明书"存档,默认收着),
    文案改走 skillCardLabel(主/渲共用,来源标注不在这重复拼)。
    新增「停用」按钮——用户是老大,不管这把是 $ 启用的还是模型自己取的都能点掉
    (模型侧的 release 才校验来源)。按钮只在这把 skill 此刻还在台账里才出现:
    判定复用 session/activeSkills 这份唯一台账,不在渲染层另写一套——两套判断
    迟早 drift(deriveMessages 的清场重注入、subagentRunner 的派活复制已经在用
    这份台账,第三个消费者不该抄一份自己的)。
    按钮消失不是本地状态控制的:点击只管调 releaseSkill 落事件,活不活由
    events 数组重新过一遍台账决定——UI 是投影,不是自己维护的开关 */
const SkillInvokedRow = memo(function SkillInvokedRow({ event }: { event: SkillInvokedEvent }) {
  // 同 ModelHandoffRow 的退路:Provider 在场就读共享投影,孤立渲染(单测/无 Provider)
  // 才退回 store 自己订阅
  const proj = useContext(TimelineProjectionContext);
  const storeEvents = useChat((s) => (proj ? null : s.events));
  const events = proj?.events ?? storeEvents ?? [];
  const sessionId = useChat((s) => s.sessionId);
  const active = useMemo(
    () => activeSkills(events, barrenEventIndexes(events)).has(event.name),
    [events, event.name]
  );
  const [releasing, setReleasing] = useState(false);

  return (
    <details className={THINKING_DETAILS}>
      {/* skill 注入行:thinking 折叠版式 + accent 点题 */}
      <summary className={`${THINKING_SUMMARY} text-brand flex items-center justify-between gap-2`}>
        <span>✦ {skillCardLabel(event)}——指令已注入上下文</span>
        {active && (
          <Button
            variant="ghost"
            size="xs"
            disabled={releasing}
            // 卡片里可能不止一把 skill,纯文字"停用"对屏幕阅读器是同名多份——
            // aria-label 把名字带上,报出来的是"停用 skill tdd"而不是四个一样的"停用"
            aria-label={`停用 skill「${event.name}」`}
            // 阻止事件冒泡到 <summary>:不然点「停用」的同时把 <details> 也开合了
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setReleasing(true);
              window.otter.releaseSkill(sessionId, event.name).catch((err: unknown) => {
                // 没有本地"已停用"状态要回滚——按钮活不活看台账,失败了台账没变,
                // 按钮自己还在,这里只用把 disabled 松开、把错误亮出来
                setReleasing(false);
                console.error("停用 skill 失败:", bridgeErrorMessage(err));
              });
            }}
          >
            停用
          </Button>
        )}
      </summary>
      <div className={THINKING_BODY}>{event.content}</div>
    </details>
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

    case "session_unarchived":
      return <div className={AUDIT}>会话已取消归档</div>;

    case "session_renamed":
      return <div className={AUDIT}>会话改名 → {event.title}</div>;

    case "session_autotitled":
      return <div className={AUDIT}>会话自动命名 → {event.title}</div>;

    case "context_compacted":
      return <CompactSummaryRow event={event} />;

    // 钩子干预（issue #350）：模型视野被改写的审计事实——一行说清谁、对哪次调用、
    // 干了什么。原始输出/改后参数在回放（轨迹视图读原始事件）里看
    case "tool_hook": {
      const verb =
        event.action === "block"
          ? "拦截"
          : event.action === "revise_args"
            ? "改写入参"
            : event.action === "reject"
              ? "拒绝结果"
              : event.action === "guard_deny"
                ? "拒绝执行"
                : "注入反馈";
      // guard_deny（issue #383）：干预者是守卫不是钩子，行首身份跟着换
      const who = event.action === "guard_deny" ? "守卫" : "钩子";
      return (
        <div className={AUDIT}>
          ⛩ {who}「{event.hook}」{event.phase === "pre" ? "执行前" : "执行后"}{verb}
          {event.message ? `：${event.message}` : ""}
        </div>
      );
    }

    case "micro_compacted":
      return (
        <div className={AUDIT}>
          ✻ {microCompactedHeadline(estimateTokens(event.summary))}（{event.model}
          {event.usage ? ` · 耗 ${event.usage.promptTokens + event.usage.completionTokens} tokens` : ""}）
        </div>
      );

    // 请求信封（issue #383）：log-only 审计快照——一行说清这之后的请求长什么样。
    // 全文（system/工具 schema）在回放/日志里看，时间线不摊开
    case "request_envelope":
      return (
        <div className={AUDIT}>
          ✉ 请求信封已更新：{event.model}
          {event.thinking ? ` · 思考 ${event.thinking}` : ""} · 工具 {event.tools.length} 把
        </div>
      );

    case "model_changed":
      return <ModelHandoffRow event={event} />;

    // 分支切换（issue #411 / ADR-0093）：往回翻的时候，「这一段话是在哪个分支上说的」
    // 只有这一行能回答。用 Marker 的 separator 变体——它是一条横穿时间线的界线，
    // 而切分支正是一条界线：线之上和线之下，脚下的代码不是同一份。
    // 不用 AUDIT 那种缩进小字：模型切换是「谁在说话」变了，分支切换是「说的是哪份代码」
    // 变了，后者管得更宽，值一条真的分隔线
    case "branch_checked_out":
      return (
        <Marker variant="separator" className="py-1" data-testid="branch-marker">
          <MarkerIcon>
            <GitBranch />
          </MarkerIcon>
          <MarkerContent>
            切到分支 <span className="font-medium text-foreground">{event.branch}</span>
            {event.from ? `（自 ${event.from}）` : ""}
          </MarkerContent>
        </Marker>
      );

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

    case "project_instructions":
      // provenance 展示位（issue #353，与 skill 注入同一手法）：头行列出
      // 注入了哪几份，点开看各段全文——正文是"给模型的说明书"存档，默认折叠
      return (
        <details className={THINKING_DETAILS}>
          <summary className={`${THINKING_SUMMARY} text-brand`}>
            ⛰ 注入项目指令 {event.segments.length} 份（
            {event.segments.map((s) => s.path.split("/").pop()).join("、")}）
            {event.truncated ? "——部分文件超预算被丢弃" : ""}——已进上下文
          </summary>
          <div className={THINKING_BODY}>
            {event.segments.map((s) => `── ${s.path} ──\n${s.content}`).join("\n\n")}
          </div>
        </details>
      );

    case "skill_invoked":
      // 默认折叠：全文是"给模型的说明书"的存档快照，不是对话内容。
      // 来源标注 + 停用入口是 Task 6 的事，落在独立组件里(需要订阅台账)
      return <SkillInvokedRow event={event} />;

    // 停用：一行灰字——不是新的对话事实，只是台账变了(启用卡才值得用 accent 强调，
    // 停用没有正文可摊开，混进 accent 色反而抢启用卡的注意力)
    case "skill_released":
      return <div className={AUDIT}>已停用 skill「{event.name}」</div>;

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

    // 记忆事件（ADR-0060）：与 threadGroups.isInvisible 一一对应——快照/留证/触发点
    // 都不是对话内容(memory_nudge 派出的活由 subagent_spawned 卡呈现)
    case "memory_loaded":
    case "memory_user_edit":
    case "memory_nudge":
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
