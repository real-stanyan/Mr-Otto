// deriveMessages — 从事件日志投影出模型上下文（OpenAI-compatible 消息格式）
// 纯函数：同样的 events 永远得到同样的 messages。resume/fork/replay 全靠它。

import { isolatedPromptText, type IsolatedWorkspace } from "../shared/sessionWorktree.js";
import type { CloudSessionFacts, MemoryTopicSnapshot, SessionEvent, UserTextFile, WorkspaceMemoryLoadedEvent } from "./events.js";
import { barrenEventIndexes } from "./barrenTurns.js";
import { activeSkills } from "./activeSkills.js";
import { absorbedIndexes } from "./microCompact.js";
import { charCount, MEMORY_LIMITS, parseEntries, formatEntries, tierRuleText, topicRuleText, topicIndexOf } from "../shared/memoryStore.js";
import { renderTopicIndex } from "../shared/memoryTopics.js";
import { WORKSPACE_MEMORY_LIMITS, workspaceTierRuleText } from "../shared/workspaceMemory.js";
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

/** 日志时间戳 → 「今天」(本机时区,YYYY-MM-DD)。
    刻意不读时钟:投影是纯函数,同一份日志必须永远投出同一串字节(硬规则)。
    日期从事件的 ts 推——它本来就在日志里,重放到哪天就是哪天。
    只取到天:系统提示词是缓存前缀,按天变 = 一天失效一次,按 turn 变 = 每轮都白付 */
function dayOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 日志里最后一条事件的日期 —— 投影和用量估算共用同一处口径（两边各算一遍
    就会出现"估算里没有日期那一行、真实请求里有"的偏差）。空日志 = 没有日期 */
export function dayOfLastEvent(events: { ts: number }[]): string | undefined {
  const last = events[events.length - 1];
  return last ? dayOf(last.ts) : undefined;
}

/** 围栏 system 消息的正文——投影(下面)和上下文用量估算(shared/contextEstimate)
    共用这一处出口:两边不能各写一份文案,不然"系统提示词占多少"就是猜的。

    today 缺席 = 不写日期那一行(老调用方/老日志投影逐字节不变)。
    workspaceKind 来自 session_created(#559 后续):"default" = 内置 Default 工作区,
    多注入「打包为项目」引导段;缺席 = 项目会话/旧日志,逐字节不变 */
export function systemPromptText(
  workspace: string,
  today?: string,
  workspaceKind?: "default",
  isolated?: IsolatedWorkspace,
  cloud?: CloudSessionFacts
): string {
  return (
    `你是 Mr. Otto（叫我 Otto），一个会用工具的桌面 agent。当前工程文件夹：${workspace}\n` +
    (today ? `今天是 ${today}（本机时区）。日期以此为准，别按训练截止猜。\n` : "") +
    (workspaceKind === "default" ? PACKAGE_NUDGE : "") +
    // 云会话（issue #833）：不注入的话模型对自己的处境一无所知——不知道
    // 在容器里、不知道对面是一群人、不知道自己的提交推不出去
    (cloud ? CLOUD_SESSION_TEXT : "") +
    // 独立工作副本（issue #641）：不说的话水獭会以为自己在项目本体上，
    // 干完活直接往用户的分支上招呼，而项目本体可能正被另一只水獭占着
    (isolated ? isolatedPromptText(isolated) : "") +
    // 说实话而不是说得更强:read_file/write_file 真被 world 的 fence 圈住(越界抛错),
    // bash 只是把 cwd 设在这儿,cd 出得去(localWorld.ts 开头那句"诚实说明")。
    // 对模型宣布一个代码兑现不了的保证,等于教它在越界时也不必打招呼
    `read_file / write_file 圈在这个文件夹内，越界直接报错；bash 只是把 cwd 设在这里，` +
    `cd 出得去——真要碰文件夹外的东西，先说一声再动。\n` +
    // 审批是用户的决定,不是路障。模型的默认脾气是"换个写法再试一次",
    // 而那正好是审批要拦的事(write_file 被拒 → 改用 bash 写同一个文件)
    `危险操作会弹给用户审批。被拒 = 用户不想让你做这件事：停下来问清楚，` +
    `别换一种写法绕过去。\n` +
    STRUCTURED_BLOCKS
  );
}

