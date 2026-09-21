// decision —— 决策模型（Jev）的三端共用纯层（#1281，spec 2026-09-20）。
//
// Otto 里有五处拿便宜聊天模型当分类器：写一段「只回一个词」的提示词，再用正则去认它
// 回了什么。决策模型是为这个形状造的——收 `state` + 一组类型化问题，一次前向回
// 类型化答案 + 校准概率，不生成文字。这份文件是桌面主进程 / runtime / edge 三端共用的
// 那一层（同 wire.ts / billing.ts 的纪律：线上形状抄第二份那天不会有任何一处报错）。
//
// 三条纪律，五处都靠它们成立：
//   ① **判不出来一律回落到今天的行为**。这里是两层：决策模型没答案 → 今天那条 LLM 路；
//      LLM 路再失败 → 今天的 null / failed。`requestDecision` 因此**从不抛**，只回 null。
//   ② **不信上游的「0% 类型错误」，自己验一遍**（`parseDecisionReply`）：问了的每一题
//      都要有答案、类型对得上、概率在 [0,1]、choice 回的那一项必须是我们给过的选项。
//      任何一处不对**整份**回 null——挑着用等于让一份坏回包里碰巧对的那半去做决定。
//   ③ **概率模型只许加严，不许放行**：这一层不给审批 / gitSafety / 沙箱免审用。
//
// 线上形状对过 TypeSafe 官方 API 文档与 OpenRouter 官方 SDK 文档（`Alpha.Decisions`）。
// 两家同形，OpenRouter 的差别三处：noul 的 criteria 一旦出现就必须 true/false 两格齐全
// （所以 `noul()` 的签名不给省略的机会）、回包是超集（多 id / provider / usage.cost）、
// 上下文 32k。

export const DECISION_USES = ["dispatch", "auto", "title", "endpoint", "memory"] as const;
/** 哪一处在问。网关按它查开关（没开的一个上游字节都不发），日志按它分桶 */
export type DecisionUse = (typeof DECISION_USES)[number];
/** 开着的两档。`shadow` = 今天那条路说了算，决策模型并行问一次、只记对照日志 */
export type DecisionMode = "shadow" | "on";
export type DecisionModeState = "off" | DecisionMode;
/** edge 下发的开关表。**没列 = 关**，所以初始的 `{}` 就是五处全关 */
export type DecisionUses = Partial<Record<DecisionUse, DecisionMode>>;

export const isDecisionUse = (v: unknown): v is DecisionUse =>
  typeof v === "string" && (DECISION_USES as readonly string[]).includes(v);
export const isDecisionMode = (v: unknown): v is DecisionMode => v === "shadow" || v === "on";

