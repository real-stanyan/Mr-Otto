// 事件日志 → assistant-ui 消息的投影。
//
// 和 src/session/deriveMessages.ts 同性质:都是从 append-only 日志推导的只读
// 投影,一个喂模型,一个喂 UI。硬规则「任何投影必须可从日志推导」在这条线上。
//
// 纯函数不碰 React:边界情况(悬空调用、被拒、compact 断层)全靠单测逼,
// 不靠肉眼在界面上找。

import { accumulateTurn, EMPTY_TURN_AGG, type TurnTimingAgg } from "./messageTiming.js";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { buildToolIndex, effectiveArgs } from "../lib/toolIndex.js";
import type { ToolCallRequest } from "../../../session/events.js";
import type { SessionEvent } from "../../../session/events.js";
import type { ToolIndex } from "../lib/toolIndex.js";
import { sourcePartsFor, type Part } from "./toolArtifacts.js";
import { isSystemNote } from "../lib/systemNote.js";

/** 流式直播缓冲(store.streamingBySession 的一项)。事件未落盘前的预览 */
export interface LiveBuffer {
  content: string;
  reasoning: string;
}

/** tool-call part 的精确形状(从联合里抠出来,主要是拿它的 args 字段类型:
    assistant-ui 要求 ReadonlyJSONObject,不是 Record<string, unknown> ——
    我们的 args 来自事件日志的 unknown,只能整体断言成这个精确类型 */
type ToolCallPart = Extract<Part, { type: "tool-call" }>;

/** 一次工具调用 + 它的结果 → 一个 tool-call part。
    结果是独立事件(靠 toolCallId 配对),assistant-ui 要求合进同一个 part。
    args 只有是对象时才进 args 字段:坏日志里它可能是任意 JSON,
    硬塞会让下游按对象展开时炸,退回 argsText 是无损的降级 */
function toToolCallPart(call: ToolCallRequest, index: ToolIndex): Part {
  const result = index.results.get(call.id);
  const isObject =
    typeof call.args === "object" && call.args !== null && !Array.isArray(call.args);

  const base = isObject
    ? { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        args: call.args as NonNullable<ToolCallPart["args"]> }
    : { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        argsText: JSON.stringify(call.args) };

  // exactOptionalPropertyTypes:没有结果/没出错时这两个键必须整个不出现,不能赋 undefined/false
  if (result === undefined) return base;
  if (result.status !== "ok") return { ...base, result: result.output, isError: true };
  return { ...base, result: result.output };
}

/** 时间线上看得见的非对话事件 → 一条 system 消息,原始事件挂 metadata。
    渲染交给既有的 EventRow(Task 6 的 SystemMessage override) —— 视觉一模一样,
    且不需要第二条渲染路径。
    这份名单照抄 Timeline.tsx 里 EventRow 不返回 null 的那些分支:
    tool_result / tool_execution_started 已被 tool-call part 吸收,
    approval_decision(approved) 是正常放行不是对话事实(免审模式下全是噪音)。
    「照抄」这件事本身有测试守着(tests/renderer/timelineLists.test.ts):
    三份名单(这里 / EventRow / threadGroups.isInvisible)读同一份源码互相对表——
    skill_released 曾经只加进 EventRow、漏了这里,于是那个 case 成了死代码,
    时间线上永远不出现停用行。靠人肉记住"还有两处要改"已经失败过两次 */