/** 云会话（工作区群聊）独有的几件事实（issue #833）。桌面会话没有这段，
    投影逐字节不变——`session_created.cloud` 缺席就不注入。

    为什么这四条、不是更多：每一条都是**模型不知道就会做错事**的那种事实。
    ① 在容器里、工作目录 /work：不说的话它会按桌面的习惯去猜路径；
    ② 群聊 + `[名字]:` 前缀：不说的话它会把别人的发言当成用户对它说的话，
       或者反过来以为每条消息都要回；
    ③ 审批归发起人/所有者：桌面那句「弹给用户审批」在这里字面上不成立
       （屏幕前不止一个人）；
    ④ 推不出去：沙箱的凭据用完即焚（services/runtime/src/sandbox.ts），
       模型干完活习惯性 `git push` 会失败，更糟的是它可能因此以为「提交
       已经安全了」——实际这些提交只活在这个卷里；
    ⑤ 浅克隆（issue #836）：`git log` 只有一条会让它以为这是个新仓库、
       或者以为 blame 坏了。给出解法（`git fetch --unshallow`）而不是
       只说限制——这一条它自己解得开。 */
const CLOUD_SESSION_TEXT =
  `你跑在一台云沙箱容器里（Linux），工具都在容器内执行，工作目录就是上面那个。\n` +
  `这是一条**群聊**会话：工作区的多个成员都能发言，他们的消息以「[名字]: 内容」的形式到你这里；` +
  `@ 你的那条才会触发你的回合，其余的你看得见但不必逐条回应。\n` +
  `危险操作的审批由发起这一轮的人或工作区所有者决定，不是"某个用户"——` +
  `被拒同样是"别做这件事"，别换个写法绕过去。\n` +
  `这个沙箱不允许 git push（拉代码用的凭据用完就烧了）。你的提交只留在这个工作区里，` +
  `别当成"已经推上去了"——需要交付时说一声，让人来决定怎么带出去。\n` +
  `仓库是 \`--depth 1\` 的浅克隆（issue #836：卷没有磁盘配额，历史往往比工作树大一个量级）——` +
  `\`git log\` 只看得到最新一条。真要历史，自己跑 \`git fetch --unshallow\`。\n`;

/** 界面认得的结构化围栏。写进提示词而不是留给模型自己发挥：
    界面只认这几种语言 + 这几个字段（渲染在 lib/ottoBlocks.ts 里逐字段校验），
    没写清楚的话模型的每一次即兴发挥都会退回成一段裸 JSON。

    刻意短：它跟着**每一次**请求走，多一行就是每轮都多付一次。所以只列语言名
    和字段，不给示例、不解释字段长什么样——字段名自己就是解释；每行尾巴留两三个
    字的用途标签（字段形状说不出「这卡什么时候用」，那两个字才是选型依据）。

    瘦身实测（issue #431）：480 条回复里只有 7 条真用了围栏（1.46%），
    而这块说明每轮 222 token。删掉同义反复的长尾巴 + 零使用的 otto-job 之后
    是 170（−24%）——省不到一半，因为大头是字段清单本身，而字段少一个模型就
    开始猜、卡片就退化成裸 JSON。tests 里钉了 180 的预算，别再往回长。**otto-job 只是不再向模型宣传，渲染器仍然认它**——老日志里那些
    卡照常渲染，将来真要用再把它加回这份名单。
    没有走「改成一把 card_schema 工具」那条路（能再省 80%）的理由也在 #431：
    使用率 1.46% 的时候，为它引入「模型忘了调工具、凭记忆写字段」这条新的
    出错路径不划算——而防的正是这件事。 */
const STRUCTURED_BLOCKS =
  `\n界面能把下面五种围栏渲染成卡片（围栏内只放严格 JSON，键名带双引号；字段缺漏或写错会退化成代码块）：\n` +
  `\`\`\`otto-spec  {title, subtitle?, rows:[{label, value, emphasis?}]} —— 规格表\n` +
  `\`\`\`otto-compare  {traitLabels:[…], options:[{id, name, headline, traits:[字符串或 false]}], recommendedId, reason} —— 方案对比\n` +
  `\`\`\`otto-score  {verdict, total, outOf, criteria:[{label, score, weight, note?}]} —— 打分\n` +
  `\`\`\`otto-flow  {nodes:[{id, label, column, row, state:"done"|"active"|"pending"}], edges:[{from, to}]} —— 流程（column/row 非负整数）\n` +
  `\`\`\`otto-timeline  {events:[{id, when:"past"|"now"|"future", time, title, detail?}]} —— 时间线\n` +
  `平铺直叙能说清的就别用。`

/** Default 工作区专属的「打包为项目」引导（#559 后续）。目标用户是第一次用
    AI 智能体的人——不懂「工作区/项目」概念,由模型在产出成形时主动引一把。
    门槛写明(一两个一次性文件别问):不然每个小任务都被问一遍,引导变骚扰。
    共用文件夹那句是防串扰:Default 被所有任务会话共写,report.md 这类通名
    会被下一个任务静默盖掉 */