export interface NoulQuestion { type: "noul"; instructions: string; criteria: { true: string; false: string } }
export interface ChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
/** 只有线上类型、不给构造函数：五处一处都用不到，但网关是通用的门，回包校验要认得它 */
export interface ScoreQuestion { type: "score"; instructions: string; criteria: string[] }
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type DecisionState = string | Record<string, unknown> | unknown[];

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreAnswer { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** 客户端 → 网关的请求体。`use` 只到网关为止（查开关用），不发给上游 */
export interface DecisionRequest {
  model: string;
  use: DecisionUse;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
}
export interface DecisionReply {
  /** 真正作答的那个版本（上游报的，例如 `jev-1.13.0`）——阈值是对着某个版本调的，日志里要留 */
  model: string;
  answers: Record<string, DecisionAnswer>;
  /** `parseDecisionReply` 从上游 `usage.input_tokens` 抠出来的数，上游没报、或形状
      不对就是 null。**网关自己是这一格唯一的生产消费方**（serveDecision 解析上游
      回包那一跳复用的是同一个函数）：这一格是 null 时网关拿请求体字节数估一个数，
      垫进它回给客户端的 `usage.input_tokens` 里——所以客户端这边最终看到的数不一定
      是上游报过的那个，只是网关按不按估算结算的判据 */
  inputTokens: number | null;
}

/** 是 / 否。**两格说明都必填**：OpenRouter 那条路上 criteria 出现就必须两格齐全，
    签名不给省略的机会，那条差别就由构造保证 */
export const noul = (instructions: string, yes: string, no: string): NoulQuestion =>
  ({ type: "noul", instructions, criteria: { true: yes, false: no } });
/** 多选一。要让模型能说「都不是」，就得自己给一个那样的选项——它选不了你没给过的值 */
export const choice = (instructions: string, options: Record<string, string>): ChoiceQuestion =>
  ({ type: "choice", instructions, criteria: options });

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const prob = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function probabilitiesOf(v: unknown): Record<string, number> | null {
  if (!isObj(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v)) {
    if (!prob(p)) return null;
    out[k] = p;
  }
  return out;
}

/** 上游回包 → 逐题校验过的答案；任何一处不对整份 null（见文件头第 ② 条）。
    多出来的字段（OpenRouter 的 id / provider / usage.cost、score 的 legend）不碍事也不带走 */
export function parseDecisionReply(payload: unknown, questions: Record<string, DecisionQuestion>): DecisionReply | null {
  if (!isObj(payload) || typeof payload.model !== "string" || !isObj(payload.answers)) return null;
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = payload.answers[id];
    if (!isObj(a) || a.type !== q.type) return null;
    if (q.type === "noul") {
      if (!prob(a.noul)) return null;
      answers[id] = { type: "noul", noul: a.noul };
      continue;
    }
    const probabilities = probabilitiesOf(a.probabilities);
    if (probabilities === null || !prob(a.confidence)) return null;
    if (q.type === "choice") {
      // hasOwn 不是 `in`：`"toString" in {}` 是 true，那会把原型链上的键当成我们给过的选项
      if (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice)) return null;
      answers[id] = { type: "choice", choice: a.choice, probabilities, confidence: a.confidence };
    } else {
      if (typeof a.score !== "number" || !Number.isFinite(a.score)) return null;
      answers[id] = { type: "score", score: a.score, probabilities, confidence: a.confidence };
    }
  }
  const it = isObj(payload.usage) ? payload.usage.input_tokens : undefined;
  return { model: payload.model, answers, inputTokens: typeof it === "number" && Number.isFinite(it) && it >= 0 ? it : null };
}

export interface DecisionDeps {
  /** 网关的 `/llm/v1` 前缀（不带尾斜杠） */
  llmBase: string;
  /** 向网关证明身份的那几个头——桌面是用户的 JWT，runtime 是 x-runtime-secret + on-behalf */
  headers: Record<string, string>;
  /** **必填**：每一处的延迟预算不一样（spec §8），给缺省值就是替它们做了同一个决定。
      **它是延迟止损，不是钱的止损闸**（#1303）：这里 abort 掉的只是本地这一次等待，网关
      那侧那一发照样跑完、照样按实际用量结算 —— 客户端只是把买到的答案扔了。所以「超时了
      就当没发生过」是错的读法，调一个更短的超时值省不下钱，只会更频繁地白买。 */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** 每个回包都叫一次（拿到的是 clone）。桌面用它记额度头 / 认 quota_exhausted */
  onResponse?: (res: Response) => void | Promise<void>;
}

