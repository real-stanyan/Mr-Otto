// sessionTitler —— 云会话的名字（#1213）。
//
// 建云会话时 `workspace_sessions.title` 写死空串，此后没有任何一处更新它——所以
// 侧栏那一列全是 `displaySessionTitle` 的兜底「新会话」（#925）。本机那条路有
// `session_autotitled`（搭便宜模型的合并调用），云端一条都没有。
//
// 这个文件只有纯逻辑加一次网关调用；**不碰 store，不知道 sessionService 存在**
// （形状逐处抄 dispatch.ts）。谁来调、调完怎么落盘都在 sessionService 那一侧。
//
// ## 三条判据
//
// ① **挂在人类发言之后，不挂在 turn 收口上**：群聊里人可以只跟人说话（解出空名单
//    时只落一条 chat_message，一个 turn 都不起），挂 turn 上那种会话永远不会被命名。
// ② **第 1 条人类发言走首行兜底，不打网关**：与本机那条标题投影同一口径（手动改名 >
//    session_autotitled > 第一条 user_message 首行）。云端 title 是 Supabase 一列、
//    没有这个投影，所以要显式写一次。它同时是模型那条路的降级出口。第一次模型命名
//    排在第 2 条：只有一句「你能听到吗」时模型也只能起个烂名字。
// ③ **重判把当前标题一起给模型**：这是「话题漂了就重命名」不至于让侧栏那行字天天
//    乱变的全部原因——多数轮回 KEEP。不给当前标题、每次重起一个名字的话，同一段
//    对话会因为措辞抖动被反复改名，而「人找不到刚才那条会话」比「名字略旧」贵得多。
//
// 任何失败一律回落「今天的行为」：不改标题（ADR-0237 那条纪律）。

import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../../src/shared/billing.js";
import { promptSafe, promptSafeBody } from "../../../src/shared/promptSafe.js";

/** 模型起的标题最长几个字。侧栏那一行可用宽度约 230px，还要给头像堆和角标让位 */
export const TITLE_MAX_CHARS = 14;
/** 首行兜底截多长。它是原文不是浓缩，给宽一点，由渲染层 truncate 收尾 */
export const TITLE_SEED_MAX_CHARS = 40;
/** 命名超时。它跑在 say() 回执之外（fire-and-forget），但仍要有上限——一个挂着的
    请求会一直占着 owner 的一个并发额度 */
export const TITLE_TIMEOUT_MS = 6000;
/** 隔几条人类发言重判一次 */
export const TITLE_EVERY = 5;
/** 便宜档多是推理模型，思考 token 也算在 completion 里（ADR-0237 真机上 8 个
    completion token 里 7 个是 reasoning）；这里要它回一个短标题，给宽一点 */
const TITLE_MAX_TOKENS = 64;

/** 第 n 条人类发言之后该做什么。判据见文件头 ②：n===1 兜底、n===2 起每 5 条重判 */
export function titleStepFor(n: number): "seed" | "model" | "none" {
  if (n === 1) return "seed";
  if (n >= 2 && (n - 2) % TITLE_EVERY === 0) return "model";
  return "none";
}

/** 首行兜底：取首行、去空白、超长截断。全是空白回空串——调用方据此不写库 */
export function seedTitleFrom(text: string): string {
  const first = (text.split("\n")[0] ?? "").trim();
  if (first === "") return "";
  return first.length > TITLE_SEED_MAX_CHARS ? `${first.slice(0, TITLE_SEED_MAX_CHARS)}…` : first;
}

export const TITLE_SYSTEM = [
  "你在给一个团队群聊的会话起名字。",
  "先看当前标题：如果它仍然说得清这段对话在聊什么，回一个词 KEEP。",
  "只有话题确实换了、当前标题已经对不上了，才回一个新标题。",
  `新标题要求：一行、不超过 ${TITLE_MAX_CHARS} 个字、不加引号、不加标点结尾、不要解释。`,
  "回 KEEP 或新标题，不要回别的。",
].join("\n");

export interface TitleInput {
  /** 此刻的标题；空串 = 还没有 */
  currentTitle: string;
  /** 最近几句群里说出口的话，旧在前（dispatchContext 的产物） */
  context: readonly string[];
}

/** user 那一条的正文。当前标题与对话都过 promptSafe/promptSafeBody——它们来自
    成员可写的字段，换行与 `]` 能撑破结构（同 dispatchPrompt 的纪律） */