const PACKAGE_NUDGE =
  `这里是共享的 Default 工作区（侧栏「任务」栏）：用户没为这次对话指定自己的文件夹，` +
  `多半还不熟悉「项目」这个概念。别的任务对话也在这个文件夹里干活：文件名起得能认出` +
  `属于哪个任务（别叫 report.md、output.md 这类通名），要写的路径上已有同名文件时` +
  `先读一眼——不是这次任务的东西就换个名字，别静默覆盖。` +
  `当这次任务的产出已经成形为一个项目——一组相关文件、` +
  `一个会持续迭代的东西——主动问用户要不要把它打包成项目，征得同意后用 package_project ` +
  `工具（它会把文件搬进以项目命名的新文件夹）。解释时用白话，别甩「工作区」「仓库」这类词；` +
  `产出只是一两个一次性文件就别问。\n`;

const MEMORY_RULE = "═".repeat(46);

function memoryBlock(title: string, raw: string, limit: number): string {
  const entries = parseEntries(raw);
  if (entries.length === 0) return "";
  const used = charCount(formatEntries(entries));
  const pct = Math.round((used / limit) * 100);
  const body = formatEntries(sanitizeForPrompt(entries));
  return `${MEMORY_RULE}\n${title} [${pct}% — ${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars]\n${body}\n`;
}

/** memory_loaded 渲成 system 尾部的三块（+ 主题桶第四块）。全空 = 空串
    （投影与无记忆逐字节一致）。标题带占用百分比：模型看得见自己还剩多少地方，
    超限报错时不至于意外。主题桶只渲非空的——空桶已经在索引里列过了，
    这里再放一块空块只会占地方 */
export function renderMemoryBlocks(
  memory: string, user: string, project?: string, topics?: MemoryTopicSnapshot[]
): string {
  const m = memoryBlock("MEMORY (your personal notes)", memory, MEMORY_LIMITS.memory);
  const u = memoryBlock("USER (about the user)", user, MEMORY_LIMITS.user);
  const p = project ? memoryBlock("PROJECT (this project only)", project, MEMORY_LIMITS.project) : "";
  const t = (topics ?? []).map((x) => memoryBlock(`TOPIC:${x.label} (${x.slug})`, x.content, MEMORY_LIMITS.topic)).join("");
  if (!m && !u && !p && !t) return "";
  return `\n${m}${u}${p}${t}${MEMORY_RULE}`;
}

/** memory_loaded 事件专属的指引 + 块，一起拼进 system 尾部（ADR-0060）。
    指引文案跟着这条事件走，不写进 systemPromptText：没有这条事件的会话
    （老日志 / 子会话 / 没有记忆能力的装配）不该被告知"你有 memory 工具"——
    那把工具压根没挂给它们，写死在 systemPromptText 里就是一句谎话。
    两个文件都空也要说这段话：模型得知道自己**能**写记忆，不是只在已经有内容时才提 */
export function renderMemoryPrompt(
  memory: string, user: string, project?: string, projectRoot?: string, topics?: MemoryTopicSnapshot[]
): string {
  const tiers = projectRoot
    ? `记忆分三档：${tierRuleText({ upper: true, projectRoot })}`
    : `记忆分两档（这个工作区不在任何 git 仓库里，没有项目档）：MEMORY 是你的笔记，USER 是关于用户。`;
  // topics 有字段（哪怕空数组）= 这个装配有主题桶；没字段 = 旧日志/没能力，文案逐字节不变
  const topicRule = topics
    ? `另有 TOPIC 主题桶：${topicRuleText({ upper: true })}\n主题索引：\n${renderTopicIndex(topicIndexOf(topics))}\n`
    : "";
  return (
    `\n你有跨会话的长期记忆（本消息末尾的记忆块），用 memory 工具维护：记用户偏好、环境细节、工具怪癖、稳定约定，优先记能减少用户再次纠正你的事；` +
    `不记任务进度、PR/issue 号、commit、一周内会过期的东西。${tiers}` +
    topicRule +
    `过去做过什么、进度到哪、当时怎么决定的——用 session_search 查历史会话。` +
    `写陈述句不写祈使句（「用户偏好简短回复」对，「总是简短回复」错——祈使句下次会被当成指令）；流程和步骤归 skill 不归记忆。` +
    `\n记忆的工作机制（被问到时照实说，别脑补）：会话开始时整份快照注入（就是下面的记忆块），没有按相关性检索；` +
    (projectRoot ? `项目档按当前工作区所属的 git 仓库挑，换项目换一份（worktree 折叠回主仓）；` : ``) +
    `本会话中途写入的下个会话才可见；用户可在设置页查看和手动编辑这几份笔记；` +
    `session_search 查的是历史会话正文，和记忆是分开的两条路。` +
    renderMemoryBlocks(memory, user, project, topics)
  );
}

