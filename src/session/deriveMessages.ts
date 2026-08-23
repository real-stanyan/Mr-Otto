// deriveMessages — 从事件日志投影出模型上下文（OpenAI-compatible 消息格式）
// 纯函数：同样的 events 永远得到同样的 messages。resume/fork/replay 全靠它。

import type { SessionEvent, UserTextFile } from "./events.js";
import { barrenEventIndexes } from "./barrenTurns.js";
import { absorbedIndexes } from "./microCompact.js";
import { charCount, MEMORY_LIMITS, parseEntries, formatEntries } from "../shared/memoryStore.js";
import { sanitizeForPrompt } from "../shared/threatPatterns.js";

/** 用户正文 + 文本文件全文拼成模型可见文本。日志里二者分开存
    (content 纯正文,textFiles 结构化)——UI 按结构渲染文件卡片,
    模型上下文用这里拼的全文。拼法唯一出口:投影和 vision-bridge 共用 */
export function composeUserText(content: string, textFiles?: UserTextFile[]): string {
  let full = content;
  for (const f of textFiles ?? []) {
    full += `\n\n[用户附上文件「${f.name}」,内容如下]\n${f.content}`;
  }
  return full;
}

// ─── 目标格式：OpenAI-compatible ChatMessage ───────────────

export interface SystemChatMessage {
  role: "system";
  content: string;
}

/** 围栏 system 消息的正文——投影(下面)和上下文用量估算(shared/contextEstimate)
    共用这一处出口:两边不能各写一份文案,不然"系统提示词占多少"就是猜的 */
export function systemPromptText(workspace: string): string {
  return (
    `你是 otter，一个会使用工具的助手。当前工程文件夹：${workspace}\n` +
    `所有文件读写都发生在这个文件夹内，请使用其中的路径（可用相对路径）。\n` +
    `动手规划一个非平凡任务之前，如果不同的合理理解会导出完全不同的做法，` +
    `先用 ask_user 把关键抉择问清楚，别替用户拍板。\n` +
    STRUCTURED_BLOCKS
  );
}

/** 界面认得的六种结构化围栏。写进提示词而不是留给模型自己发挥：
    界面只认这几种语言 + 这几个字段（渲染在 lib/ottoBlocks.ts 里逐字段校验），
    没写清楚的话模型的每一次即兴发挥都会退回成一段裸 JSON。

    刻意不长：它跟着**每一次**请求走，多一行就是每轮都多付一次。所以只列
    语言名和字段，不给示例、不解释各字段长什么样——字段名自己就是解释。
    也明说"平铺直叙能说清就别用"：这些卡是给真有结构的内容准备的，
    不是给每段话都套一个框。 */
const STRUCTURED_BLOCKS =
  `\n界面能把下面六种围栏渲染成卡片（围栏里只放严格 JSON——键名带双引号，不是 JS 对象字面量；字段不全或写错会原样显示成代码块）：\n` +
  `\`\`\`otto-spec  {title, subtitle?, rows:[{label, value, emphasis?}]} —— 参数表/规格表\n` +
  `\`\`\`otto-compare  {traitLabels:[…], options:[{id, name, headline, traits:[字符串或 false]}], recommendedId, reason} —— 几个方案对比\n` +
  `\`\`\`otto-score  {verdict, total, outOf, criteria:[{label, score, weight, note?}]} —— 打分\n` +
  `\`\`\`otto-flow  {nodes:[{id, label, column, row, state:"done"|"active"|"pending"}], edges:[{from, to}]} —— 步骤流转（column/row 是非负整数格子坐标）\n` +
  `\`\`\`otto-timeline  {events:[{id, when:"past"|"now"|"future", time, title, detail?}]} —— 时间线\n` +
  `\`\`\`otto-job  {title, stages:[{name, weight}], stageIndex, stageProgress, eta} —— 多阶段任务走到哪了（stageProgress 是 0~1）\n` +
  `平铺直叙能说清的就别用；一段话套一个框只是噪音。`;

const MEMORY_RULE = "═".repeat(46);

function memoryBlock(title: string, raw: string, limit: number): string {
  const entries = parseEntries(raw);
  if (entries.length === 0) return "";
  const used = charCount(formatEntries(entries));
  const pct = Math.round((used / limit) * 100);
  const body = formatEntries(sanitizeForPrompt(entries));
  return `${MEMORY_RULE}\n${title} [${pct}% — ${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars]\n${body}\n`;
}