export function titlePrompt(input: TitleInput): string {
  const cur = input.currentTitle.trim();
  return [
    `当前标题：${cur === "" ? "（还没有标题）" : promptSafe(cur)}`,
    "",
    "最近的对话：",
    input.context.length > 0 ? input.context.map((l) => promptSafeBody(l)).join("\n") : "（没有更早的对话）",
  ].join("\n");
}

/**
 * 模型的回答 → 新标题；`null` = 不改。
 *
 * **认不出来一律 null**，不是「默认保持」也不是「默认重起」——`null` 的调用方语义
 * 就是「这次没成功，什么都不做」（同 parseDifficulty / parseDispatchReply）。
 */
export function parseTitleReply(raw: string): string | null {
  const first = (raw.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (first === "") return null;
  if (/^keep\b/i.test(first)) return null;
  // 剥常见的包裹符号（模型爱加）：直角引号、书名号、成对的直引号、成对的弯引号。
  // 弯引号（U+201C/U+201D/U+2018/U+2019）用 \u 转义字面量拼、不直接敲字符——上一版
  // 就是敲字符时把这四个抄成了重复的直引号，字符类静默少了一半，vitest 照样全绿
  const stripped = first
    .replace(/^[「『《"'\u201C\u201D\u2018\u2019]+/, "")
    .replace(/[」』》"'\u201C\u201D\u2018\u2019]+$/, "")
    .trim();
  // 只剩标点/空白 = 没有内容。判据是「有没有字母数字或 CJK」，不是长度
  if (!/[\p{L}\p{N}]/u.test(stripped)) return null;
  return stripped.length > TITLE_MAX_CHARS ? stripped.slice(0, TITLE_MAX_CHARS) : stripped;
}

/** 模型起的名字 + 它是哪个模型起的。`session_autotitled.model` 要的就是后者 */
export interface TitleVerdict {
  title: string;
  model: string;
}

export interface TitleDeps {
  /** 网关的 `/llm/v1` 前缀（不带尾斜杠） */
  llmBase: string;
  /** 向网关证明身份的那几个头 */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 判不出来时说一声。不抛异常——命名失败不该让发言失败 */
  log?: (msg: string) => void;
}

/**
 * 拿最便宜那款读「当前标题 + 最近几句」，回新标题或 `null`（不改）。
 *
 * **走同一条网关、带同样的归因头**，所以这一次调用照样落 `usage_event`、照样扣
 * 所有者的窗口——不做暗扣（同 ADR-0237 决策 5）。`agentId` 头故意不带：这一次
 * 调用不属于任何一只 agent（`usage_event.agent_id` 空串 = 未归因，ADR-0221）。
 *
 * 任何失败都回 `null` 不抛：清单为空、网关非 2xx、超时、fetch 抛错、正文缺席。
 */
export async function requestTitle(
  deps: TitleDeps,
  input: TitleInput,
  models: readonly string[]
): Promise<TitleVerdict | null> {
  const fail = (reason: string): null => {
    deps.log?.(`会话命名：${reason}`);
    return null;
  };
  if (models.length === 0) return fail("网关没有可用的型号");
  const cheap = models[0]!;
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TITLE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${deps.llmBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...deps.headers },
      body: JSON.stringify({
        model: cheap,
        messages: [
          { role: "system", content: TITLE_SYSTEM },
          { role: "user", content: titlePrompt(input) },
        ],
        max_tokens: TITLE_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fail(`网关回 ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return fail("模型没有回正文");
    const title = parseTitleReply(content);
    // 型号一起回：`session_autotitled.model` 那一格是**溯源**用的（「这个名字是
    // 哪个模型起的」），写一个我们自己编的常量进去就是句假话
    return title === null ? null : { title, model: cheap };
  } catch (e) {
    if (controller.signal.aborted) return fail(`命名超时（${timeoutMs}ms）`);
    return fail((e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** daemon 那一侧的接线：替**团队所有者**调网关（逐处同 requestDispatchAsOwner——
    runtime 唯一独有的一样就是「怎么向网关证明身份」）。归因头带 workspace/session，
    **不带 agent**：这一次调用不属于任何一只 agent */
export interface OwnerTitleDeps {
  edgeBase: string;
  runtimeSecret: string;
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function requestTitleAsOwner(
  deps: OwnerTitleDeps,
  input: TitleInput,
  models: readonly string[]
): Promise<TitleVerdict | null> {
  return requestTitle(
    {
      llmBase: `${deps.edgeBase}/llm/v1`,
      headers: {
        "x-runtime-secret": deps.runtimeSecret,
        [ON_BEHALF_HEADER]: deps.ownerUid,
        [WORKSPACE_HEADER]: deps.workspaceId,
        [SESSION_HEADER]: deps.sessionId,
      },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    input,
    models
  );
}
