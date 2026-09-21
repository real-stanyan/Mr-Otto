// dispatchDecision —— 派活（ADR-0270）前置一个决策模型（#1281，spec §5.3 ①）。
//
// 今天那条路：名册编号 + 最近几句 → 便宜 LLM 回编号或 none → 正则抠数字。便宜档是推理
// 模型（8 个 completion token 里 7 个是 reasoning），所以要给 64 token 和 5 秒；none 与
// picked 之间没有可调的量，「通话里闲聊被判 none、整场沉默」那类只能靠加规则兜（ADR-0275）。
//
// 这里换成一次请求里的 N+1 个是/否：一个 `act`（这句话是在要求做事吗）+ 每只 agent 一个
// `a<n>`（该它接吗）。同一请求里的问题并行且互相独立，多选 = 多个 noul（官方的写法）。
// **键是编号不是名字**——同 ADR-0270：名字不经过模型的嘴。
//
// 校准概率真正值钱的地方是最后一行 `escalate`：有把握的当场判，**拿不准的交给慢而聪明
// 的那条路**，而不是硬猜。所以这一层从不产出 `failed`——没问出来与拿不准都落回今天那条
// LLM 路，由它去说 failed（以及群里那句「没派出去」）。
//
// 只在 daemon.ts 的注入点包一层：sessionService 的 say() 分支一个字不动，通话里的特例
// （只有一只时不问分类器、none/failed 落到最近开口的那只，ADR-0275）原样生效。这同时是
// 与 #1280 的约定——那条 lane 要动群聊的形状，这边只换分类器那一格。

import {
  noul, withDecision,
  type DecisionModeState, type DecisionOutcome, type DecisionQuestion, type DecisionReply, type DecisionRequest,
} from "../../../src/shared/decision.js";
import { promptSafe, promptSafeBody } from "../../../src/shared/promptSafe.js";
import { DISPATCH_MAX_TARGETS, DISPATCH_TEXT_MAX_CHARS, type DispatchInput, type DispatchVerdict } from "./dispatch.js";

// 四个数**全是初值**，由影子期 `[decision]` 日志里的校准数据改（spec §7）。
/** P(在要求做事) 低于它 = 闲聊 / 应声，没人该接 */
export const DISPATCH_NONE_BELOW = 0.3;
/** 某只的 P(该它接) 到它 = 挑中 */
export const DISPATCH_PICK_AT = 0.6;
/** 没人对得上时，P(在要求做事) 到它才敢归给 fallback 那一只；不到就交给 LLM */
export const DISPATCH_ACT_AT = 0.7;
/** 上游回 5xx / 429 是立刻回落，只有「挂住不回」才付满这一格。
    **这 20 秒是影子期的测量窗口，不是生产值**（ADR-0301 补记三 / #1300）。三步：
    ① 2026-09-21 真机量出来，派活真正跑的那条路（runtime 在 VPS 上，Cloudflare 的 HEL
       colo）是 3.5–13.9s（一发 55.7s），而原来这里是 1200 —— 在那里不是偏紧，是 100%
       超时，调到 2000 / 3000 / 5000 一样是 100%。病根不在这个数（不碰上游的
       `/billing/v1/me` 在那条路上就要 3.65s，在维护者的 Mac 上只要 0.35s），在 #1304。
    ② 而 #1303 说超时中断的那一发**照样全价计费**。两条叠起来：在 `shadow` 档下那一行
       `[decision]` 日志的 `ms` 每次都停在 abort 上 —— **一个常数不是分布**，钱却照付。
    ③ 所以放宽它：`shadow` 档下**没有任何人在等这一发**（`withDecision` 不 await 它，
       legacy 说了算），这个数在那一档里只决定「多久之后放弃记录」。同一笔钱因此换来
       真实延迟分布 + 真实判决 —— 正是 #1300 在等的那份数据，也是 ADR-0299 §7 要的
       一致率与校准。取 20s 不取无上限：观测到的主体在 13.9s 以内，55.7s 那一发按右截断
       读就够，而这一发是个游离的 fetch，不该无限期挂着。
    **翻成 `on` 之前必须重新挑这个数** —— 那一档里人是真的在等（派活挡着自己那句话出现
    在群里），20 秒会变成每条消息先干等 20 秒再走今天那条 5 秒的 LLM 路。这条不靠人记住：
    `tests/edge/decisionUses.test.ts` 里两条断言兜着（一条拦 `on` 本身，一条在 `on` 那天
    接上，按「谁在等」的预算卡上限） */
export const DISPATCH_DECISION_TIMEOUT_MS = 20_000;

