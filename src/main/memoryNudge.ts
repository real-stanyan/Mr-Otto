// 每 10 个 user turn 提醒一次"该整理记忆了"（hermes memory.nudge_interval 同款）。
// 计数从日志推导：最后一条 memory_nudge 之后的 user_message 数——重开 app 不丢数。

import type { SessionEvent } from "../session/events.js";
import type { ChatMessage } from "../session/deriveMessages.js";

export const MEMORY_NUDGE_EVERY = 10;

export function userTurnsSinceNudge(events: SessionEvent[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "memory_nudge") break;
    if (e.type === "user_message") n++;
  }
  return n;
}

/** 只在整点那一下为 true：落了 memory_nudge 之后计数归零，自然不会连发。
    子会话（session_created.spawnedBy 有值）永远 false——memory-reviewer 自己
    也是主 agent 派出来的子会话，不挡住它会递归自派 */
export function shouldNudge(events: SessionEvent[]): boolean {
  const created = events.find((e) => e.type === "session_created");
  if (created && created.type === "session_created" && created.spawnedBy) return false;
  return userTurnsSinceNudge(events) === MEMORY_NUDGE_EVERY;
}

/** 参数太长就掐掉——参数是 agent 自己生成的，掐了也看得出意图（同
    deriveMessages 里"老区长参数折叠"的取舍，但这里不追求合法 JSON，
    reviewer 只是读，不会拿它去解析） */
function clipArgs(args: string, max: number): string {
  return args.length > max ? args.slice(0, max) + "…" : args;
}

/** 派给 memory-reviewer 看的转写：只丢 system（那条尾部拼着 MEMORY/USER 块，
    reviewer 拿到的是 nudgeMemory 现读的最新版本，喂旧投影是重复信息）。
    user/assistant/tool 全留——工具怪癖（reviewer 要记的东西之一）就长在
    tool 消息和 assistant 的 tool_calls 里，COMPACT_COMPRESSION 已经把
    tool 输出/参数压过一轮（老区 800/200 字符），这里不再压第二遍，只管拼字符串。
    尾部截到 cap 字符：长会话不能把 reviewer 自己的上下文撑爆，离当前时刻
    最近的对话对"记什么"最有参考价值，所以保留尾部而不是头部 */
export function reviewerTranscript(messages: ChatMessage[], cap = 12_000): string {
  const lines = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      switch (m.role) {
        case "tool":
          return `tool: ${m.content}`;
        case "assistant": {
          const calls = (m.tool_calls ?? [])
            .map((c) => ` [调用 ${c.function.name}(${clipArgs(c.function.arguments, 200)})]`)
            .join("");
          return `assistant: ${m.content}${calls}`;
        }
        case "user":
          return `user: ${typeof m.content === "string" ? m.content : "[多模态]"}`;
      }
    });
  return lines.join("\n\n").slice(-cap);
}