/** workspace_memory_loaded 专属的指引 + 块（#949）。与 renderMemoryPrompt 分开写而不是加参数：
    云端没有 user/project/topic 三档、没有 session_search、没有「下个会话才可见」（共享档本会话
    中途就会被别的 agent 改，下一 turn 的快照就带上了）——共用一段文案得处处加分支 */
export function renderWorkspaceMemoryPrompt(e: WorkspaceMemoryLoadedEvent): string {
  const s = memoryBlock("SHARED (这个工作区所有智能体共用)", e.shared, WORKSPACE_MEMORY_LIMITS.shared);
  const o = memoryBlock(`OWN (只有「${e.agentName}」看得见)`, e.own, WORKSPACE_MEMORY_LIMITS.own);
  const blocks = s || o ? `\n${s}${o}${MEMORY_RULE}` : "";
  return (
    `\n你有这个工作区里的长期记忆（本消息末尾的记忆块），用 memory 工具维护：记业务口径、数据定义、客户约定、稳定的分工，优先记能减少同事再次纠正你的事；` +
    `不记任务进度、一周内会过期的东西。记忆分两档：${workspaceTierRuleText({ upper: true })}` +
    `写陈述句不写祈使句。` +
    `\n记忆的工作机制（被问到时照实说，别脑补）：每次轮到你发言前整份快照注入（就是下面的记忆块），没有按相关性检索；` +
    `你或别的智能体写入的内容，下一次轮到你时可见；成员可在工作区设置页「记忆」查看和手动编辑。` +
    blocks
  );
}

/** project_instructions 投影成的那条 user 消息的正文——投影(下面)和上下文用量
    估算(shared/contextEstimate)共用这一处出口，同 systemPromptText 的先例：
    两边各写一份文案，"项目指令占多少"就又是猜的（issue #524）。

    每段带来源路径——模型知道"这是哪份文件说的"，与 UI 的 provenance 同源 */
export function projectInstructionsText(segments: { path: string; content: string }[]): string {
  return (
    `[以下是本工作区的项目指令文件，按 root → 工作目录顺序拼接，请在完成任务时遵循]\n` +
    segments.map((seg) => `── 来自 ${seg.path} ──\n${seg.content}`).join("\n\n")
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
  /** **新鲜区**（保真区内）tool_result 输出的字符上限（issue #383，hermes
      spillover 对照的投影级实现）。此前新鲜区完全不设限——bash 自截 8K，但
      read_file/MCP 工具没有任何上限，一条超长输出直接吃穿窗口。日志本就存
      全文（事实不丢，UI 照常整段渲染），折叠住在投影层 = 确定性纯函数，
      可推导性白捡。上限取得远比老区宽：新鲜区是模型正在干活的现场。
      缺席 = 不折叠（旧行为逐字节一致；COMPACT 档无新鲜区用不上它） */
  maxFreshToolOutputChars?: number;
}

/** engine 用的默认档：改这里 = 改所有会话的压缩行为（值本身是行为的一部分） */
export const DEFAULT_COMPRESSION: CompressionOptions = {
  keepRecentTurns: 2,
  maxOldToolOutputChars: 400,
  maxOldToolArgChars: 400,
  maxFreshToolOutputChars: 50_000,
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

/** 拼进方括号头的字段过这一层（#957 B-C1，agent_briefed 的 name / roster）。
    这些字段是**别人写的字**，而 briefing 的头是一段拼出来的结构：一个 `]` 就把
    方括号提前闭合，一个换行就让之后的正文看起来是围栏外的新指令——两样合起来，
    一条职责描述能给每一只别的 agent 的 system 提示追加任意内容。
    换行折成空格、`]` 换成全角 `］`：**替换不是删除**——注入的正文照旧留在头里
    让人看得见（也让日志对得上），只是失去结构意义。写入侧的校验（Task 2 的
    `noNewline` / `collapseWhitespace`）是第一道闸，这一道是第二道：旧日志里
    已经躺着的字段、以及任何绕过写入校验的路径，投影时一律还要过这里。 */
const promptSafe = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/\]/g, "］");

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