export function dispatchQuestions(input: DispatchInput): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  // 名字 / 职责 / 发言人过 promptSafe（成员可写的字段，`]` 与换行能撑破结构），正文过
  // promptSafeBody——与 dispatchPrompt 逐字同一套口径；context 是 dispatchContext 的产物，
  // 已经是 `[名字]: 正文` 的安全形状，原样带
  const state = {
    roster: input.roster.map((a, i) => ({
      n: i + 1,
      name: promptSafe(a.name),
      duty: promptSafe(a.description).trim(),
      fallback: a.agentId === input.fallbackAgentId,
    })),
    recent: [...input.context],
    said: { by: promptSafe(input.fromLabel), text: promptSafeBody(input.text.slice(0, DISPATCH_TEXT_MAX_CHARS)) },
  };
  const questions: Record<string, DecisionQuestion> = {
    act: noul(
      "群里有人说了 `said.text` 这句话，没有 @ 任何人。这句话是在要求团队里的智能体做事吗？",
      "是明确要做的事、提出的问题、布置的任务；或者是在回答 `recent` 里某只智能体刚向人提的问题",
      "闲聊、问候、感谢、确认、感叹，或者只是对上一条回复的简单回应、不需要对方继续做事",
    ),
  };
  input.roster.forEach((_a, i) => {
    const n = i + 1;
    questions[`a${n}`] = noul(
      `\`said.text\` 这句话该由 \`roster\` 里 n=${n} 的那只智能体接手吗？`,
      "它的职责（duty）明确对得上这件事；或者 `recent` 里它刚向人提了问题，而这句话是在回答它",
      "它的职责对不上这件事，或者这句话根本不是在要求做事",
    );
  });
  return { state, questions };
}

export function verdictFromScores(
  reply: DecisionReply,
  input: DispatchInput,
): { verdict: DispatchVerdict | "escalate"; scores: Record<string, number> } | null {
  const act = reply.answers.act;
  if (!act || act.type !== "noul") return null;
  const scores: Record<string, number> = { act: act.noul };
  const ranked: { agentId: string; p: number; i: number }[] = [];
  input.roster.forEach((a, i) => {
    const ans = reply.answers[`a${i + 1}`];
    if (!ans || ans.type !== "noul") return;
    scores[`a${i + 1}`] = ans.noul;
    ranked.push({ agentId: a.agentId, p: ans.noul, i });
  });
  const picks = ranked
    .filter((r) => r.p >= DISPATCH_PICK_AT)
    .sort((x, y) => y.p - x.p || x.i - y.i)
    .slice(0, DISPATCH_MAX_TARGETS);
  if (act.noul < DISPATCH_NONE_BELOW) {
    // 自相矛盾（不像在要求做事，却有一只强烈对得上）不硬判 none：那多半是一句很短的
    // 回答（「main」），两个问题各看到了一半——交给读得到整段上下文的那条路
    return { verdict: picks.length > 0 ? "escalate" : { kind: "none" }, scores };
  }
  if (picks.length > 0) return { verdict: { kind: "picked", agentIds: picks.map((p) => p.agentId) }, scores };
  if (act.noul >= DISPATCH_ACT_AT && input.fallbackAgentId !== null) {
    return { verdict: { kind: "picked", agentIds: [input.fallbackAgentId] }, scores };
  }
  return { verdict: "escalate", scores };
}

const show = (v: DispatchVerdict): string => (v.kind === "picked" ? `picked:${v.agentIds.join(",")}` : v.kind);

export function dispatchVia(o: {
  mode: DecisionModeState;
  /** 网关此刻供的决策型号；null = 不供（那就只走 LLM） */
  model: string | null;
  input: DispatchInput;
  decide: (req: DecisionRequest) => Promise<DecisionReply | null>;
  llm: () => Promise<DispatchVerdict>;
  log?: (line: string) => void;
}): Promise<DispatchVerdict> {
  return withDecision<DispatchVerdict>({
    use: "dispatch",
    mode: o.mode,
    viaDecision: async (): Promise<DecisionOutcome<DispatchVerdict>> => {
      // 名册为空不在这里说 failed：那句话（以及群里那一声）归 LLM 那条路说
      if (o.model === null || o.input.roster.length === 0) return null;
      const { state, questions } = dispatchQuestions(o.input);
      const reply = await o.decide({ model: o.model, use: "dispatch", state, questions });
      if (reply === null) return null;
      const r = verdictFromScores(reply, o.input);
      if (r === null) return null;
      return r.verdict === "escalate" ? { escalate: true, scores: r.scores } : { value: r.verdict, scores: r.scores };
    },
    viaLegacy: o.llm,
    show,
    ...(o.log ? { log: o.log } : {}),
  });
}
