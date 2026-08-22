// 每 10 个 user turn 提醒一次"该整理记忆了"（hermes memory.nudge_interval 同款）。
// 计数从日志推导：最后一条 memory_nudge 之后的 user_message 数——重开 app 不丢数。

import type { SessionEvent } from "../session/events.js";

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