export function deriveMessages(
  events: SessionEvent[],
  compression?: CompressionOptions,
  // 压缩只瘦身内容，永不增删消息：tool_call_id 与 assistant.tool_calls 的配对
  // 是 API 协议要求，删一条 tool 消息整个请求就废——结构神圣，内容可瘦。
  // 什么也没产出的 turn 不进上下文(ADR-0042):模型压根没读到过那条消息,
  // 留着只会让每一次重试都把同一句话再囤一份。日志一个字节不改,跳的是投影。
  // 必须先算它：保真区名额也要跳过空跑（见 fidelityBoundary 注释）。
  // 算过的话传进来（issue #277 perf，同 absorbedIndexes 的先例）：engine 每圈
  // 对同一份日志既投影又估占用，barren 不该在同一数组上重算两遍。缺省自算
  barren: ReadonlySet<number> = barrenEventIndexes(events)
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // 「今天」= 日志里最后一条事件的日期(见 dayOf)。空日志没有日期可推,
  // 那条 system 消息也不会被投出来(要 session_created 才有)
  const today = dayOfLastEvent(events);
  // 围栏 system 消息单独记着：context_compacted 清场时它要被抬回来
  let systemMessage: SystemChatMessage | null = null;
  // agent 身份快照（#957 A-3）：同 workspaceMemoryPrompt——最新一条胜出，
  // 主循环结束后拼一次到 system 尾部（见下方）
  let agentBrief: string | null = null;
  // 工作区记忆快照（#949）：最新一条胜出，主循环结束后统一拼一次（见下方）
  let workspaceMemoryPrompt: string | null = null;
  const boundary = compression ? fidelityBoundary(events, compression.keepRecentTurns, barren) : 0;
  // 孤儿 tool_result 过滤（issue #186）：nudge 派活的收口 tool_result
  // （toolCallId = memory-nudge-N）没有对应的 assistant_message.toolCalls，
  // 投影成 tool 消息就是 OpenAI 方言的非法序列（每条 tool 消息前面必须有
  // 带对应 tool_calls 的 assistant 消息）。标准工具管线永远先落 assistant
  // 再落 result，所以这层过滤对既有日志是空操作
  const knownToolCallIds = new Set<string>();
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    for (const tc of e.toolCalls ?? []) knownToolCallIds.add(tc.id);
  }
  // 最后一条非空跑 user_message 的下标（issue #193）：auto-compact 发生在 turn 中途时，
  // 正在处理的请求随历史被折进摘要，摘要模型是否「逐字保留」它不由我们掌控。
  // compact 之后还没有新 user_message（= 被折的就是当前请求）时投影兜底重注原文
  let lastLiveUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "user_message" && !barren.has(i)) { lastLiveUserIdx = i; break; }
  }
  // 微压缩（ADR-0064）：最新 micro_compacted 吸收的 assistant/tool 事件不进投影，
  // 在被吸收区之后插一条摘要 assistant 消息。user_message 永不吸收——它们照常
  // 落在各自的位置，摘要读起来就是"这些请求的处理经过"。
  // 规则和用量估算共用 absorbedIndexes：圆环和真实 prompt 一把尺子
  const micro = absorbedIndexes(events, barren);

  // PostToolUse feedback（issue #350）：日志里 tool_result 存的是原始输出，
  // 模型看到的版本要把钩子反馈包装进去——包装规则在这（投影），事实在
  // tool_hook 事件里，模型视野因此仍可从日志逐字节推导。多条反馈按序拼接
  const feedbackByCall = new Map<string, string[]>();
  for (const e of events) {
    if (e.type !== "tool_hook" || e.action !== "feedback" || e.message === undefined) continue;
    const list = feedbackByCall.get(e.toolCallId) ?? [];
    list.push(e.message);
    feedbackByCall.set(e.toolCallId, list);
  }

  // 插话顺序修复（issue #344）：steer 落盘时工具组可能正开着——日志序是
  // assistant(toolCalls) → user_message(插话) → tool_result…，照事件位置直投就是
  // OpenAI 方言非法序列（tool 消息必须紧跟它的 assistant），自愈层还会误判
  // "组没答完"补出重复占位。修法：组开着（pendingToolIds 非空）时落的用户
  // 消息先攒着，组的结果齐了再进上下文——模型晚一拍看到插话，配对约束不破。
  // 组永远没答完（中断后新 turn / turn_ended）就地冲账，插话不丢
  let pendingToolIds = new Set<string>();
  let deferredUsers: UserChatMessage[] = [];
  const flushDeferred = () => {
    messages.push(...deferredUsers);
    deferredUsers = [];
  };

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
        const target = pendingToolIds.size > 0 ? deferredUsers : messages;
        target.push(
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

      case "chat_message": {
        // 云会话群聊发言（issue #799）：其他成员的话对模型来说就是对话的一部分，
        // 同 user_message 一样要走"组开着就先攒着"的插话修法（同 :433）。
        // 发言人身份靠 label 前缀带出来（发言时快照，改名不追认历史）
        const target = pendingToolIds.size > 0 ? deferredUsers : messages;
        target.push({ role: "user", content: `[${event.label}]: ${event.content}` });
        break;
      }

      case "assistant_message":
        // 上一组若没答完就到此为止（中断后的下一轮）：先把攒着的插话放出来，
        // 别让它们隔着新组越攒越远
        flushDeferred();
        pendingToolIds = new Set((event.toolCalls ?? []).map((tc) => tc.id));
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
        if (!knownToolCallIds.has(event.toolCallId)) break; // 孤儿收口事件（见上）
        {
          // 老区折到 maxOld；新鲜区折到 maxFresh（宽得多，缺席 = 不折）。
          // 折叠标记带原始长度（见 clip）：模型知道被折过、知道原文有多长——
          // 需要完整内容时它可以分段重新获取，而不是被无声变短的输出误导
          const clipped =
            compression && i < boundary
              ? clip(event.output, compression.maxOldToolOutputChars, "工具输出")
              : compression?.maxFreshToolOutputChars !== undefined
                ? clip(event.output, compression.maxFreshToolOutputChars, "工具输出")
                : event.output;
          const fb = feedbackByCall.get(event.toolCallId);
          messages.push({
            role: "tool",
            tool_call_id: event.toolCallId,
            // 反馈包装（issue #350）：模型消费者看到 原始输出 + 钩子反馈；
            // 无反馈时逐字节不变（老日志回归测试的前提）
            content: fb ? `${clipped}\n\n[工具钩子反馈] ${fb.join("\n")}` : clipped,
          });
        }
        pendingToolIds.delete(event.toolCallId);
        if (pendingToolIds.size === 0) flushDeferred(); // 组齐了，攒着的插话跟上
        break;

      case "session_created":
        // 有 workspace → 投影成 system 消息（模型对工作目录的认知来自日志，不是配置）。
        // 没有（旧日志）→ 照旧丢弃，投影结果与从前逐字节一致。
        // 围栏只认第一条（issue #352）：fork 链视图里父的 session_created 之后
        // 还有分支自己那条（fork 标记，带同一个 workspace）——它是元数据，
        // 不是第二道围栏；普通日志只有一条，行为逐字节不变
        if (event.workspace && systemMessage === null) {
          // 「今天」取日志里最后一条事件的日期:直播时就是此刻,重放时就是当时。
          // 不取 session_created 自己的 ts——跨夜的会话会一直以为还是开会话那天
          systemMessage = {
            role: "system",
            content: systemPromptText(event.workspace, today, event.workspaceKind, event.isolated, event.cloud),
          };
          messages.push(systemMessage);
        }
        break;

      case "skill_invoked": {
        // 注入为 user 消息，与 compact 摘要同理：中途插 system 各家方言兼容性参差。
        // 位置就是事件位置——skill 在哪条消息前启用，模型就从哪开始看到它。
        // args 段只在有参数时出现：旧日志（无 args 字段）投影逐字节不变。
        // 组开着时走延后队列（同插话，:389）：模型自取 skill 时这条正好落在
        // tool_call 与 tool_result 之间，直接 push 会插进这一对中间——API 要求
        // tool 结果紧跟发起它的 assistant 消息，夹一条 user 进去就是非法请求
        const target = pendingToolIds.size > 0 ? deferredUsers : messages;
        target.push({
          role: "user",
          content:
            `[本轮启用 skill「${event.name}」${event.args ? `（参数：${event.args}）` : ""}` +
            `，以下是它的指令，请在完成任务时遵循]\n${event.content}`,
        });
        break;
      }

      case "skill_released":
        // 不投影：停用只改台账（activeSkills），已经发出去的那份说明书是历史事实，
        // 不追认、不撤回。效果体现在下一次 compact 清场时不再重注入
        break;

      case "project_instructions":
        // 焊进围栏 system 消息，走记忆那条通道（ADR-0131，issue #527）。
        // 曾经是一条 user 消息，于是 context_compacted 的 `messages.length = 0`
        // 把它扫掉了——压一次之后模型再也看不到 AGENTS.md。项目约定不是历史，
        // 是每轮都该在的围栏；焊进 system 就天然免疫任何清场，而不是往
        // compact 的重注入名单里再加一项（下一个注入类事件还会掉进同一个坑）。
        // 文案出口在 projectInstructionsText——投影和用量估算共用一处。
        //
        // 没有围栏 system 消息时（旧日志缺 workspace / 裸装配）退回 user 消息：
        // 那种日志本来就没有清场保护可言，但"指令进得去上下文"这条不能丢。
        // 与记忆的处理刻意不同——记忆在那种日志里是直接丢的（见 memory_loaded），
        // 因为它是锦上添花；项目指令是任务的前提，宁可退化也不能没有
        if (systemMessage) systemMessage.content += `\n${projectInstructionsText(event.segments)}`;
        else messages.push({ role: "user", content: projectInstructionsText(event.segments) });
        break;

      case "share_grant_note":
        // 焊进围栏 system 尾部，走 project_instructions 同一条通道（issue #788）：
        // compact 清场时随 system 幸存——「借来的工具叫什么名」不是历史，是
        // 每轮都该在的事实。没有围栏 system 时退回 user 消息，理由同项目指令：
        // 它是任务能不能继续的前提，宁可退化不能没有
        if (systemMessage) systemMessage.content += `\n${event.note}`;
        else messages.push({ role: "user", content: event.note });
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

      case "agent_briefed": {
        // **措辞刻意与 subagent 那条不同**：群聊里这只 agent 说的话是说给群里的
        // 人听的，不是交回给谁的返回值。照抄那条会给模型灌一句关于自己身份的假话。
        //
        // 焊进围栏 system 尾部、最新一条胜出（#957 A-3，把 #949 给
        // workspace_memory_loaded 的那份教训套到同族的这条上）。原来是「事件位置
        // 一条 user 消息」，两个后果都是静默的：
        //   ① 改了提示词会再落一条 brief（briefIfNeeded 只看 instructions 变没变），
        //      两条 user 消息叠着 = 模型读到关于「我是谁」的新旧两套口径而不报错；
        //   ② context_compacted 的 `messages.length = 0` 把它扫掉，而它既不在
        //      system 里、也不在 modelContextScan 的幸存名单里——压一次之后这只
        //      agent 就再也不知道自己是谁了。焊进 system 两个后果一起免疫。
        // 排在 workspaceMemoryPrompt **之前**：先知道自己是谁，再读记着的事。
        //
        // 名字/职责一律过 promptSafe（#957 B-C1）：这一段是**拼**出来的，
        // 拼进去的是别人写的字。一个 `）]\n` 就把方括号提前闭合，之后的正文
        // 以「围栏外的指令」身份进每一只别的 agent 的 system 提示。Task 2 那道
        // 写入校验是第一道闸，这一道是结构闸——旧日志里已经躺着的字段绕不过它。
        const others = event.roster.length
          ? `群里还有：${event.roster.map((r) => `${promptSafe(r.name)}（${promptSafe(r.description)}）`).join("、")}。` +
            `要谁搭手就在你的回复里 @ 他的名字。`
          : "";
        const text = `[你是这个工作区里的「${promptSafe(event.name)}」。${others}]\n${event.instructions}`;
        // 没有围栏 system 时（旧日志 / 没带 workspace 的裸装配）退回事件位置那条
        // user 消息 —— 理由同 project_instructions：那种日志本来就没有清场保护
        // 可言，但「我是谁」是这只 agent 能不能开口的前提，宁可退化不能没有
        if (systemMessage) agentBrief = `\n${text}`;
        else messages.push({ role: "user", content: text });
        break;
      }

      case "memory_loaded":
        // 拼进 system 尾部而不是单独一条：① compact 清场时随 system 幸存；
        // ② 放尾部 = volatile tail，前缀缓存只从这里往下失效。
        // 无条件拼（哪怕两个文件都空）：这条事件本身就是"这个装配有记忆能力"的
        // 凭据，指引文案该不该出现只看这条事件在不在，不看内容是不是空的。
        // systemMessage 可能是 null：session_created 没带 workspace（老日志 /
        // 子会话）时上面那个 case 不会造 system 消息，这里就只能悄悄丢掉记忆
        // 提示——不补造一条。主会话的 session_created 总是带 workspace，缺口
        // 只发生在子会话或旧日志上，不影响主线记忆功能。
        if (systemMessage) systemMessage.content += renderMemoryPrompt(event.memory, event.user, event.project, event.projectRoot, event.topics);
        break;

      case "workspace_memory_loaded":
        // 最新一条胜出（#949）：一条云会话里一只 agent 会落多条快照（共享档被别人改过就再落一条）。
        // 不在这里直接 += ——那样两条快照就是两个 SHARED 块叠在 system 里，模型读到新旧两套口径。
        // 记下来，主循环结束后拼一次；拼在尾部 = volatile tail，同 memory_loaded 的前缀缓存理由
        workspaceMemoryPrompt = renderWorkspaceMemoryPrompt(event);
        break;

      case "context_compacted":
        // 摘要替换此前的一切投影：清空重来。两点讲究：
        // ① 围栏 system 消息必须幸存——工作目录认知不能被压掉；
        // ② 摘要注入为 user 消息——中途插 system 各家方言兼容性参差，user 谁都认。
        // 二次 compact 自然复合：第二份摘要清掉的历史里含第一份摘要。
        messages.length = 0;
        // 清场连攒着的插话一起清：compact 只发生在组与组之间（engine 在
        // compacting 期间拒 steer），真走到这说明它们已在被替换的历史里
        deferredUsers = [];
        pendingToolIds = new Set();
        if (systemMessage) messages.push(systemMessage);
        messages.push({
          role: "user",
          content: `[上下文已压缩。以下是此前对话的摘要，作为你对这段历史的全部记忆]\n${event.summary}`,
        });
        // 已启用的 skill 随清场重注入（issue #214，ADR-0066）：摘要之后、当前请求
        // 之前——模型先读说明书再读任务，与首次注入的次序一致。台账语义（启用过=
        // 仍然生效、按名去重、空跑不算）在 activeSkills.ts，与 subagent 下发共用一份
        for (const [name, s] of activeSkills(events, barren, i)) {
          messages.push({
            role: "user",
            content:
              `[skill「${name}」${s.args ? `（参数：${s.args}）` : ""}在压缩前已启用，仍然生效` +
              `——以下是它的指令，请继续遵循]\n${s.content}`,
          });
        }
        // 当前请求兜底（issue #193）：compact 之后没有更新的 user_message =
        // 被折进摘要的最后一条 user 就是正在处理的请求。原文重注，不再单靠
        // 提示词求摘要模型逐字保留。只重注正文——textFiles 是把上下文撑爆的
        // 主力之一，跟着回来等于压缩白做
        if (lastLiveUserIdx >= 0 && lastLiveUserIdx < i) {
          const u = events[lastLiveUserIdx]!;
          if (u.type === "user_message") {
            messages.push({ role: "user", content: `[当前请求（压缩前最后一条用户消息，原文）]\n${u.content}` });
          }
        }
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
      case "session_unarchived":
      case "session_renamed":
      case "tool_execution_started":
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
      // 自动命名的标题是给人看的侧栏/岛上名字，不是对话内容（同 section_classified）
      case "session_autotitled":
      // 主题分类 / 手动归类同理：给侧栏分组用的标签，不是对话内容（#846）
      case "session_topic_assigned":
      case "session_topic_set":
      // 请求信封（issue #383）是 log-only 审计快照：它记录"模型看到了什么"，
      // 自己绝不能成为模型看到的东西（喂回去 = 信封套信封，永动机）
      case "request_envelope":
      // 云会话群聊审批请求（issue #799）：给 UI/其他在线成员看的广播事实，
      // 结果体现在配对的 approval_decision/tool_result 里，同 approval_decision
      // 一样模型不直接消费
      case "approval_request":
      // 按人头计的 token 用量（issue #799）：计费审计凭据，不是对话内容
      case "model_usage":
      // 接力棒本身不投影（#950，spec §8）：模型可见的那一面是配对的、带 relay
      // 字段的 user_message（照普通用户消息投影），这条事件只是给 UI/接力判据
      // 看的路标——谁传给了谁、第几棒，喂回模型等于让它读一句关于自己身份的元话
      case "agent_relay":
        break;

      // 钩子干预事件本身不直接投影（issue #350）：pre/block 与 post/reject 的
      // 模型可见面已在配对的 tool_result 里；post/feedback 的包装在上面的
      // tool_result case 读 feedbackByCall 完成
      case "tool_hook":
        break;

      case "turn_ended":
        // lifecycle 事件本身不投影（同上），但 turn 收口 = 工具组不可能再答完：
        // 攒着的插话就地放出（缺失的 tool 回应由自愈层补占位，顺序仍合法）
        flushDeferred();
        pendingToolIds = new Set();
        break;
    }
  }
  flushDeferred(); // 日志停在组中间（app 退出/正在跑）：插话不丢

  // agent 身份块拼在 system 末尾（#957 A-3），**排在工作区记忆之前**：
  // 先知道自己是谁，再读记着的事。systemMessage 为 null 时上面那个 case 已经
  // 退回 user 消息了，这里不会有值
  if (systemMessage && agentBrief) systemMessage.content += agentBrief;
  // 工作区记忆块拼在 system 末尾（#949）。systemMessage 为 null（旧日志 / 没带 workspace）时静默不补造，同 memory_loaded
  if (systemMessage && workspaceMemoryPrompt) systemMessage.content += workspaceMemoryPrompt;

  // summaryAt 可能 === events.length（被吸收区是日志尾巴）——循环里插不到，这里补
  if (micro && micro.summaryAt >= events.length) {
    messages.push({ role: "assistant", content: `${MICRO_SUMMARY_PREFIX}${micro.summary}` });
  }

  const startedIds = new Set(
    events.filter((e) => e.type === "tool_execution_started").map((e) => e.toolCallId)
  );
  return healDanglingToolCalls(messages, startedIds);
}
