// dispatchDecision —— 派活（ADR-0270）前置一个决策模型（#1281，spec §5.3 ①）。
//
// 今天那条路：名册编号 + 最近几句 → 便宜 LLM 回编号或 none → 正则抠数字。便宜档是推理
// 模型（8 个 completion token 里 7 个是 reasoning），所以要给 64 token 和 5 秒；none 与
// picked 之间没有可调的量，「通话里闲聊被判 none、整场沉默」那类只能靠加规则兜（ADR-0275）。
//
// 这里换成一次请求里的一组是/否：一个 `act`（这句话是在要求做事吗）+ 每只 agent 一个
// `a<n>`（该它接吗）；群里还有别人时再加一个 `people`（这句话是说给群里某个人的吗，#1405）。
// 同一请求里的问题并行且互相独立，多选 = 多个 noul（官方的写法）；问题多了只多 token 不多
// 时间（#1300 量过）。**键是编号不是名字**——同 ADR-0270：名字不经过模型的嘴。
//
// `people` 单独问、不并进 `act`：「小王，把合同发给客户」是在要求做事（act 高），只是不是
// 要智能体做（people 高）。并成一题的话这句会被判成「不像在要求做事」的普通 none，而通话里
// 普通的 none 要由最近开口的那只应（ADR-0275）——那正是维护者要它闭嘴的那种话。
//
// 校准概率真正值钱的地方是最后一行 `escalate`：有把握的当场判，**拿不准的交给慢而聪明
// 的那条路**，而不是硬猜。所以这一层从不产出 `failed`——没问出来与拿不准都落回今天那条
// LLM 路，由它去说 failed（以及群里那句「没派出去」）。
//
// 只在 daemon.ts 的注入点包一层：sessionService 不认识决策模型（`daemonDecisionWiring`
// 那条断言钉着）。「群里还有谁」由 sessionService 算好放进 `DispatchInput.people`，它自己
// 只多认一格 `none.to`——那是判决的一部分，不是决策模型的知识（#1405）。

import {
  noul, withDecision,
  type DecisionModeState, type DecisionOutcome, type DecisionQuestion, type DecisionReply, type DecisionRequest,
} from "../../../src/shared/decision.js";
import { promptSafe, promptSafeBody } from "../../../src/shared/promptSafe.js";
import {
  DISPATCH_MAX_TARGETS, DISPATCH_PEOPLE_MAX_NAMES, DISPATCH_TEXT_MAX_CHARS,
  type DispatchInput, type DispatchLine, type DispatchVerdict,
} from "./dispatch.js";

// 六个数**全是初值**：前四个是 #1281 拍的，后两个是 #1405 加的；翻成 on 之前用一组带标注的
// 群聊场景离线对拍过一遍（ADR-0328），往后由 `[decision]` 日志里的真实数据改（spec §7）。
/** P(在要求做事) 低于它 = 闲聊 / 应声，没人该接 */
export const DISPATCH_NONE_BELOW = 0.3;
/** 某只的 P(该它接) 到它 = 挑中 */
export const DISPATCH_PICK_AT = 0.6;
/** 没人对得上时，P(在要求做事) 到它才敢归给 fallback 那一只；不到就交给 LLM */
export const DISPATCH_ACT_AT = 0.7;
/** P(说给群里某个人的) 到它 = 那是人和人在说，智能体都不接（#1405）。取高：判错的代价
    不对称——该接没接，人 @ 一下就好；不该接却接了，是插进别人的对话还花群主的额度，
    而通话里这一格还会让「必须有人应」（ADR-0275）破例闭嘴 */
export const DISPATCH_PEOPLE_AT = 0.7;
/** 归 fallback 那一格额外要 P(说给群里某个人的) 低于它（#1405）：「要做事、谁的职责都
    对不上」正是一句布置给人的活的样子，拿不准是不是说给人的就交给 LLM，不硬塞给管理员 */
export const DISPATCH_PEOPLE_CLEAR = 0.3;
/** 上游回 5xx / 429 是立刻回落，只有「挂住不回」才付满这一格。**on 档下人在等它**：
    派活挡着自己那句话出现在群里（ADR-0270），超时之后还要再走今天那条 5 秒的 LLM 路。
    2026-09-28 从真正跑派活的那台 VPS 量（#1405，这天从 Cloudflare 的 AMS 进）：九发
    0.73–1.79s，其中 hold 一趟 ~330ms（#1398 之后），闲 70 秒后的第一发 1.23–1.77s。
    取 2 秒 = 「谁在等」给派活的预算（`tests/edge/decisionUses.test.ts` 那张表），不是按
    分布拍的上沿：分布的尾巴过了这条线就交给 LLM 路，**那一发照样全价计费**（#1303）——
    所以真正让它不常发生的是延迟本身，不是把这个数调大。
    历史：影子期这里是 20 秒（ADR-0301 补记三：shadow 档下没人在等，那是测量窗口）；
    再往前是 1200（9 月 21 日那条路一发 3.5–13.9s，是 100% 超时） */