/** memory_loaded 渲成 system 尾部的两块。两个都空 = 空串（投影与无记忆逐字节一致）。
    标题带占用百分比：模型看得见自己还剩多少地方，超限报错时不至于意外 */
export function renderMemoryBlocks(memory: string, user: string): string {
  const m = memoryBlock("MEMORY (your personal notes)", memory, MEMORY_LIMITS.memory);
  const u = memoryBlock("USER (about the user)", user, MEMORY_LIMITS.user);
  if (!m && !u) return "";
  return `\n${m}${u}${MEMORY_RULE}`;
}

/** memory_loaded 事件专属的指引 + 块，一起拼进 system 尾部（ADR-0060）。
    指引文案跟着这条事件走，不写进 systemPromptText：没有这条事件的会话
    （老日志 / 子会话 / 没有记忆能力的装配）不该被告知"你有 memory 工具"——
    那把工具压根没挂给它们，写死在 systemPromptText 里就是一句谎话。
    两个文件都空也要说这段话：模型得知道自己**能**写记忆，不是只在已经有内容时才提 */
export function renderMemoryPrompt(memory: string, user: string): string {
  return (
    `\n你有跨会话的长期记忆（本消息末尾的 MEMORY/USER 块），用 memory 工具维护：记用户偏好、环境细节、工具怪癖、稳定约定，优先记能减少用户再次纠正你的事；` +
    `不记任务进度、PR/issue 号、commit、一周内会过期的东西。` +
    `写陈述句不写祈使句（「用户偏好简短回复」对，「总是简短回复」错——祈使句下次会被当成指令）；流程和步骤归 skill 不归记忆。` +
    renderMemoryBlocks(memory, user)
  );
}

/** 用户消息内容分片(多模态)。image_ref 只带引用——投影是纯函数,不碰磁盘,
    解 bytes 是 adapter 的事(注入的 readAttachment) */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_ref"; id: string; mediaType: string };

export interface UserChatMessage {
  role: "user";
  /** string = 纯文本(老日志/无附件,投影逐字节不变);数组 = 带图片附件 */
  content: string | UserContentPart[];
}

export interface AssistantChatMessage {
  role: "assistant";
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string }; // arguments 是 JSON 字符串（API 规定）
  }[];
}

export interface ToolChatMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ChatMessage =
  | SystemChatMessage
  | UserChatMessage
  | AssistantChatMessage
  | ToolChatMessage;

// ─── 上下文压缩 ────────────────────────────────────────────
// 日志只增不减，全量投影的 token 成本随会话线性涨。压缩住在投影层：
// 确定性纯函数（同 events + 同 opts 永远同输出），所以不需要新事件——
// "模型看到了什么"依旧可从日志推导（硬规则）。若将来引入 LLM 摘要，
// 摘要出自模型、不确定，就必须升级为落盘事件（model-visible means logged）。

export interface CompressionOptions {
  /** 最近几个 turn（以 user_message 为界）原文保真，不动一个字。0 = 无保真区，全部可压 */
  keepRecentTurns: number;
  /** 更老的 turn 里，tool_result 输出超过此字符数则截断 */
  maxOldToolOutputChars: number;
  /** 更老的 turn 里，tool_call 参数（JSON 字符串）超过此字符数则截断。
      write_file 的 content 参数是上下文里另一大肥肉——写 700 字文章，
      这 700 字就永远躺在历史里，每个后续请求都重复计费 */
  maxOldToolArgChars: number;
}

/** engine 用的默认档：改这里 = 改所有会话的压缩行为（值本身是行为的一部分） */
export const DEFAULT_COMPRESSION: CompressionOptions = {
  keepRecentTurns: 2,
  maxOldToolOutputChars: 400,
  maxOldToolArgChars: 400,
};

/** /compact 摘要专用档（ADR-0003）：摘要人只需要"发生了什么"，不需要逐字证据。
    无保真区（整段历史都压），输出上限放宽到 800——防止关键内容只存在于
    工具输出里（assistant 没复述）时被截丢；参数收紧到 200——参数是 agent
    自己生成的，它总会在正文里交代意图，路径开头那截通常就够 */
export const COMPACT_COMPRESSION: CompressionOptions = {
  keepRecentTurns: 0,
  maxOldToolOutputChars: 800,
  maxOldToolArgChars: 200,
};

/** 压缩标记带原始长度：模型知道这里被折叠过，不会被"无声变短的历史"误导。
    刚过上限的文本截断后加上标记反而更长——那种情况原样放行（压缩永不增肥） */
