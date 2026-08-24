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
import { filePartFor, sourcePartsFor, type Part } from "./toolArtifacts.js";

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
    approval_decision(approved) 是正常放行不是对话事实(免审模式下全是噪音) */
function isAuditEvent(e: SessionEvent): boolean {
  switch (e.type) {
    case "session_created":
    case "session_archived":
    case "session_renamed":
    case "session_autotitled":
    case "model_changed":
    case "skill_invoked":
    case "image_described":
    case "context_compacted":
    // 微压缩(ADR-0064):和 context_compacted 同列——"哪一段对话被并进摘要了"
    // 是审计事实,投影替换了模型看到的东西,时间线上必须留下痕迹
    case "micro_compacted":
    // 派活(Task 8):父会话上那张卡、子会话里的"我是谁"存档,都要能上时间线——
    // 同 model_changed 那一类,是审计事实不是对话正文
    case "subagent_spawned":
    case "subagent_briefed":
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
      if (e.content !== "") parts.push({ type: "text", text: e.content });
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
        artifacts.push(...filePartFor(call, result, effectiveArgs(call, index)));
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
      turnAssistantIdx = out.length;
      out.push({ ...message, metadata: { custom } });
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