function isAuditEvent(e: SessionEvent): boolean {
  switch (e.type) {
    case "session_created":
    case "session_archived":
    case "session_unarchived":
    case "session_renamed":
    case "session_autotitled":
    case "model_changed":
    case "skill_invoked":
    // 停用（ADR-0122）：和 skill_invoked 一对——启用那行上了时间线，停用那行
    // 也必须上，否则用户只能靠「停用按钮消失」这个隐式信号猜到底停没停。
    // 漏在这里的代价不是少一行灰字：EventRow 那个 case 会变成永不执行的死代码
    case "skill_released":
    case "image_described":
    case "context_compacted":
    // 微压缩(ADR-0064):和 context_compacted 同列——"哪一段对话被并进摘要了"
    // 是审计事实,投影替换了模型看到的东西,时间线上必须留下痕迹
    case "micro_compacted":
    // 派活(Task 8):父会话上那张卡、子会话里的"我是谁"存档,都要能上时间线——
    // 同 model_changed 那一类,是审计事实不是对话正文
    case "subagent_spawned":
    case "subagent_briefed":
    // 钩子干预（issue #350）：拦截/改参/拒绝/反馈都是"模型视野被改写"的
    // 审计事实——同 micro_compacted 一类，时间线上必须留痕
    case "tool_hook":
    // 项目指令注入（issue #353）：注入了什么、从哪来——审计事实，时间线留痕
    case "project_instructions":
    // 请求信封（issue #383）：请求配置从这一刻起变了——审计事实，时间线留痕
    case "request_envelope":
    // 分支切换（issue #411）：往回翻时「这段话是在哪个分支上说的」只有这一行能答——
    // 它比模型切换管得更宽，聊天区当然要占一行
    case "branch_checked_out":
    // 分享给好友（issue #705）：`@好友` 那条正文不进模型，于是时间线上本来什么都
    // 没有——输入框一清，看起来像消息被吞了。这一行是那个动作唯一的痕迹，
    // 而它现在还可能连带借出了 MCP 服务（ADR-0177），更该看得见
    case "session_shared":
    // 改道（issue #696）：托管额度用完、自动落到用户自己的 key 那一刻——钱从谁
    // 账上出变了，assistant_message.route 只说结果不说"中途曾经改过道"，
    // 这一行是那个事实唯一的痕迹
    case "route_changed":
      return true;
    case "approval_decision":
      return e.decision === "denied";
    case "turn_ended":
      return e.outcome !== "completed";
    case "section_classified":
      // main 合并进来的事件类型(会话分区分类)。目录挂在分区轨(SectionRail)上,
      // 不进正文——同 lib/threadGroups.ts 的 isInvisible 里同一分支。原先落到
      // default 也是同一个结果(false),但那是"碰巧对";这里显式列出来,
      // 免得以后 default 分支的语义变了,这条却没人注意到
      return false;
    case "suggestions_generated":
      // 跟进建议不是对话事实,它挂在输入框上方(ThreadFollowupSuggestions),
      // 不在时间线里占一行 —— 同 section_classified
      return false;
    case "session_topic_assigned":
    case "session_topic_set":
      // 主题分类/手动归类同理:侧栏分组用的标签,不是对话事实——同
      // threadGroups.isInvisible 的同名分支,显式列出防 default 漂移(#846)
      return false;
    case "checkpoint_created":
    case "workspace_restored":
      // 检查点/文件恢复(issue #395):审计事实,但回退入口在轨迹视图——
      // 聊天区不渲染(同 threadGroups.isInvisible 的同名分支,显式列出防 default 漂移)
      return false;
    default:
      return false;
  }
}

function toAuditMessage(e: SessionEvent): ThreadMessageLike {
  return {
    role: "system",
    id: String(e.seq),
    createdAt: new Date(e.ts),
    // 必须**恰好一个 text part**,空数组会让 assistant-ui 的 fromThreadMessageLike
    // 当场抛「System messages must have exactly one text message part.」——
    // 整个渲染层崩掉,而不是这一行不显示。
    // 内容给空串:审计行的真正载荷在 metadata.custom.otto 上,由 SystemMessage 槽
    // 交给 EventRow 渲染(见 thread.tsx 的 system 分支,它压根不读 content)。
    // 这里写任何字都会变成"另一份说法",空串才诚实:这条消息没有正文
    content: [{ type: "text", text: "" }],
    metadata: { custom: { otto: e } },
  };
}