function clip(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max) + `\n…[上下文压缩：${what}原 ${text.length} 字符，仅保留前 ${max} 字符]`;
  return clipped.length < text.length ? clipped : text;
}

/** 老区的长工具参数折叠。
    结果必须仍是**合法 JSON**：OpenAI 方言规定 tool_calls[].function.arguments 是
    一个 JSON 字符串，严格的服务端会当场解析它。把序列化结果从中间砍断，
    换来的是 400 invalid tool call arguments —— 本机 Ollama 就是这么拒的
    （DeepSeek / GLM 恰好容忍，所以这个 bug 藏了很久）。
    所以折叠发生在**值**上，不在序列化结果上：参数名和结构原样保留，
    只截长字符串（write_file 的 content 那种肥肉正是字符串），
    模型读到的历史因此更完整，服务端也解析得动。 */
function clipArgs(args: unknown, max: number): string {
  const full = JSON.stringify(args) ?? "{}";
  if (full.length <= max) return full;

  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    const strings = entries.filter(([, v]) => typeof v === "string").length;
    // 预算按长字符串的个数摊：几个肥字段就各分一份，别让"上限"变成"上限 × 字段数"。
    // 60 是地板——再小就只剩省略标记，模型连参数长什么样都看不出来
    const budget = Math.max(60, Math.floor(max / Math.max(1, strings)));
    const folded = Object.fromEntries(
      entries.map(([k, v]) => [k, typeof v === "string" ? clip(v, budget, `工具参数 ${k} `) : v])
    );
    const out = JSON.stringify(folded);
    if (out.length < full.length) return out;
  }

  // 兜底：参数不是对象，或折叠反而更长。仍旧给一个合法 JSON——
  // 这里宁可丢掉参数内容，也不能丢掉"能被解析"
  return JSON.stringify({ __clipped: `上下文压缩：工具参数原 ${full.length} 字符，已折叠` });
}

/** 找出"保真区"起点：倒数第 keepRecentTurns 个**非空跑** user_message 的下标。
    之前 = 老区（可压缩），之后 = 新区（原文）。user_message 不足 K 个 = 全保真。
    K = 0 特判成 events.length：一个保真 turn 都不留，整段历史都算老区。

    空跑的 user_message（barren.has(i)）不占名额：它压根不进投影，模型没见过它，
    把它当成"最近 K 轮"里的一轮，等于用一次断线重试就把一轮真实对话挤出保真区——
    用户按了两次停止，上一轮的工具输出就被截断了。数名额的尺子必须和投影同一把。 */
function fidelityBoundary(
  events: SessionEvent[],
  keepRecentTurns: number,
  barren: ReadonlySet<number>
): number {
  if (keepRecentTurns <= 0) return events.length;
  let seen = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "user_message" && !barren.has(i) && ++seen === keepRecentTurns) return i;
  }
  return 0;
}

// ─── 悬空工具调用自愈（ADR-0005，保命层）───────────────────
// app 在工具执行中途退出：日志停在 assistant_message(带 toolCalls)，无 tool_result。
// OpenAI 方言要求每个 tool_call 必须有配对的 tool 消息——不补就是非法序列，
// 且那条 assistant_message 永远在历史里：每次投影都 400，会话永久中毒。
// 补在投影层 = 确定性纯函数，与压缩同一法理；老日志任何入口读取都自动痊愈。

/** 合成占位文案按 tool_execution_started（ADR-0004）区分，不含糊 */
function danglingText(started: boolean): string {
  return started
    ? "[执行中断：执行已开始但结果未落盘（app 在执行中退出）。" +
      "世界可能已被部分变更，结果未知，建议检查现场。]"
    : "[执行中断：调用未开始执行就被中断（审批未决或 app 退出）。" +
      "执行器未达，世界未被此调用变更。]";
}

function healDanglingToolCalls(messages: ChatMessage[], startedIds: Set<string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    // 事件有序 → 投影里 tool 回应紧跟在 assistant 之后连成一块
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      const t = messages[j] as ToolChatMessage;
      answered.add(t.tool_call_id);
      out.push(t);
      j++;
    }
    i = j - 1;
    for (const tc of m.tool_calls) {
      if (!answered.has(tc.id)) {
        out.push({ role: "tool", tool_call_id: tc.id, content: danglingText(startedIds.has(tc.id)) });
      }
    }
  }
  return out;
}

