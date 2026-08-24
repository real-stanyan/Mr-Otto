// sectionClassifier — 会话目录的分类员。与 visionBridge 严格对称：
// 那个是 turn 前的代读员（图 → 文字），这个是 turn 后的分类员（一段对话 → 章节标题）。
// 两者都住在 engine 外面，engine 只管闭环，不认识这些外挂。
//
// 分类失败是无害的——不落事件而已，下一个 turn 的分类员会看到
// 「最后一条 section_classified 之后的全部事件」，自动把漏掉的那段补进来。
// 自愈，所以刻意不做 429 重试（vision-bridge 必须重试是因为它失败 = turn 失败）。
//
// 模型调用本体在 turnAnnotator.ts（issue #284：与跟进建议合并成一次往返）；
// 这里只剩判定逻辑——跨度锚点、摘要、解析都是纯函数。

import type { SessionEvent } from "../session/events.js";

/** 单条消息进摘要时的截断长度：分类只需要知道在聊什么，不需要读完 */
const PER_MESSAGE_CHARS = 300;
/** 整份摘要上限；超了保留最近的部分（近处的话题才决定当前章节） */
const SUMMARY_CHARS = 4000;
/** 标题上限。提示词要求「不超过 12 个字」，但那只是请求不是约束：便宜模型会跑偏，
    而跨度是把对话原文原样插进提示词的（围栏见 fence()）——对话内容能反过来指挥分类员。
    事件日志是 append-only，一条几 KB 的"标题"落进去就永远改不掉，还要渲染进竖轨。
    截断而不是拒收：标题难看好过整段分区丢掉 */
const TITLE_MAX_CHARS = 40;

/** 当前分区标题 = 日志里最后一个非空 title。没有 = 还没有任何分区 */
export function currentSectionTitle(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "section_classified" && e.title !== null) return e.title;
  }
  return null;
}

/** 未分类跨度 = 最后一条 section_classified 之后的全部事件。
    锚点是分类事件而不是 turn 边界——分类失败时下一次自动把漏掉的那段一并吃进来。

    锚点落在 turn 中间时要往回补（issue #112）：分类是 turn 收口之后异步跑的，
    这期间用户可以再发一条消息。于是分类事件落在了新的 user_message 和它的
    assistant_message 之间，下一段跨度里就只有答案、没有问题——标题从半截对话
    里编。往回找到这个 turn 的开头（那条 user_message）一并带上；锚点前最近的
    是 turn_ended 就说明它不在 turn 中间，原样从锚点后面切。

    代价是那条 user_message 会被分两次看到（上一次分类也看过它）。这是摘要不是
    台账，重复读一句话只影响标题质量的上限，而漏掉问题是必然编错 */
export function unclassifiedSpan(events: SessionEvent[]): SessionEvent[] {
  let anchor = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "section_classified") {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return events;
  for (let i = anchor - 1; i >= 0; i--) {
    const type = events[i]?.type;
    if (type === "turn_ended" || type === "section_classified") break;
    if (type === "user_message") return events.slice(i);
  }
  return events.slice(anchor + 1);
}

/** classifyLogView 需要的最小存储面（EventStore 结构性满足） */
export interface ClassifyLogSource {
  lastSeqOf(sessionId: string, type: SessionEvent["type"], beforeSeq?: number): number;
  load(sessionId: string, opts?: { afterSeq?: number }): SessionEvent[];
  eventsOfType(sessionId: string, type: SessionEvent["type"]): SessionEvent[];
}

/** 分类要看的最小日志切片（issue #279）：等价于全量 load，但只真正读
    「锚点所在 turn 的开头之后的尾段」+「全部 section_classified 事件」。

    为什么这两块就够（对照 unclassifiedSpan / currentSectionTitle 逐条核）：
    - unclassifiedSpan 的锚点 = 最后一条 section_classified，它在尾段里；
      锚点往回补 user_message 的扫描最远走到上一条 turn_ended / section_classified
      就 break——尾段从「锚点前最近的 turn_ended 之后」起读，覆盖了整个扫描范围；
      扫描越过尾段开头时（锚点前没有 turn_ended），退到的是更早的 section_classified，
      break 条件同样成立，结果与全量一致。
    - currentSectionTitle 要的是最后一条**非空标题**的分类事件——它可能在任意早的
      位置（中间隔着一串 title:null 的"延续"），所以全部分类事件都得在场。
      分类事件一个分区才一条，全取也只有几十条。
    还没分过类（锚点不存在）= 未分类跨度就是整段日志，退回全量 load（一次性）。
    等价性由 tests/main/sectionClassifier.test.ts 里的对照测试钉住 */
export function classifyLogView(store: ClassifyLogSource, sessionId: string): SessionEvent[] {
  const anchor = store.lastSeqOf(sessionId, "section_classified");
  if (anchor < 0) return store.load(sessionId);
  const turnEnd = store.lastSeqOf(sessionId, "turn_ended", anchor);
  const tail = store.load(sessionId, { afterSeq: turnEnd });
  const inTail = new Set(tail.map((e) => e.seq));
  // 尾段之外的分类事件 seq 全在 turnEnd 之前，且两边各自升序——直接拼接就有序
  return [...store.eventsOfType(sessionId, "section_classified").filter((e) => !inTail.has(e.seq)), ...tail];
}

/** 把一段事件压成给分类员看的摘要。tool_result 全文不进——
    bash 吐的几万字对"在聊什么"毫无贡献，只会把上下文烧光 */
export function summarizeSpan(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "user_message") {
      lines.push(`用户：${e.content.slice(0, PER_MESSAGE_CHARS)}`);
    } else if (e.type === "assistant_message") {
      const text = e.content.trim();
      if (text) lines.push(`助手：${text.slice(0, PER_MESSAGE_CHARS)}`);
      const tools = (e.toolCalls ?? []).map((c) => c.name);
      if (tools.length > 0) lines.push(`助手调用工具：${tools.join("、")}`);
    } else if (e.type === "skill_invoked") {
      lines.push(`启用 skill：${e.name}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > SUMMARY_CHARS ? joined.slice(-SUMMARY_CHARS) : joined;
}

/** 解析模型回复。模型产出的 JSON 不可信——形状不对就返回 null（同 parseTodoArgs 的态度）。
    hasSection = 当前是否已有分区；没有时模型必须开一个，回延续算解析失败 */
export function parseSectionReply(raw: string, hasSection: boolean): { title: string | null } | null {
  // 便宜模型爱套 ```json 围栏，剥掉再解
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { newSection, title } = parsed as { newSection?: unknown; title?: unknown };
  if (typeof newSection !== "boolean") return null;
  if (!newSection) return hasSection ? { title: null } : null;
  if (typeof title !== "string" || title.trim() === "") return null;
  return { title: title.trim().slice(0, TITLE_MAX_CHARS) };
}
