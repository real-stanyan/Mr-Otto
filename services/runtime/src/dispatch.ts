// dispatch —— 不 @ 谁的话，谁的活谁接（#1153，ADR-0269）。
//
// 云会话里人类的一句话没有 @ 任何人时，`say()` 拿网关**最便宜那款**读一遍
// 「名册 + 最近几句 + 这句话」，回「该由哪几只接」；判出来的那几只与人亲手
// @ 的那条走**同一条路**（user_message{mentions} 起 turn，见 sessionService.say）。
// 先例是 ADR-0237 的 Auto（便宜模型先判一手再起 turn）——同样的接线、同样的
// 「判不出来一律回落今天的行为」、同样的「照常记账不做暗扣」。
//
// 这个文件只有纯逻辑（提示词 / 解析 / 上下文）加一次网关调用；**不碰 store，
// 不知道 sessionService 的存在**。谁来调、调完怎么落盘，都在 sessionService
// 那一侧——那边的判据（何时不判、失败回落到哪）见 say() 里的注释。
//
// ## 输出是编号不是名字
//
// 让分类器回「1, 3」而不是「运营, 广告」：名字要经过模型的嘴，一个多字/少字
// 就对不上（「运营」vs「运营组」），而编号是我们自己发下去的、解析只认数字。
// 代价是提示词里多一列编号——可忽略。
//
// ## 「没人对口」有一只兜底
//
// 名册里标着「没人对口的活归它」的那一只（管理员，ADR-0224 给了它 create_agent
// 正是为了这种活）接**明确是活、但谁的职责都对不上**的那种；**闲聊/问候/确认
// 不是活**，分类器回 none，群里没人接——这一条与维护者拍板的口径逐字相同
// （issue #1153）。
//
// ## 认不出来一律 failed，不是默认 none
//
// 同 autoModel 的 parseDifficulty：认不出说明这次分类没成功，该走回落（调用方
// 决定回落成什么），而不是拿一个我们自己编的答案继续往下走。none 只在分类器
// **明确**这么说时成立。

import { ADMIN_AGENT_ID } from "../../../src/shared/workspaceAgents.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../../src/shared/billing.js";
import { promptSafe, promptSafeBody, safeSpeakerLabel } from "../../../src/shared/promptSafe.js";
import type { SessionEvent } from "../../../src/session/events.js";

export interface DispatchCandidate {
  agentId: string;
  name: string;
  /** 一句话职责（AgentSpec.description）。空串照样列，只有名字 */
  description: string;
}

export interface DispatchInput {
  /** 候选名册，顺序即编号（1 起）。调用方给此刻的真名单（降级占位不该进来） */
  roster: readonly DispatchCandidate[];
  /** 「没人对口的活归它」那一只。`null` = 名册里一只都没有 */
  fallbackAgentId: string | null;
  /** 最近几句群里说出口的话，旧在前，已是 `[名字]: 正文` 形状、已截断（dispatchContext 的产物） */
  context: readonly string[];
  /** 这句话是谁说的（显示名，已过 safeSpeakerLabel） */
  fromLabel: string;
  text: string;
}

export type DispatchVerdict =
  /** 该这几只接（按分类器给出的顺序，已去重、封顶） */
  | { kind: "picked"; agentIds: string[] }
  /** 分类器明确说没人该接（闲聊/问候/确认） */
  | { kind: "none" }
  /** 这次分类没成功（网关/超时/认不出）——调用方决定回落成什么 */
  | { kind: "failed"; reason: string };

/** 一句话最多派给几只。分类器挑出更多时**截断不拒绝**：一句话真要三只以上接的
    情形几乎不存在，四只以上几乎必然是分类器过热——而「不是所有 agent 都抢活」
    正是这条能力的全部要求（#1153） */
export const DISPATCH_MAX_TARGETS = 3;
/** 分类器读最近几句。判「这句是不是在回答某只刚才的提问」要有上文，
    但整份日志既贵又没必要——一句话该谁接，八句之内看得出来 */
export const DISPATCH_CONTEXT_LINES = 8;
/** 上下文每句截多长（含 `[名字]: ` 前缀） */
export const DISPATCH_LINE_MAX_CHARS = 240;
/** 这句话本身截多长（同 autoModel 的 CLASSIFY_MAX_CHARS 的理由：判该谁接不需要
    读完整篇，截断同时封住注入面积） */
export const DISPATCH_TEXT_MAX_CHARS = 1200;
/** 分类超时。say() 的回执等这一次判定（消息在判完之后才落盘），所以它必须有
    上限——桌面那侧 15 秒没回执就算「不知道」（ADR-0228），这个数要远小于它 */