/** 问一次。**从不抛**：超时 / 非 2xx / 形状不对 / fetch 抛错一律 null + 一句原因 */
export async function requestDecision(deps: DecisionDeps, req: DecisionRequest): Promise<DecisionReply | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const fail = (why: string): null => {
    deps.log?.(`[decision] ${req.use}：${why}，走原来那条路`);
    return null;
  };
  try {
    const res = await doFetch(`${deps.llmBase}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", ...deps.headers },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    await Promise.resolve(deps.onResponse?.(res.clone())).catch(() => {});
    if (!res.ok) return fail(`网关回 ${res.status}`);
    return parseDecisionReply(await res.json(), req.questions) ?? fail("回包形状不对");
  } catch (e) {
    return fail(controller.signal.aborted ? `超时（${deps.timeoutMs}ms）` : (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** `/billing/v1/me` 里 decision 那一格的最小形状。写成结构类型而不是 `BillingMe`：
    billing.ts 要 import 本文件的守卫函数，反过来再 import 就成环了 */
type MeLike = { decision?: { models: readonly string[]; uses: DecisionUses } } | null | undefined | "unreachable";

/** 这一处此刻开着哪一档。**每一种缺席都是 off**：没问到、旧 edge 不发这一格、
    网关不供决策模型、这一处没列 */
export function modeOf(me: MeLike, use: DecisionUse): DecisionModeState {
  const d = me && typeof me === "object" ? me.decision : undefined;
  if (!d || d.models.length === 0) return "off";
  return d.uses[use] ?? "off";
}
export function decisionModelOf(me: MeLike): string | null {
  const d = me && typeof me === "object" ? me.decision : undefined;
  return d?.models[0] ?? null;
}

/** 决策那条路的三种结局：有答案 / 拿不准交给慢而聪明的那条路 / 没问出来 */
export type DecisionOutcome<T> = { value: T; scores?: unknown } | { escalate: true; scores?: unknown } | null;

/**
 * 三态包装，五处共用。
 *   off    → 只走 legacy，`viaDecision` 一下都不碰；
 *   on     → 决策优先；没问出来 / escalate / 抛错 → legacy；
 *   shadow → **legacy 说了算且不等决策那一发**，它回来之后记一行对照。
 *
 * 日志是一行 `[decision] {json}`：影子期要回答的「一致率」与「校准」都从它 grep
 * （spec §7）。判决的**结果**已经在事件日志里，概率是调参用的诊断量，不落事件。
 *
 * **抛错只接得住 `viaDecision()` 返回的 promise 被 reject，接不住这次调用本身的
 * 同步抛出**（那会直接从这个函数里抛出去）——调用点今天**全部**把 `viaDecision`
 * 写成 `async` 函数，所以同步抛错不会发生，这是写法保证的，不是这里检查出来的。
 * 不写数字：五处分类器里只有三处经过这个包装（派活 / Auto / 重命名），记忆与语音
 * 断句各自有不走这条路的理由（前者自己分三态，后者压根没有 LLM 兜底可言），
 * 而一个写死的数字迟早会和真相分家——上一版这里写的「五处」就是。
 */
export async function withDecision<T>(o: {
  use: DecisionUse;
  mode: DecisionModeState;
  viaDecision: () => Promise<DecisionOutcome<T>>;
  viaLegacy: () => Promise<T>;
  /** 把判决变成日志里放得下的东西（别把整段正文写进去） */
  show: (v: T) => unknown;
  log?: (line: string) => void;
  now?: () => number;
}): Promise<T> {
  if (o.mode === "off") return o.viaLegacy();
  const now = o.now ?? (() => Date.now());
  const t0 = now();
  const line = (p: Record<string, unknown>): void => o.log?.(`[decision] ${JSON.stringify({ use: o.use, mode: o.mode, ...p })}`);
  const describe = (d: DecisionOutcome<T>): Record<string, unknown> =>
    d === null ? { verdict: null }
    : "escalate" in d ? { verdict: "escalate", scores: d.scores ?? null }
    : { verdict: o.show(d.value), scores: d.scores ?? null };
  const decided = o.viaDecision().catch((): null => null);
  if (o.mode === "on") {
    const d = await decided;
    line({ ms: now() - t0, ...describe(d) });
    return d !== null && !("escalate" in d) ? d.value : o.viaLegacy();
  }
  const legacy = await o.viaLegacy();
  void decided.then((d) => line({ ms: now() - t0, ...describe(d), legacy: o.show(legacy) }));
  return legacy;
}
