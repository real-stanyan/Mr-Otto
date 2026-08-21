// subagent_spawned 事件的时间线投影 —— 分组 / 状态推导 / 收口后的事实摘要 /
// "回到父会话"的返程 id。
//
// 纯函数不碰 React:同 modelHandoff.ts 的路子,vitest 直接跑。
//
// 硬规则(AGENTS.md):任何 UI 值都必须能从日志推导。这里几乎全部只靠**父会话
// 自己的**日志就够——task 工具走标准工具执行管线,子会话跑完 = 父会话里那次
// task 调用有了 tool_result(汇报文本就是它的 output),不需要另外去读子会话
// 的日志。真正要读子会话日志的只有"收口后的步数/token"这一条事实
// (subagentFact),因为那两个数字子会话的日志之外没处推。

import type { SessionEvent, SubagentSpawnedEvent } from "../../../session/events.js";
import { totalTokens } from "../../../session/deriveUsage.js";
import type { ToolIndex } from "./toolIndex.js";

/** 按所属 assistant_message 分组 —— 判定用 toolCallId 所属的那条
    assistant_message.toolCalls。执行是串行的(ADR-0047 的代价之一:子会话没有
    自己的停止键,派活本身也是 await 完才轮到下一个工具调用):一条消息里可能
    同时请求了两个 task 调用,但第二个的 subagent_spawned 要等第一个跑完才
    落盘——组会随着执行进度从 1 个成员长成 N 个,这里只描述"此刻已经落盘的
    成员",不预支还没发生的事实。调用方（Timeline）据此决定单个用 AgentStatus
    还是多个用 SubagentList，天然跟着日志的节奏走。 */
export function groupSubagentSpawns(
  events: readonly SessionEvent[],
): SubagentSpawnedEvent[][] {
  const owner = new Map<string, number>(); // toolCallId → 所属 assistant_message 的 seq
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    for (const c of e.toolCalls ?? []) owner.set(c.id, e.seq);
  }
  const order: number[] = [];
  const groups = new Map<number, SubagentSpawnedEvent[]>();
  for (const e of events) {
    if (e.type !== "subagent_spawned") continue;
    // 找不到归属理论不可达(task 调用必出自某条 assistant_message)，
    // 兜底成自己的 seq，自成一组，不让坏日志崩渲染
    const key = owner.get(e.toolCallId) ?? e.seq;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(e);
  }
  return order.map((k) => groups.get(k)!);
}

export type SubagentRowState = "working" | "waiting" | "done";

/** 单个 subagent_spawned 行的状态。
    done = 父会话里这次 task 调用已经有 tool_result(task 工具走标准工具管线，
    这条落盘就是子 turn 收口的事实)。
    没结果时看有没有审批/问卷冒泡到父会话——子会话的审批卡挂在父 sessionId 上
    (ADR-0047:人正看着父会话界面，卡不能挂子会话，不然死锁)。
    执行是串行的：任一时刻至多一个 subagent 没有结果，所以这里不需要按 agent
    名字再去匹配"冒泡上来的审批到底是哪一个子会话的"——不是这一行没结果，
    这条判定就落不到它头上。 */
export function subagentRowState(
  spawn: SubagentSpawnedEvent,
  index: ToolIndex,
  pendingApproval: boolean,
  pendingAsk: boolean,
): SubagentRowState {
  if (index.results.has(spawn.toolCallId)) return "done";
  return pendingApproval || pendingAsk ? "waiting" : "working";
}

/** mm:ss。subagent 一般跑几十秒到几分钟，没必要顾到小时档 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 收口后的紧凑事实："N 步 · Xk tokens"。
    步数 = 子日志里 assistant_message 的条数(模型被调用了几次)；
    token 走 deriveUsage 已有的求和(唯一事实源，不再另起一套算法)。
    子日志还没取到时回 null——调用方据此不显示，不拿 0 冒充"问过了"。 */
export function subagentFact(childEvents: readonly SessionEvent[] | undefined): string | null {
  if (childEvents === undefined) return null;
  const steps = childEvents.filter((e) => e.type === "assistant_message").length;
  const tokens = totalTokens([...childEvents]);
  const tokenLabel = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  return `${steps} 步 · ${tokenLabel} tokens`;
}

/** 派下去那件事的首行（spec §五：卡片标签 = subagent 名字 + 任务首行）。
    只印名字的话，同一条消息里把同一个 agent 派两次会渲染出两行一模一样的东西——
    看得见"派了两个人"，看不见"分别去干什么"。
    截断在 24 个字符：卡片本来就带 truncate，但省略号出现在"第一行结束"和
    "第一行还没完"两种情况下含义不同，这里先把段落切干净再交给 CSS。 */
export function taskHeadline(task: string, max = 24): string {
  const line = task.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 当前会话是不是被派活派出来的子会话，是就给出父会话 id。
    纯粹从 events[0](session_created)的 spawnedBy 读——"回到父会话"要的只是
    这一份事实，不需要绕经 sessions() 那份侧栏投影。 */
export function spawnedFromOf(events: readonly SessionEvent[]): string | null {
  const first = events[0];
  if (!first || first.type !== "session_created") return null;
  return first.spawnedBy?.sessionId ?? null;
}