// ─── 投影 ──────────────────────────────────────────────────

/** 微压缩摘要消息的文案前缀（ADR-0064）。插入摘要的两处（主循环、尾插）
    共用这一个常量：文案只能有一处出口，不然"投影里到底长什么样"就是猜的 */
const MICRO_SUMMARY_PREFIX = "[对话摘要]\n";

export function deriveMessages(events: SessionEvent[], compression?: CompressionOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // 围栏 system 消息单独记着：context_compacted 清场时它要被抬回来
  let systemMessage: SystemChatMessage | null = null;
  // 压缩只瘦身内容，永不增删消息：tool_call_id 与 assistant.tool_calls 的配对
  // 是 API 协议要求，删一条 tool 消息整个请求就废——结构神圣，内容可瘦。
  // 什么也没产出的 turn 不进上下文(ADR-0042):模型压根没读到过那条消息,
  // 留着只会让每一次重试都把同一句话再囤一份。日志一个字节不改,跳的是投影。
  // 必须先算它：保真区名额也要跳过空跑（见 fidelityBoundary 注释）
  const barren = barrenEventIndexes(events);
  const boundary = compression ? fidelityBoundary(events, compression.keepRecentTurns, barren) : 0;
  // 微压缩（ADR-0064）：最新 micro_compacted 吸收的 assistant/tool 事件不进投影，
  // 在被吸收区之后插一条摘要 assistant 消息。user_message 永不吸收——它们照常
  // 落在各自的位置，摘要读起来就是"这些请求的处理经过"。
  // 规则和用量估算共用 absorbedIndexes：圆环和真实 prompt 一把尺子
  const micro = absorbedIndexes(events);

  for (const [i, event] of events.entries()) {
    if (micro && i === micro.summaryAt) {
      messages.push({ role: "assistant", content: `${MICRO_SUMMARY_PREFIX}${micro.summary}` });
    }
    if (micro?.absorbed.has(i)) continue;
    if (barren.has(i)) continue;
    switch (event.type) {
      case "user_message": {
        // 有图片附件 → parts 数组(text + image_ref);没有 → string 原样,
        // 老日志投影逐字节不变(测试钉住)。附件消息不参与压缩截断:
        // image_ref 本身轻,text 部分是用户原话(压缩层从来不截用户消息)。
        // 文本文件在这拼进正文——模型看全文,UI 看结构(见 composeUserText)
        const text = composeUserText(event.content, event.textFiles);
        messages.push(
          event.attachments && event.attachments.length > 0
            ? {
                role: "user",
                content: [
                  { type: "text", text },
                  ...event.attachments.map((a) => ({
                    type: "image_ref" as const,
                    id: a.id,
                    mediaType: a.mediaType,
                  })),
                ],
              }
            : { role: "user", content: text }
        );
        break;
      }

      case "assistant_message":
        messages.push({
          role: "assistant",
          content: event.content,
          ...(event.toolCalls && event.toolCalls.length > 0
            ? {
                tool_calls: event.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function" as const,
                  // 老区的长参数折叠（write_file 的 content 这种）。折叠在值上做，
                  // 序列化结果必须仍是合法 JSON —— 见 clipArgs
                  function: {
                    name: tc.name,
                    arguments:
                      compression && i < boundary
                        ? clipArgs(tc.args, compression.maxOldToolArgChars)
                        : JSON.stringify(tc.args),
                  },
                })),
              }
            : {}),
        });
        break;

      case "tool_result":
        // ok / error / denied 一视同仁：都是"这个调用的结果"。
        // 老区（保真边界之前）的长输出截断——工具输出是上下文里最肥的部分
        messages.push({
          role: "tool",
          tool_call_id: event.toolCallId,
          content:
            compression && i < boundary
              ? clip(event.output, compression.maxOldToolOutputChars, "工具输出")
              : event.output,
        });
        break;

      case "session_created":
        // 有 workspace → 投影成 system 消息（模型对工作目录的认知来自日志，不是配置）。
        // 没有（旧日志）→ 照旧丢弃，投影结果与从前逐字节一致。
        if (event.workspace) {
          systemMessage = { role: "system", content: systemPromptText(event.workspace) };
          messages.push(systemMessage);
        }
        break;

      case "skill_invoked":
        // 注入为 user 消息，与 compact 摘要同理：中途插 system 各家方言兼容性参差。
        // 位置就是事件位置——skill 在哪条消息前启用，模型就从哪开始看到它
        messages.push({
          role: "user",
          content: `[本轮启用 skill「${event.name}」，以下是它的指令，请在完成任务时遵循]\n${event.content}`,
        });
        break;

      case "image_described":
        // 视觉模型的代读结果,注入为 user 消息(同 skill_invoked:中途插 system
        // 各家方言兼容性参差)。位置就是事件位置——紧贴在它服务的 user_message 之前
        messages.push({
          role: "user",
          content:
            `[以下是随后消息附带图片的解析,由视觉模型 ${event.model} 代读——当前模型不支持直接看图]\n` +
            event.content,
        });
        break;

      case "subagent_briefed":
        // 注入为 user 消息，手法同 skill_invoked（中途插 system 各家方言兼容性参差）。
        // 位置就是事件位置——它是子会话的第 1 条，所以模型开口前先读到自己是谁
        messages.push({
          role: "user",
          content:
            `[你是 subagent「${event.agent}」，以下是你的指令，请在完成任务时遵循。` +
            `本次可用工具：${event.tools.join("、")}]\n${event.instructions}`,
        });
        break;

      case "memory_loaded":
        // 拼进 system 尾部而不是单独一条：① compact 清场时随 system 幸存；
        // ② 放尾部 = volatile tail，前缀缓存只从这里往下失效。
        // 无条件拼（哪怕两个文件都空）：这条事件本身就是"这个装配有记忆能力"的
        // 凭据，指引文案该不该出现只看这条事件在不在，不看内容是不是空的。
        // systemMessage 可能是 null：session_created 没带 workspace（老日志 /
        // 子会话）时上面那个 case 不会造 system 消息，这里就只能悄悄丢掉记忆
        // 提示——不补造一条。主会话的 session_created 总是带 workspace，缺口
        // 只发生在子会话或旧日志上，不影响主线记忆功能。
        if (systemMessage) systemMessage.content += renderMemoryPrompt(event.memory, event.user);
        break;

      case "context_compacted":
        // 摘要替换此前的一切投影：清空重来。两点讲究：
        // ① 围栏 system 消息必须幸存——工作目录认知不能被压掉；
        // ② 摘要注入为 user 消息——中途插 system 各家方言兼容性参差，user 谁都认。
        // 二次 compact 自然复合：第二份摘要清掉的历史里含第一份摘要。
        messages.length = 0;
        if (systemMessage) messages.push(systemMessage);
        messages.push({
          role: "user",
          content: `[上下文已压缩。以下是此前对话的摘要，作为你对这段历史的全部记忆]\n${event.summary}`,
        });
        break;

      case "micro_compacted":
        // 事件本身不投影：它的效果是"吸收集合 + 摘要消息"，位置由 absorbedIndexes
        // 决定（紧跟被吸收区），不是事件落盘的位置（那总在日志尾巴）
        break;

      // 模型不可见的事件：明确丢弃。
      // lifecycle 事件（ADR-0004）是系统事实，不是对话内容——投影必须对它们隐形：
      // 同一段日志加不加 lifecycle 事件，投影结果逐字节一致（有测试钉住）
      case "approval_decision":
      case "model_changed":
      case "session_archived":
      case "session_renamed":
      case "tool_execution_started":
      case "turn_ended":
      // 分区目录是给人的导航，不是对话内容——喂回去只会污染上下文
      case "section_classified":
      // 跟进建议同理：那是给人点的快捷键。喂回去等于让模型读自己上一轮的猜测，
      // 下一轮再基于它猜——建议会自我强化，对话被自己的建议牵着走
      case "suggestions_generated":
      // 派活是给 UI 的路标（点进子会话），不是对话内容。父会话的模型从
      // tool_result 里读汇报就够了，childSessionId 对它毫无意义
      case "subagent_spawned":
      // 记忆维护事件不是对话内容：memory_user_edit 是审计凭据（人手改了记忆文件），
      // memory_nudge 只是计数触发点——两者都不喂回模型
      case "memory_user_edit":
      case "memory_nudge":
        break;
    }
  }

  // summaryAt 可能 === events.length（被吸收区是日志尾巴）——循环里插不到，这里补
  if (micro && micro.summaryAt >= events.length) {
    messages.push({ role: "assistant", content: `${MICRO_SUMMARY_PREFIX}${micro.summary}` });
  }

  const startedIds = new Set(
    events.filter((e) => e.type === "tool_execution_started").map((e) => e.toolCallId)
  );
  return healDanglingToolCalls(messages, startedIds);
}