export function toThreadMessages(
  events: SessionEvent[],
  live?: LiveBuffer
): ThreadMessageLike[] {
  const index = buildToolIndex(events);
  const out: ThreadMessageLike[] = [];
  // 本 turn 已经落下的那条 assistant 消息在 out 里的位置(没有 = null)。
  // turn_ended 要标失败时只认它,别去动上一个 turn 的回复(见下面 turn_ended 分支)
  let turnAssistantIdx: number | null = null;
  // 页脚那行数字按 turn 结算(见 messageTiming.ts 的 TurnTimingAgg):
  // 从用户发话开始累,只挂在不带工具调用的那条(= 最终回复)上
  let turnAgg: TurnTimingAgg = EMPTY_TURN_AGG;
  let turnStartTs: number | undefined;

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx]!;
    if (e.type === "user_message") {
      // 护栏 / 后台任务回注（#957 C-I5，#936）：engine 自己注的话，不是人打
      // 的——画成系统旁白（EventRow 接住，见 Timeline.tsx 里 isSystemNote
      // 那段 switch 之外的早退分支），不再冒充一条 role:"user" 气泡。判据
      // 与云时间线共用（lib/systemNote.ts），本机没有工作区名册，agent 名
      // 的解析留给 Timeline.tsx 那一侧（这里只决定"算不算审计事件"）。
      // 沿用既有的 turn 边界重置（原本任何 user_message 都会重置）——这条
      // 分支只换目标消息的角色，不改动计时投影的既有行为
      if (isSystemNote(e)) {
        turnAssistantIdx = null;
        turnAgg = EMPTY_TURN_AGG;
        turnStartTs = e.ts;
        out.push(toAuditMessage(e));
        continue;
      }
      const parts: Part[] = [];
      // "$skill 任务"在发送时被拆成两条事件:skill_invoked(快照)紧贴在 user_message
      // 之前,user_message 只剩任务正文。气泡要把 `$名字` 画回成 chip(UserText 走
      // directive-text,只认正文里的 `$名字`),所以投影时把它拼回去 —— 从日志推导,
      // 不是凭空加:那条 skill_invoked 就是证据。中间可能隔一条 image_described
      // (vision-bridge 也落在 user_message 之前),跳过它再看
      const skill = invokedSkillBefore(events, idx);
      const text = skill === null ? e.content : `$${skill} ${e.content}`.trimEnd();
      if (text.trim() !== "") parts.push({ type: "text", text });
      turnAssistantIdx = null; // 新一轮开始
      turnAgg = EMPTY_TURN_AGG;
      turnStartTs = e.ts;
      out.push({
        role: "user",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        content: parts,
        // 原始事件挂上来:附件(图片引用/文本文件快照)不进 content ——
        // 图片本体在附件库、走 IPC 懒取(ADR-0009),而投影是纯函数不碰 IPC。
        // 渲染交给既有的 UserAttachments(它自己懒取、自己缓存、自己降级)
        metadata: { custom: { otto: e } },
      });
      continue;
    }

    if (e.type === "assistant_message") {
      const parts: Part[] = [];
      if ((e.reasoning ?? "") !== "") parts.push({ type: "reasoning", text: e.reasoning! });
      // 旁白(模型边干边说的短句):这条消息带 toolCalls = 它是「过程中的一句」,不是
      // 给用户的最终回复。投成带 narration 标记的 reasoning part —— 与工具共享
      // chainOfThought 分组 path,收进同一条时间线当一步,而不是当正文 text part
      // (正文 part path 为空,是分组的硬断点,会把「bash → 说一句 → bash」拆成两条
      // 单步时间线)。最终回复那条不带 toolCalls,content 仍是 text part,留在时间线外
      const hasTools = (e.toolCalls?.length ?? 0) > 0;
      if (e.content !== "") {
        if (hasTools) {
          parts.push({ type: "reasoning", text: e.content, narration: true } as Part);
        } else {
          parts.push({ type: "text", text: e.content });
        }
      }
      // 工具产物(查到的来源、写出的文件)统一排在所有工具行之后,不插在每一行后面。
      // 两个理由:
      // ① 工具行靠"连续"才能合成一组折叠(thread.tsx 的 groupPartByType),中间插一条
      //    别的 part 就把组切断了 —— 一次「搜索→读文件→写文件」会碎成三组;
      // ② 语义上它们是这条回复的产物,不是某一次调用的脚注 —— 多次搜索到同一个
      //    地址也该只出现一次(下面按 url 去重)
      const artifacts: Part[] = [];
      const seenSources = new Set<string>();
      for (const call of e.toolCalls ?? []) {
        parts.push(toToolCallPart(call, index));
        const result = index.results.get(call.id);
        for (const p of sourcePartsFor(call, result)) {
          if (p.type !== "source" || seenSources.has(p.id)) continue;
          seenSources.add(p.id);
          artifacts.push(p);
        }
      }
      parts.push(...artifacts);

      // 有调用还没拿到结果 = 这条消息还在等世界回话(悬空调用,ADR-0005)
      const pending = (e.toolCalls ?? []).some((c) => !index.results.has(c.id));
      const message: ThreadMessageLike = {
        role: "assistant",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        status: pending
          ? { type: "requires-action", reason: "tool-calls" }
          : { type: "complete", reason: "stop" },
        content: parts,
      };
      // 页脚数字要的两个事实(见 aui/messageTiming.ts):
      // reasoningMs 落在事件上(ADR-0032);elapsedMs 是"这次模型调用花了多久",
      // 日志里没有这个字段但推得出 —— 前一条事件的 ts 就是这次调用的起点
      // (首条是用户发话,其余是上一次工具落地)。推得出的不落盘,和 turn 的
      // steps 数是同一条原则(events.ts 的 TurnEndedEvent 注释)
      const prevTs = idx > 0 ? events[idx - 1]!.ts : undefined;
      const custom: Record<string, unknown> = {};
      if (e.reasoningMs !== undefined) custom["reasoningMs"] = e.reasoningMs;
      const elapsedMs = prevTs !== undefined ? e.ts - prevTs : undefined;
      if (elapsedMs !== undefined) custom["elapsedMs"] = elapsedMs;
      custom["otto"] = e;
      turnAgg = accumulateTurn(turnAgg, e, elapsedMs);
      if ((e.toolCalls ?? []).length === 0) {
        custom["turnTiming"] = {
          ...turnAgg,
          wallMs: turnStartTs !== undefined ? e.ts - turnStartTs : 0,
        } satisfies TurnTimingAgg;
      }
      // 同一 turn 的多个 assistant_message 合并进**一条** UI 消息:
      // 一个 turn 里模型可能「说一句 → 调 bash → 再说一句 → 再调 bash」,每次回话
      // 都是一条独立的 assistant_message 事件。若每条各投一条 UI 消息,工具调用就
      // 散在**不同消息**里 —— 分组(相邻合并)跨不过消息边界,6 个 bash 就渲染成
      // 6 条「终端 ×1」的单步时间线,而不是收进一条。合并后:旁白/思考/工具按
      // 事件序拼进同一条消息的 content,分组合并在消息内把它们收成一条时间线。
      if (turnAssistantIdx !== null && out[turnAssistantIdx]?.role === "assistant") {
        // 本 turn 已有 assistant 消息:把这次的 parts 续进去,计时/状态取最新
        const prev = out[turnAssistantIdx]!;
        const prevCustom = (prev.metadata?.custom ?? {}) as Record<string, unknown>;
        out[turnAssistantIdx] = {
          ...prev,
          status: message.status, // 最新一条的完成状态(悬空/完成)以新事件为准
          content: [...(prev.content as Part[]), ...parts],
          metadata: { custom: { ...prevCustom, ...custom } },
        };
      } else {
        turnAssistantIdx = out.length;
        out.push({ ...message, metadata: { custom } });
      }
      continue;
    }

    if (e.type === "turn_ended") {
      // 回头改**这个 turn 自己**那条 assistant 消息的状态:turn 的死法是那条消息的
      // 属性,不是一条独立的消息。aborted 是用户按的停(ADR-0006),不是故障。
      //
      // 只认本 turn 的那一条 —— 原来是从尾巴一路往回找"最近的 assistant 消息",
      // 于是 turn 死在模型开口之前(429/断网/停止)时,它会把**上一个 turn**那条
      // 答得好好的回复标成失败,界面上给一条成功的回答扣一个红框。
      // 本 turn 一条都没有 = 没有可标的:失败已经由审计行(turn 失败那条)说了。
      // 注意这里不 continue —— 它还要往下走,出一条审计行
      if (e.outcome !== "completed" && turnAssistantIdx !== null) {
        const m = out[turnAssistantIdx];
        if (m !== undefined) {
          out[turnAssistantIdx] = {
            ...m,
            status: { type: "incomplete", reason: e.outcome === "aborted" ? "cancelled" : "error" },
          };
        }
      }
      turnAssistantIdx = null;
    }

    if (isAuditEvent(e)) {
      out.push(toAuditMessage(e));
      continue;
    }
  }

  if (live !== undefined && (live.content !== "" || live.reasoning !== "")) {
    const parts: Part[] = [];
    if (live.reasoning !== "") parts.push({ type: "reasoning", text: live.reasoning });
    if (live.content !== "") parts.push({ type: "text", text: live.content });
    out.push({ role: "assistant", id: "live", status: { type: "running" }, content: parts });
  }

  return out;
}

/** 紧贴在 events[idx](一条 user_message)之前的 skill_invoked 的名字;没有 → null */
function invokedSkillBefore(events: readonly SessionEvent[], idx: number): string | null {
  for (let j = idx - 1; j >= 0; j--) {
    const p = events[j]!;
    if (p.type === "image_described") continue;
    return p.type === "skill_invoked" ? p.name : null;
  }
  return null;
}