export const DISPATCH_TIMEOUT_MS = 5000;
/** 便宜档多是推理模型，思考 token 也算在 completion 里（ADR-0237 真机上 8 个
    completion token 里 7 个是 reasoning）；这里要它回一串编号，给宽一点 */
const DISPATCH_MAX_TOKENS = 64;

/** 「没人对口的活归它」在名册那一行上的标记文案。只挂在 fallback 那一只上 */
const FALLBACK_MARK = "（没人对口的活归它）";

export const DISPATCH_SYSTEM = [
  "你是一个团队群聊的派活分类器。群里有几只智能体，各管一摊。",
  "一个人刚在群里说了一句话，没有 @ 任何人。判断这句话该由哪几只智能体接手。",
  "规则：",
  `- 只挑职责明确对得上的那几只，通常只有一只；最多 ${DISPATCH_MAX_TARGETS} 只。`,
  "- 这句话不是在要求做事（闲聊、问候、感谢、确认、感叹、对上一条回复的简单回应且不需要对方继续做事）→ 回 none。",
  `- 是明确要做的事、但没有任何一只的职责对得上 → 回标着${FALLBACK_MARK}的那一只。`,
  "- 最近的对话里某只智能体刚向人提了问题、这句话是在回答它 → 回那一只。",
  "只回编号（多个用逗号分隔）或 none，不要解释、不要标点。",
].join("\n");

/** user 那一条的正文：名册（编号）+ 最近的对话 + 这句话。名字/职责/发言人过
    promptSafe（它们来自成员可写的字段，`]` 与换行能撑破名册那一行），正文过
    promptSafeBody（换行之后行首的 `[` 失去结构意义，同 deriveMessages 的纪律） */
export function dispatchPrompt(input: DispatchInput): string {
  const roster = input.roster.map((a, i) => {
    const desc = promptSafe(a.description).trim();
    const mark = a.agentId === input.fallbackAgentId ? FALLBACK_MARK : "";
    return `${i + 1}. ${promptSafe(a.name)}${desc ? ` — ${desc}` : ""}${mark}`;
  });
  const context = input.context.length > 0 ? input.context.join("\n") : "（没有更早的对话）";
  const text = promptSafeBody(input.text.slice(0, DISPATCH_TEXT_MAX_CHARS));
  return [
    "智能体：",
    ...roster,
    "",
    "最近的对话：",
    context,
    "",
    `这句话（${promptSafe(input.fromLabel)} 说的）：`,
    text,
  ].join("\n");
}

/** 分类器的回答 → 判决。有数字就按数字（去重、越界丢、封顶）；一个有效编号都
    没有但有数字 = 答案不在名单上 → failed；没数字时只认 none/无/没有 → none；
    其余 failed。**「有数字就按数字」排在 none 之前**：「没有人对口，归 1」这种
    话里数字才是答案 */
export function parseDispatchReply(raw: string, roster: readonly DispatchCandidate[]): DispatchVerdict {
  const nums = (raw.match(/\d+/g) ?? []).map(Number);
  if (nums.length > 0) {
    const ids: string[] = [];
    for (const n of nums) {
      const c = n >= 1 ? roster[n - 1] : undefined;
      if (c && !ids.includes(c.agentId)) ids.push(c.agentId);
    }
    if (ids.length === 0) return { kind: "failed", reason: "分类器回的编号不在名单上" };
    return { kind: "picked", agentIds: ids.slice(0, DISPATCH_MAX_TARGETS) };
  }
  const t = raw.trim().toLowerCase();
  if (/^none\b/.test(t) || /^(无|没有)/.test(t)) return { kind: "none" };
  return { kind: "failed", reason: "分类器没给出可识别的答案" };
}

/** 从日志尾段挑出「群里说出口的话」，旧在前、每句一行、截断。三类：
    - chat_message：`[label]: 正文`（label 过 safeSpeakerLabel——它来自 profiles.name，
      写入侧没有校验，同 deriveMessages 那一处的纪律）；
    - 人的 user_message：正文本来就是 `[label]: text`（say() 拼的），原样；**接力
      开场白（relay）与 engine 注的私话（origin）不算**——前者是写给模型的措辞，
      后者是某只 agent 自己干活过程里的事，都不是群里发生的事（同 cloudTimeline
      的 hiddenFromCloudTimeline 与 agentView 的口径）；
    - 有正文的 assistant_message：`[agent 名]: 正文`；只要了工具没说话的那一轮跳过
      （群里看不见它，分类器也不该看见）。
    每句折成一行（promptSafeBody 之后再折叠空白——顺序不能反，前者要靠换行认
    行首的 `[`），超长截到 DISPATCH_LINE_MAX_CHARS 加省略号 */