export const DISPATCH_DECISION_TIMEOUT_MS = 2_000;

/** `recent` 里每句是谁说的，给模型看的那一格（与问题一样用中文） */
const WHO: Record<DispatchLine["kind"], string> = { human: "人", agent: "智能体", system: "系统" };

export function dispatchQuestions(input: DispatchInput): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  // 名字 / 职责 / 发言人过 promptSafe（成员可写的字段，`]` 与换行能撑破结构），正文过
  // promptSafeBody——与 dispatchPrompt 逐字同一套口径；context 是 dispatchContext 的产物，
  // 已经过闸，原样带
  const hasPeople = input.people.count > 0;
  const state = {
    roster: input.roster.map((a, i) => ({
      n: i + 1,
      name: promptSafe(a.name),
      duty: promptSafe(a.description).trim(),
      fallback: a.agentId === input.fallbackAgentId,
    })),
    // 群里没有别人时这一格整个缺席——不给模型一个「那可能是说给人的」的暗示
    ...(hasPeople ? {
      people: {
        count: input.people.count,
        names: input.people.names.map((n) => promptSafe(n).trim()).filter((n) => n !== "").slice(0, DISPATCH_PEOPLE_MAX_NAMES),
      },
    } : {}),
    recent: input.context.map((l) => ({ by: l.by, who: WHO[l.kind], text: l.text })),
    said: { by: promptSafe(input.fromLabel), text: promptSafeBody(input.text.slice(0, DISPATCH_TEXT_MAX_CHARS)) },
  };
  const questions: Record<string, DecisionQuestion> = {
    act: noul(
      "群里有人说了 `said.text` 这句话，没有 @ 任何人。这句话是在要求团队里的智能体做事吗？",
      "是明确要做的事、提出的问题、布置的任务；或者是在回答 `recent` 里某只智能体刚向人提的问题",
      "闲聊、问候、感谢、确认、感叹，或者只是对上一条回复的简单回应、不需要对方继续做事",
    ),
  };
  if (hasPeople) {
    questions.people = noul(
      "群里除了 `roster` 里的智能体，还有别的人（`people`）；说这句话的是 `said.by`。`said.text` 这句话是说给群里的某个人（不是智能体）听的吗？",
      "在跟群里的某个人说话：叫了他的名字、在问他、在回他刚说的话（`recent` 里 `who` 是「人」的那几句），或者是人和人之间的商量、约时间、闲聊",
      "是说给智能体的：让智能体做事、问智能体、回答某只智能体刚提的问题；或者看不出是在对某个人说",
    );
  }
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
  // 问了 `people` 回包里却没有 = 这份回包没答全，整份不认（同 parseDecisionReply 的纪律）
  let people: number | null = null;
  if (input.people.count > 0) {
    const ans = reply.answers.people;
    if (!ans || ans.type !== "noul") return null;
    people = ans.noul;
    scores.people = people;
  }
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
  if (people !== null && people >= DISPATCH_PEOPLE_AT) {
    // 很像是说给群里某个人的（#1405）：没有哪只对得上 = 人和人在说，谁都不接，并记下是
    // 说给人的（通话里「必须有人应」只让这一种闭嘴）；却有一只强烈对得上（「小王你跟开发
    // 一起看下」）= 两个问题各看到了一半，交给读得到整段上下文的那条路
    return { verdict: picks.length > 0 ? "escalate" : { kind: "none", to: "people" }, scores };
  }
  if (act.noul < DISPATCH_NONE_BELOW) {
    // 自相矛盾（不像在要求做事，却有一只强烈对得上）不硬判 none：那多半是一句很短的
    // 回答（「main」），两个问题各看到了一半——交给读得到整段上下文的那条路
    return { verdict: picks.length > 0 ? "escalate" : { kind: "none" }, scores };
  }
  if (picks.length > 0) return { verdict: { kind: "picked", agentIds: picks.map((p) => p.agentId) }, scores };
  // 归 fallback 那一格：要做事、谁的职责都对不上——**而且不像是说给人的**（#1405）。
  // 「小王，把合同发给客户」恰好长这样；拿不准就交给 LLM，不硬塞给管理员
  const notToPeople = people === null || people < DISPATCH_PEOPLE_CLEAR;
  if (act.noul >= DISPATCH_ACT_AT && input.fallbackAgentId !== null && notToPeople) {
    return { verdict: { kind: "picked", agentIds: [input.fallbackAgentId] }, scores };
  }
  return { verdict: "escalate", scores };
}

const show = (v: DispatchVerdict): string =>
  v.kind === "picked" ? `picked:${v.agentIds.join(",")}` : v.kind === "none" && v.to === "people" ? "none:people" : v.kind;

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
