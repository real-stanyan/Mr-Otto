// 每 10 个 user turn 提醒一次"该整理记忆了"（hermes memory.nudge_interval 同款）。
// 计数从日志推导：最后一条 memory_nudge 之后的 user_message 数——重开 app 不丢数。

import type { SessionEvent, MemoryTopicSnapshot } from "../session/events.js";
import type { NewSessionEvent } from "../session/store.js";
import type { ChatMessage } from "../session/deriveMessages.js";
import { topicIndexOf } from "../shared/memoryStore.js";
import { renderTopicIndex } from "../shared/memoryTopics.js";

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

/** 达到或过点就 true（>= 而非 ===）：某一轮 turn 中途 abort/throw 会跳过
    落 memory_nudge 的那一步，若用 === 则那个窗口错过后再也追不上——直到
    下一次完整跑完的 turn 也不会补发。落了 memory_nudge 之后计数归零，
    自然不会连发，所以 >= 不会导致重复触发。
    子会话（session_created.spawnedBy 有值）永远 false——memory-reviewer 自己
    也是主 agent 派出来的子会话，不挡住它会递归自派 */
export function shouldNudge(events: SessionEvent[]): boolean {
  const created = events.find((e) => e.type === "session_created");
  if (created && created.type === "session_created" && created.spawnedBy) return false;
  return userTurnsSinceNudge(events) >= MEMORY_NUDGE_EVERY;
}

/** nudge 派活的收口（issue #186）：reviewer 跑完后往父会话落一条配对的
    tool_result——`memory-nudge-<seq>` 这种合成 parentToolCallId 走不到标准工具
    管线，没有这条的话 subagentRowState 永远 working，时间线那张卡永远转圈。
    成功落 ok（output = 汇报），失败落 error 再把错误原样往外抛（调用方负责记
    日志——nudge 是永不抛的外挂，外面本来就包着 catch）。
    这条 tool_result 没有对应的 assistant toolCall，deriveMessages 的孤儿过滤
    会把它挡在投影外——它只喂 UI，不喂模型 */
export async function settleNudgeSpawn(
  deps: { append: (e: NewSessionEvent) => SessionEvent; send: (e: SessionEvent) => void },
  sessionId: string,
  toolCallId: string,
  run: () => Promise<{ report: string }>,
): Promise<void> {
  try {
    const { report } = await run();
    deps.send(deps.append({ sessionId, ts: Date.now(), type: "tool_result", toolCallId, status: "ok", output: report }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.send(deps.append({ sessionId, ts: Date.now(), type: "tool_result", toolCallId, status: "error", output: msg }));
    throw err;
  }
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

/** 拼给 memory-reviewer 的任务字符串：当前 MEMORY/USER，有项目档时再加 PROJECT
    段（带项目根，reviewer 认三档要知道"当前项目"是哪个），最后接对话转写。
    没有项目档（workspace 不在任何 git 仓库里，`mem.projectRoot` 缺席）时不拼
    PROJECT 段落——那时 memory 工具的 target 枚举里也没有 project 这个选项
    （createMemoryTool 的动态枚举），给 reviewer 看一个它写不了的档只会制造困惑。
    三档判据本身是不随会话变的静态事实，写进了 builtinSubagents.ts 的
    instructions；这里只管拼"当次"的内容 */
export function buildReviewerTask(
  mem: { memory: string; user: string; project?: string; projectRoot?: string; topics?: MemoryTopicSnapshot[] },
  transcript: string,
): string {
  const projectBlock = mem.projectRoot
    ? `当前 PROJECT（${mem.projectRoot}）:\n${mem.project || "(空)"}\n\n`
    : "";
  // 主题索引 + 只挑非空桶的正文——同 renderMemoryBlocks 的取舍：空桶已经在
  // 索引里报过「0 条」，再贴一段空正文只会占 reviewer 的上下文
  const topicBlock = mem.topics
    ? `主题索引：\n${renderTopicIndex(topicIndexOf(mem.topics))}\n\n` +
      mem.topics.filter((t) => t.content).map((t) => `当前 TOPIC:${t.slug}（${t.label}）:\n${t.content}\n\n`).join("")
    : "";
  return `当前 MEMORY:\n${mem.memory || "(空)"}\n\n当前 USER:\n${mem.user || "(空)"}\n\n${projectBlock}${topicBlock}最近对话：\n${transcript}`;
}
