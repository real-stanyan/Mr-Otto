// sectionClassifier — 会话目录的分类员。与 visionBridge 严格对称：
// 那个是 turn 前的代读员（图 → 文字），这个是 turn 后的分类员（一段对话 → 章节标题）。
// 两者都住在 engine 外面，engine 只管闭环，不认识这些外挂。
//
// 永不抛：分类失败是无害的——不落事件而已，下一个 turn 的分类员会看到
// 「最后一条 section_classified 之后的全部事件」，自动把漏掉的那段补进来。
// 自愈，所以刻意不做 429 重试（vision-bridge 必须重试是因为它失败 = turn 失败）。

import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import { findModel } from "../shared/modelCatalog.js";
import type { SessionEvent, TokenUsage } from "../session/events.js";

/** 分类员型号：目录里的免费款。换分类员改这一行 */
export const SECTION_MODEL = "glm-4.5-flash";

/** 单条消息进摘要时的截断长度：分类只需要知道在聊什么，不需要读完 */
const PER_MESSAGE_CHARS = 300;
/** 整份摘要上限；超了保留最近的部分（近处的话题才决定当前章节） */
const SUMMARY_CHARS = 4000;
/** 标题上限。提示词要求「不超过 12 个字」，但那只是请求不是约束：便宜模型会跑偏，
    而跨度是把对话原文夹在 --- 里直接插进提示词的——对话内容能反过来指挥分类员。
    事件日志是 append-only，一条几 KB 的"标题"落进去就永远改不掉，还要渲染进竖轨。
    截断而不是拒收：标题难看好过整段分区丢掉 */
const TITLE_MAX_CHARS = 40;
/** 分类的超时上限。openaiCompatible 走裸 fetch，本身没有任何超时——
    一条卡死的 TCP 连接会让这次 await 永远不回来 */
const CLASSIFY_TIMEOUT_MS = 20_000;

/** 当前分区标题 = 日志里最后一个非空 title。没有 = 还没有任何分区 */
export function currentSectionTitle(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "section_classified" && e.title !== null) return e.title;
  }
  return null;
}

/** 未分类跨度 = 最后一条 section_classified 之后的全部事件。
    锚点是分类事件而不是 turn 边界——分类失败时下一次自动把漏掉的那段一并吃进来 */
function unclassifiedSpan(events: SessionEvent[]): SessionEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "section_classified") return events.slice(i + 1);
  }
  return events;
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

function buildPrompt(currentTitle: string | null, span: string): string {
  return (
    "你在为一个 AI 助手会话维护「章节目录」，供用户在长对话里快速跳转。\n" +
    (currentTitle === null
      ? "当前还没有任何章节，所以这段内容必须开一个新章节。\n"
      : `当前章节标题：「${currentTitle}」\n`) +
    "以下是当前章节之后新增的对话：\n---\n" +
    span +
    "\n---\n" +
    "判断：新增内容还属于当前章节，还是话题/任务已经换了、该开新章节？\n" +
    "只回 JSON，不要解释，不要围栏：{\"newSection\": true 或 false, \"title\": \"新章节标题\"}\n" +
    "newSection 为 false 时 title 给空串。标题用名词短语，不超过 12 个字，" +
    "写具体在做什么（如「修登录超时」），别写「用户提问」这种废话。"
  );
}

/** 跑一次分类。失败一律返回 null（永不抛）——目录是锦上添花，不能拖垮 turn */
export async function classifySection(
  events: SessionEvent[]
): Promise<{ title: string | null; model: string; usage?: TokenUsage } | null> {
  const span = unclassifiedSpan(events);
  const summary = summarizeSpan(span);
  if (summary.trim() === "") return null; // 空跨度：没内容可分，别浪费一次调用

  const choice = findModel(SECTION_MODEL);
  if (!choice) return null;
  // 目录里的 GLM 没有内置凭据（不像 deepseek 有网关兜底，modelRoute 只放行 deepseek）。
  // 没配 key 就别出门：空 Bearer 是每个 turn 一次必 401 的往返，白烧一次连接
  const apiKey = process.env[choice.apiKeyEnv] ?? "";
  if (apiKey === "") return null;

  try {
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
      apiKey,
      model: choice.model,
      vision: false,
      // 分类员只要一句标题，思考过程一个字都用不上，但 glm-4.5-flash 的
      // thinking 默认档是「开」——实测为「用户问候」四个字烧掉 1452 个
      // completion token（约 20 倍）。显式关掉。
      // 挡位现在是型号的属性（ADR-0031，shared/thinking.ts）：方言从目录里查，
      // 别自己拍一个——给 GLM 发 reasoning_effort 是发给一个不认识它的 API
      thinking: { mode: "off", wire: choice.thinking.wire },
    });
    const currentTitle = currentSectionTitle(events);
    // 非流式、不带工具：分类没有直播价值，结果整段用。
    // 带超时信号：调用方在 turn 的收尾路径上等这个 await，卡死就是会话永久卡死
    const reply = await adapter.chat(
      [{ role: "user", content: buildPrompt(currentTitle, summary) }],
      undefined,
      undefined,
      AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
    );
    const parsed = parseSectionReply(reply.content, currentTitle !== null);
    if (!parsed) return null;
    return {
      title: parsed.title,
      model: SECTION_MODEL,
      ...(reply.usage ? { usage: reply.usage } : {}),
    };
  } catch {
    // key 无效 / 限流 / 断网 / 超时（AbortError）：全都无害。不落事件，下次自愈
    return null;
  }
}