export function dispatchContext(events: readonly SessionEvent[], agentName: (agentId: string) => string): string[] {
  const lines: string[] = [];
  for (const e of events) {
    let line: string | null = null;
    if (e.type === "chat_message") {
      line = `[${safeSpeakerLabel(e.label, e.fromUid)}]: ${promptSafeBody(e.content)}`;
    } else if (e.type === "user_message") {
      if (e.relay !== undefined || e.origin !== undefined) continue;
      line = promptSafeBody(e.content);
    } else if (e.type === "assistant_message") {
      if (e.content.trim() === "") continue;
      line = `[${promptSafe(agentName(e.agentId ?? ""))}]: ${promptSafeBody(e.content)}`;
    }
    if (line === null) continue;
    const flat = line.replace(/\s+/g, " ").trim();
    lines.push(flat.length > DISPATCH_LINE_MAX_CHARS ? `${flat.slice(0, DISPATCH_LINE_MAX_CHARS)}…` : flat);
  }
  return lines.slice(-DISPATCH_CONTEXT_LINES);
}

/** 名册里「没人对口的活归它」那一只：管理员（稳定键 `admin`，ADR-0224 的判据），
    名册里没有它才退回第一只（= 改动前「不点名时接话的就是名单第一只」那条老语义
    的落点）。名册为空回 null */
export function dispatchFallbackOf(roster: readonly { agentId: string }[]): string | null {
  return roster.find((a) => a.agentId === ADMIN_AGENT_ID)?.agentId ?? roster[0]?.agentId ?? null;
}

export interface DispatchDeps {
  /** 网关的 `/llm/v1` 前缀（不带尾斜杠） */
  llmBase: string;
  /** 向网关证明身份的那几个头（runtime：`x-runtime-secret` + on-behalf + workspace/session） */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 判不出来时说一声（daemon 的 log）。不抛异常——派活失败不该让发言失败 */
  log?: (msg: string) => void;
}

/**
 * 判一手：拿最便宜那款读名册 + 上下文 + 这句话，回该谁接。
 *
 * **走同一条网关、带同样的归因头**，所以这一次调用照样落 `usage_event`、照样扣
 * 所有者的窗口——不做暗扣（同 ADR-0237 决策 5）。`agentId` 头故意不带：这一次
 * 调用不属于任何一只 agent，`usage_event.agent_id` 空串 = 未归因（ADR-0221）。
 *
 * 任何失败都回 `failed` 不抛：清单/名册为空、网关非 2xx、超时、fetch 抛错、
 * 正文缺席、答案认不出。
 */
export async function requestDispatch(
  deps: DispatchDeps,
  input: DispatchInput,
  models: readonly string[]
): Promise<DispatchVerdict> {
  const failed = (reason: string): DispatchVerdict => {
    deps.log?.(`派活：${reason}`);
    return { kind: "failed", reason };
  };
  if (models.length === 0) return failed("网关没有可用的型号");
  if (input.roster.length === 0) return failed("智能体名单为空");
  const cheap = models[0]!;
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${deps.llmBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...deps.headers },
      body: JSON.stringify({
        model: cheap,
        messages: [
          { role: "system", content: DISPATCH_SYSTEM },
          { role: "user", content: dispatchPrompt(input) },
        ],
        max_tokens: DISPATCH_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return failed(`网关回 ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return failed("分类器没有回正文");
    const verdict = parseDispatchReply(content, input.roster);
    if (verdict.kind === "failed") deps.log?.(`派活：${verdict.reason}（原话：${content.slice(0, 80)}）`);
    return verdict;
  } catch (e) {
    if (controller.signal.aborted) return failed(`分类器超时（${timeoutMs}ms）`);
    return failed((e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** 群里那句系统话：派活没成（网关/超时/认不出/限速/名单读不出来）。人能据此行动
    （@ 一下）——这是它落在群里而不是只进 daemon 日志的理由（同 ADR-0250 的判据）。
    只在**失败**时说；分类器判成「没人该接」不说 */
export function dispatchFailedText(reason: string): string {
  return `这句话没派出去（${reason}），需要谁接的话 @ 一下`;
}

/** daemon 那一侧的接线：替**团队所有者**调网关（同 autoModel.ts 的 `pickAutoModel`
    包装——runtime 唯一独有的一样就是「怎么向网关证明身份」：`x-runtime-secret` +
    on-behalf 头）。归因头带 workspace/session，**不带 agent**：这一次调用不属于任何
    一只 agent（ADR-0221 的「空串 = 未归因」正是给它这种调用留的） */
export interface OwnerDispatchDeps {
  edgeBase: string;
  runtimeSecret: string;
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function requestDispatchAsOwner(
  deps: OwnerDispatchDeps,
  input: DispatchInput,
  models: readonly string[]
): Promise<DispatchVerdict> {
  return requestDispatch(
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
