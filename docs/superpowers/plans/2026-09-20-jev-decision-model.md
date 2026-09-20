# 决策模型（Jev）经网关接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在五处「便宜 LLM 当分类器」的地方前置一个类型化决策模型（Jev，经 edge 网关 → OpenRouter），LLM 兜底，edge 里一个三态常量分处开关，合并时五处全部休眠。

**Architecture:** 三端共用一份纯层 `src/shared/decision.ts`（线上类型 / 回包校验 / 请求函数 / `withDecision` 三态包装）。edge 多一种 `kind='decision'` 与一扇门 `/llm/v1/decision`（照 `serveTts` 抄），开关 `DECISION_USES` 随 `/billing/v1/me` 下发。runtime 三处只在 `daemon.ts` 的注入点包一层；桌面三处经 `decisionClient` 走用户自己的 JWT。

**Tech Stack:** TypeScript strict（`exactOptionalPropertyTypes: true`，target es2022）、vitest（测试一律放 `tests/`，镜像 `src/`）、Cloudflare Worker（edge）、裸 `fetch`（不加任何依赖）。

**Spec:** `docs/superpowers/specs/2026-09-20-jev-decision-model-design.md` —— 实现者两份都要读；本 plan 与 spec 冲突时以 spec 为准并停下来报告。

## Global Constraints

- **Every path you edit must be under `/Users/stanyan/Github/Mr_Otto/.claude/worktrees/otto-task-sync-local-cloud-d8ef1a`**；never touch `/Users/stanyan/Github/Mr_Otto`（主 checkout）。
- **Never use `git stash` in any form**；RED 靠先写测试再实现。
- 分支 `claude/jev-decision-model-otto-c84a07`，不换分支、不 rebase、不 push（push 由主会话做）。
- 每个任务收尾：`npx tsc --noEmit -p .` 通过 + 本任务的 vitest 文件通过，再 commit。提交信息写 **why**，末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- **`tests/` 也过 `tsc --noEmit`**（根 tsconfig 没有 include，整个仓都在射程里）：测试代码里的夹具要真的对得上类型，别靠 `as any` 糊。
- `exactOptionalPropertyTypes` 开着：可选属性**不许显式赋 `undefined`**，用条件展开 `...(x ? { k: x } : {})`。
- 不改 `SessionEvent` schema，不改 cs 协议位，不加 npm 依赖。
- 既有测试一条都不许改「去绿」；唯一允许动既有断言的情形是 `BillingMe` 整对象 `toEqual` 多出 `decision` 一格（Task 2）。
- 源码与 `.md` 里不许有裸控制字符（`tests/architecture.noControlChars.test.ts`）；易混字符写 `\uXXXX` 转义。
- 注释密度与口吻跟随周围代码：中文、说 **为什么**，不说「做了什么」。
- 七个阈值全是初值，各是文件顶上一个带注释的具名常量：`DISPATCH_NONE_BELOW=0.30` `DISPATCH_PICK_AT=0.60` `DISPATCH_ACT_AT=0.70` `AUTO_SIMPLE_BELOW=0.20` `TITLE_KEEP_AT=0.80` `HOLD_BELOW=0.35` `TIER_MISMATCH_AT=0.85`。
- 超时：派活 1200ms、Auto 1200ms（其 LLM 路补 8000ms）、重命名 1500ms、语音 900ms、记忆 900ms。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/decision.ts` | 建 | 线上类型、构造函数、回包校验、`requestDecision`、`modeOf`、`withDecision` |
| `src/shared/billing.ts` | 改 | `BillingMe.decision?` + 解析 |
| `services/edge/src/decisionUpstream.ts` | 建 | 请求校验 / 上游请求体 / 上游回包 |
| `services/edge/src/decisionUses.ts` | 建 | 开关常量 `DECISION_USES`（初始 `{}`） |
| `services/edge/src/llmGateway.ts` | 改 | `RouteKind` / `upstreamPathFor` / `serveDecision` |
| `services/edge/src/edge.ts` `worker.ts` `billingQueries.ts` | 改 | 门、`Env`、kind 阶梯、`modelsForMe`、`meFromParts` 第九参 |
| `supabase/migrations/0037_model_route_decision.sql` | 建 | kind 约束 + Jev 那一行（只写不跑） |
| `services/runtime/src/decisionOwner.ts` | 建 | 替所有者调 `/llm/v1/decision` |
| `services/runtime/src/dispatchDecision.ts` | 建 | 派活的问题 / 判决表 / `dispatchVia` |
| `src/shared/autoModel.ts` `services/runtime/src/autoModel.ts` | 改 | Auto 的 noul 前置 + LLM 路补超时 |
| `services/runtime/src/sessionTitler.ts` | 改 | KEEP 闸 |
| `services/runtime/src/daemon.ts` | 改 | 三个注入点接线 |
| `src/main/decisionClient.ts` | 建 | 桌面的 `mode` / `decide` |
| `src/main/agent.ts` `src/main/index.ts` | 改 | `HostedCapability.decision?`、Auto 接线、装配 |
| `src/renderer/src/lib/utteranceHold.ts` | 建 | 语音扣住 / 合并的纯状态机 |
| `src/main/endpointJudge.ts` | 建 | 语音那一问 + 影子期真值日志 |
| `src/shared/shellBridge.ts` `src/preload/index.ts` `src/renderer/src/store.ts` | 改 | `speechJudge` IPC + 接线 |
| `src/shared/memoryTierJudge.ts` `src/main/memoryTierJudge.ts` | 建 | 记忆分档的问题 / mismatch 判据 / 主进程装配 |
| `src/shared/memoryStore.ts` `src/tools/memory.ts` | 改 | `tierFact` 单一来源、工具注入 `judgeTier` |
| `docs/adr/0297-*.md` `AGENTS.md` `CONTEXT.md` | 建 / 改 | ADR、索引、术语 |

---

### Task 1: 三端共用纯层 `src/shared/decision.ts`

**Files:**
- Create: `src/shared/decision.ts`
- Test: `tests/shared/decision.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:（后面每个任务都用这些名字，**一个字母都不要改**）
  - `DECISION_USES`, `type DecisionUse`, `type DecisionMode = "shadow" | "on"`, `type DecisionModeState = "off" | DecisionMode`, `type DecisionUses = Partial<Record<DecisionUse, DecisionMode>>`
  - `isDecisionUse(v): v is DecisionUse`, `isDecisionMode(v): v is DecisionMode`
  - `type DecisionQuestion`（`NoulQuestion | ChoiceQuestion | ScoreQuestion`）, `type DecisionState`, `type DecisionAnswer`, `interface DecisionRequest { model; use; state; questions }`, `interface DecisionReply { model; answers; inputTokens: number | null }`
  - `noul(instructions, yes, no): NoulQuestion`, `choice(instructions, options): ChoiceQuestion`
  - `parseDecisionReply(payload: unknown, questions): DecisionReply | null`
  - `interface DecisionDeps { llmBase; headers; timeoutMs; fetchImpl?; log?; onResponse? }`, `requestDecision(deps, req): Promise<DecisionReply | null>`
  - `modeOf(me, use): DecisionModeState`, `decisionModelOf(me): string | null`
  - `type DecisionOutcome<T> = { value: T; scores?: unknown } | { escalate: true; scores?: unknown } | null`, `withDecision<T>(o): Promise<T>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/decision.test.ts
import { describe, expect, it } from "vitest";
import {
  choice, decisionModelOf, isDecisionMode, isDecisionUse, modeOf, noul, parseDecisionReply,
  requestDecision, withDecision, type DecisionQuestion,
} from "../../src/shared/decision.js";

const Q: Record<string, DecisionQuestion> = {
  act: noul("在要求做事吗", "是", "否"),
  tier: choice("哪一档", { user: "用户", memory: "全局", project: "项目" }),
};
const okPayload = () => ({
  model: "jev-1.13.0",
  answers: {
    act: { type: "noul", noul: 0.91 },
    tier: { type: "choice", choice: "project", probabilities: { user: 0.05, memory: 0.1, project: 0.85 }, confidence: 0.8 },
  },
  usage: { input_tokens: 312, output_tokens: 48, cost: 0.0000131 },
});

describe("构造函数", () => {
  it("noul 的 criteria 永远 true/false 两格齐全（OpenRouter 那条差别由构造保证）", () => {
    expect(noul("问", "是", "否")).toEqual({ type: "noul", instructions: "问", criteria: { true: "是", false: "否" } });
  });
  it("choice 原样带选项", () => {
    expect(choice("问", { a: "甲", b: "乙" }).criteria).toEqual({ a: "甲", b: "乙" });
  });
});

describe("parseDecisionReply：不信上游的形状保证，自己验一遍", () => {
  it("形状对：逐题取出，usage.input_tokens 进 inputTokens，多出来的字段不碍事", () => {
    const r = parseDecisionReply({ ...okPayload(), id: "gen-1", provider: "TypeSafe" }, Q);
    expect(r).toEqual({
      model: "jev-1.13.0",
      answers: {
        act: { type: "noul", noul: 0.91 },
        tier: { type: "choice", choice: "project", probabilities: { user: 0.05, memory: 0.1, project: 0.85 }, confidence: 0.8 },
      },
      inputTokens: 312,
    });
  });
  it("没报 usage：inputTokens 是 null，不是解析失败", () => {
    const p = okPayload() as Record<string, unknown>;
    delete p.usage;
    expect(parseDecisionReply(p, Q)?.inputTokens).toBeNull();
  });
  it.each([
    ["缺一题的答案", (p: ReturnType<typeof okPayload>) => { delete (p.answers as Record<string, unknown>).act; }],
    ["类型错位", (p: ReturnType<typeof okPayload>) => { (p.answers.act as { type: string }).type = "choice"; }],
    ["noul 越界", (p: ReturnType<typeof okPayload>) => { p.answers.act.noul = 1.2; }],
    ["noul 不是数", (p: ReturnType<typeof okPayload>) => { (p.answers.act as { noul: unknown }).noul = "0.9"; }],
    ["choice 回了没给过的选项", (p: ReturnType<typeof okPayload>) => { p.answers.tier.choice = "topic"; }],
    ["choice 回了原型链上的键", (p: ReturnType<typeof okPayload>) => { p.answers.tier.choice = "toString"; }],
    ["confidence 越界", (p: ReturnType<typeof okPayload>) => { p.answers.tier.confidence = -0.1; }],
  ])("%s → 整份 null（不挑着用）", (_name, mutate) => {
    const p = okPayload();
    mutate(p);
    expect(parseDecisionReply(p, Q)).toBeNull();
  });
  it("根本不是对象 / 没有 model / 没有 answers → null", () => {
    expect(parseDecisionReply(null, Q)).toBeNull();
    expect(parseDecisionReply({ answers: {} }, Q)).toBeNull();
    expect(parseDecisionReply({ model: "m" }, Q)).toBeNull();
  });
});

describe("modeOf / decisionModelOf：每一种缺席都回 off / null", () => {
  const me = (decision?: unknown) => ({ ...(decision !== undefined ? { decision } : {}) }) as Parameters<typeof modeOf>[0];
  it("null / unreachable / 没有 decision 一格 / 清单为空 / 这一处没列", () => {
    expect(modeOf(null, "dispatch")).toBe("off");
    expect(modeOf("unreachable", "dispatch")).toBe("off");
    expect(modeOf(me(), "dispatch")).toBe("off");
    expect(modeOf(me({ models: [], uses: { dispatch: "on" } }), "dispatch")).toBe("off");
    expect(modeOf(me({ models: ["jev-1.13"], uses: {} }), "dispatch")).toBe("off");
    expect(decisionModelOf(null)).toBeNull();
    expect(decisionModelOf(me({ models: [], uses: {} }))).toBeNull();
  });
  it("列了就回那一档", () => {
    const m = me({ models: ["jev-1.13"], uses: { dispatch: "shadow", auto: "on" } });
    expect(modeOf(m, "dispatch")).toBe("shadow");
    expect(modeOf(m, "auto")).toBe("on");
    expect(decisionModelOf(m)).toBe("jev-1.13");
  });
  it("守卫函数", () => {
    expect(isDecisionUse("endpoint")).toBe(true);
    expect(isDecisionUse("approve")).toBe(false);
    expect(isDecisionMode("shadow")).toBe(true);
    expect(isDecisionMode("off")).toBe(false);
  });
});

describe("requestDecision：任何失败都回 null 并说一句原因", () => {
  const req = { model: "jev-1.13", use: "dispatch" as const, state: "你好", questions: { act: Q.act! } };
  const deps = (fetchImpl: typeof fetch, logs: string[] = []) =>
    ({ llmBase: "https://edge/llm/v1", headers: { authorization: "Bearer t" }, timeoutMs: 50, fetchImpl, log: (m: string) => logs.push(m) });
  it("成功：打 /decision，带头，请求体原样（含 use）", async () => {
    const seen: Request[] = [];
    const f = (async (i: RequestInfo | URL, init?: RequestInit) => { seen.push(new Request(i, init)); return Response.json({ model: "jev-1.13.0", answers: { act: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 9 } }); }) as typeof fetch;
    const r = await requestDecision(deps(f), req);
    expect(r).toEqual({ model: "jev-1.13.0", answers: { act: { type: "noul", noul: 0.2 } }, inputTokens: 9 });
    expect(seen[0]!.url).toBe("https://edge/llm/v1/decision");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer t");
    expect(await seen[0]!.json()).toEqual(req);
  });
  it("非 2xx → null；onResponse 两种情形都被叫到", async () => {
    const logs: string[] = [];
    const statuses: number[] = [];
    const f = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    expect(await requestDecision({ ...deps(f, logs), onResponse: (res) => { statuses.push(res.status); } }, req)).toBeNull();
    expect(statuses).toEqual([403]);
    expect(logs[0]).toContain("403");
  });
  it("回包形状不对 → null", async () => {
    const f = (async () => Response.json({ model: "m", answers: {} })) as typeof fetch;
    expect(await requestDecision(deps(f), req)).toBeNull();
  });
  it("fetch 抛错 → null", async () => {
    const f = (async () => { throw new Error("boom"); }) as typeof fetch;
    expect(await requestDecision(deps(f), req)).toBeNull();
  });
  it("挂住不回 → 到点 abort，回 null，日志写超时", async () => {
    const logs: string[] = [];
    const f = ((_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); })) as typeof fetch;
    expect(await requestDecision(deps(f, logs), req)).toBeNull();
    expect(logs[0]).toContain("超时");
  });
});

describe("withDecision：三态", () => {
  const base = (mode: "off" | "shadow" | "on", viaDecision: () => Promise<unknown>, logs: string[] = []) => ({
    use: "dispatch" as const, mode, viaDecision: viaDecision as never, viaLegacy: async () => "LLM", show: (v: string) => v, log: (l: string) => logs.push(l),
  });
  it("off：不碰 viaDecision", async () => {
    let touched = false;
    expect(await withDecision(base("off", async () => { touched = true; return { value: "JEV" }; }))).toBe("LLM");
    expect(touched).toBe(false);
  });
  it("on：有答案就用它；null / escalate / 抛错都落到 legacy", async () => {
    expect(await withDecision(base("on", async () => ({ value: "JEV" })))).toBe("JEV");
    expect(await withDecision(base("on", async () => null))).toBe("LLM");
    expect(await withDecision(base("on", async () => ({ escalate: true, scores: { act: 0.5 } })))).toBe("LLM");
    expect(await withDecision(base("on", async () => { throw new Error("x"); }))).toBe("LLM");
  });
  it("shadow：legacy 说了算且不等 viaDecision；回来之后记一行对照", async () => {
    const logs: string[] = [];
    let release!: (v: unknown) => void;
    const slow = new Promise((r) => { release = r; });
    const out = await withDecision(base("shadow", () => slow, logs));
    expect(out).toBe("LLM"); // 此刻 slow 还没 resolve
    expect(logs).toHaveLength(0);
    release({ value: "JEV", scores: { act: 0.9 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]!.replace("[decision] ", ""));
    expect(line).toMatchObject({ use: "dispatch", mode: "shadow", verdict: "JEV", legacy: "LLM", scores: { act: 0.9 } });
  });
  it("value 可以是 null（重命名的 KEEP）：那是一个答案，不是「没答案」", async () => {
    const r = await withDecision<string | null>({ use: "title", mode: "on", viaDecision: async () => ({ value: null }), viaLegacy: async () => "LLM", show: (v) => v });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `npx vitest run tests/shared/decision.test.ts`
Expected: FAIL（`Cannot find module '../../src/shared/decision.js'`）

- [ ] **Step 3: 写实现**

```ts
// src/shared/decision.ts
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
  /** 上游没报就是 null（网关据此退回按估算结算），不是解析失败 */
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
  /** **必填**：每一处的延迟预算不一样（spec §8），给缺省值就是替它们做了同一个决定 */
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
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/shared/decision.test.ts && npx tsc --noEmit -p .`
Expected: PASS，tsc 零错误

- [ ] **Step 5: Commit**

```bash
git add src/shared/decision.ts tests/shared/decision.test.ts
git commit -m "feat(shared): 决策模型的三端共用纯层——线上类型、回包校验、三态包装（#1281）"
```

---

### Task 2: `BillingMe.decision` —— 开关随 `/me` 下发

**Files:**
- Modify: `src/shared/billing.ts`（`BillingMe` 接口末尾、`parseBillingMe` 返回前）
- Test: `tests/shared/billing.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isDecisionUse` / `isDecisionMode` / `DecisionUses`
- Produces: `BillingMe.decision?: { models: string[]; uses: DecisionUses }`（**可选属性**：全仓几十处测试夹具直接写 `BillingMe` 字面量，必填会让它们全部编译不过，而缺席的语义本来就是「关」）。`parseBillingMe` **总是**填上这一格。

- [ ] **Step 1: 写失败的测试**（加到 `tests/shared/billing.test.ts` 末尾；`minimalMe` 用文件里已有的最小合法 payload 夹具——若没有现成的，照下面这份建）

```ts
describe("parseBillingMe：decision 一格（#1281）", () => {
  const minimalMe = { plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: ["a", "b"] };
  it("缺席 = { models: [], uses: {} }，不是解析失败（新客户端连老网关）", () => {
    expect(parseBillingMe(minimalMe)?.decision).toEqual({ models: [], uses: {} });
  });
  it("认得的 use / mode 留下，不认得的逐项丢掉", () => {
    const me = parseBillingMe({ ...minimalMe, decision: { models: ["jev-1.13", 7], uses: { dispatch: "shadow", auto: "on", approve: "on", title: "full" } } });
    expect(me?.decision).toEqual({ models: ["jev-1.13"], uses: { dispatch: "shadow", auto: "on" } });
  });
  it("形状不对（不是对象）= 缺席", () => {
    expect(parseBillingMe({ ...minimalMe, decision: "on" })?.decision).toEqual({ models: [], uses: {} });
  });
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/shared/billing.test.ts`
Expected: FAIL（`decision` 是 `undefined`）

- [ ] **Step 3: 实现**

`src/shared/billing.ts` 顶部 import 区加：

```ts
import { isDecisionMode, isDecisionUse, type DecisionUses } from "./decision.js";
```

`BillingMe` 接口里、`modelPlatforms` 之后加：

```ts
  /** 决策模型（Jev，#1281）：网关供不供（`model_route` 里 kind='decision' 那些）+ 五处各自
      开着哪一档。**开关住在 edge 里一个常量上**（services/edge/src/decisionUses.ts），随这份
      快照下发给桌面与 runtime——三端一块配电盘，翻一格最迟一分钟（探针的缓存）全部生效，
      不用发桌面版。`uses` 里**没列 = 关**。
      **可选属性**而 `parseBillingMe` 总是填它：缺席的语义本来就是「关」，写成必填只会让
      全仓的测试夹具各多一行 */
  decision?: { models: string[]; uses: DecisionUses };
```

`parseBillingMe` 里、`const plans: PlanInfo[] = [];` 之前加：

```ts
  // 缺席 / 形状不对 = 这台网关不供决策模型 = 五处全关（#1281）。同 imageModels 的立场：
  // 不能让它把整份快照解析成 null。不认识的 use / mode **逐项丢**不整格丢——edge 先长出
  // 第六处的那天，老客户端该继续用它认得的那五处
  const decision: { models: string[]; uses: DecisionUses } = { models: [], uses: {} };
  if (isObj(payload.decision)) {
    if (Array.isArray(payload.decision.models)) {
      decision.models = payload.decision.models.filter((m): m is string => typeof m === "string");
    }
    if (isObj(payload.decision.uses)) {
      for (const [k, v] of Object.entries(payload.decision.uses)) {
        if (isDecisionUse(k) && isDecisionMode(v)) decision.uses[k] = v;
      }
    }
  }
```

`return { … modelPlatforms };` 改成 `return { … modelPlatforms, decision };`

- [ ] **Step 4: 跑全部与 billing 相关的测试**

Run: `npx vitest run tests/shared/billing.test.ts tests/main/hostedQuota.test.ts tests/runtime/hostedRoute.test.ts && npx tsc --noEmit -p .`
Expected: PASS。若既有用例对 `parseBillingMe` 的**整个**返回值做 `toEqual`，给期望值补上 `decision: { models: [], uses: {} }`（这是 Global Constraints 里唯一允许动既有断言的情形；在 commit message 里写明）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/billing.ts tests/shared/billing.test.ts
git commit -m "feat(billing): /me 多一格 decision——决策模型的开关随快照下发三端（#1281）"
```

---

### Task 3: edge 的纯映射 `decisionUpstream.ts`

**Files:**
- Create: `services/edge/src/decisionUpstream.ts`
- Test: `tests/edge/decisionUpstream.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型与 `parseDecisionReply` / `isDecisionUse`
- Produces:
  - `DECISION_MAX_QUESTIONS = 64`, `DECISION_MAX_OPTIONS = 64`, `DECISION_MAX_BODY_BYTES = 98_304`
  - `parseDecisionRequest(body: Record<string, unknown>, bodyBytes: number): { ok: true; req: DecisionRequest } | { ok: false; message: string }`
  - `decisionUpstreamBody(wireModel: string, req: DecisionRequest): string`
  - `parseDecisionUpstreamReply(text: string, req: DecisionRequest): { ok: true; reply: DecisionReply } | { ok: false; message: string; inputTokens: number | null }`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/decisionUpstream.test.ts
import { describe, expect, it } from "vitest";
import {
  DECISION_MAX_BODY_BYTES, DECISION_MAX_QUESTIONS, decisionUpstreamBody, parseDecisionRequest, parseDecisionUpstreamReply,
} from "../../services/edge/src/decisionUpstream.js";
import { choice, noul } from "../../src/shared/decision.js";

const good = () => ({
  model: "jev-1.13", use: "dispatch", state: { said: "帮我看下构建为什么红了" },
  questions: { act: noul("在要求做事吗", "是", "否"), tier: choice("哪一档", { a: "甲", b: "乙" }) },
});

describe("parseDecisionRequest", () => {
  it("合法请求原样取出", () => {
    const r = parseDecisionRequest(good(), 200);
    expect(r.ok && r.req.use).toBe("dispatch");
    expect(r.ok && Object.keys(r.req.questions)).toEqual(["act", "tier"]);
  });
  it("state 可以是字符串 / 对象 / 数组，不能是 null / 数字", () => {
    expect(parseDecisionRequest({ ...good(), state: "一句话" }, 10).ok).toBe(true);
    expect(parseDecisionRequest({ ...good(), state: ["a", "b"] }, 10).ok).toBe(true);
    expect(parseDecisionRequest({ ...good(), state: null }, 10).ok).toBe(false);
    expect(parseDecisionRequest({ ...good(), state: 7 }, 10).ok).toBe(false);
  });
  it.each([
    ["use 不认识", { use: "approve" }],
    ["questions 为空", { questions: {} }],
    ["questions 不是对象", { questions: [] }],
    ["问题 id 带非法字符", { questions: { "a b": noul("q", "y", "n") } }],
    ["问题类型不认识", { questions: { q: { type: "text", instructions: "x", criteria: {} } } }],
    ["instructions 为空", { questions: { q: noul("", "y", "n") } }],
    ["noul 缺 false 那一格", { questions: { q: { type: "noul", instructions: "x", criteria: { true: "y" } } } }],
    ["choice 只有一个选项", { questions: { q: choice("x", { only: "一" }) } }],
    ["score 只有一档", { questions: { q: { type: "score", instructions: "x", criteria: ["一"] } } }],
  ])("%s → 拒", (_n, patch) => {
    expect(parseDecisionRequest({ ...good(), ...patch }, 10).ok).toBe(false);
  });
  it("问题数超上限 / 请求体超上限 → 拒，且话里带着上限", () => {
    const many = Object.fromEntries(Array.from({ length: DECISION_MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, noul("x", "y", "n")]));
    const a = parseDecisionRequest({ ...good(), questions: many }, 10);
    expect(!a.ok && a.message).toContain(String(DECISION_MAX_QUESTIONS));
    const b = parseDecisionRequest(good(), DECISION_MAX_BODY_BYTES + 1);
    expect(b.ok).toBe(false);
  });
});

describe("decisionUpstreamBody", () => {
  it("换成 wire_model，摘掉 use，其余原样", () => {
    const r = parseDecisionRequest(good(), 10);
    if (!r.ok) throw new Error("fixture");
    expect(JSON.parse(decisionUpstreamBody("typesafe/jev-1.13", r.req))).toEqual({
      model: "typesafe/jev-1.13", state: good().state, questions: good().questions,
    });
  });
});

describe("parseDecisionUpstreamReply", () => {
  const req = (() => { const r = parseDecisionRequest(good(), 10); if (!r.ok) throw new Error("fixture"); return r.req; })();
  const okText = JSON.stringify({
    id: "gen-1", provider: "TypeSafe", model: "jev-1.13.0",
    answers: { act: { type: "noul", noul: 0.9 }, tier: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.6 } },
    usage: { input_tokens: 120, output_tokens: 30, cost: 0.000005 },
  });
  it("形状对 → reply", () => {
    const r = parseDecisionUpstreamReply(okText, req);
    expect(r.ok && r.reply.inputTokens).toBe(120);
  });
  it("不是 JSON → 不 ok，inputTokens 是 null", () => {
    expect(parseDecisionUpstreamReply("<html>", req)).toEqual({ ok: false, message: "上游回的不是 JSON", inputTokens: null });
  });
  it("答案形状不对但报了 usage → 不 ok，**inputTokens 仍然带回来**（上游回了 200 就是收了钱，要按它结算）", () => {
    const bad = JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 77 } });
    expect(parseDecisionUpstreamReply(bad, req)).toEqual({ ok: false, message: "上游回包里的答案形状不对", inputTokens: 77 });
  });
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/edge/decisionUpstream.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// services/edge/src/decisionUpstream.ts
// decisionUpstream —— 决策那扇门的请求 / 回包纯映射（#1281）。
//
// 与 ttsUpstream.ts 同一个分工：网关只在这一层认识上游的形状；不碰 fetch、不碰 quota，
// 钱的那一半留在 llmGateway.ts 的 serveDecision 里。三件会坏的事各占一个函数：
//   ① 客户端发来的合不合法、有没有超上限（parseDecisionRequest）——上限不是洁癖：
//      这扇门对每个订阅用户开着，请求体多大、问几题全由客户端说了算的话，一次请求就能
//      顶满上游的 32k 预算；
//   ② 上游要的是 `{model, state, questions}`，**`use` 只到网关为止**（decisionUpstreamBody）；
//   ③ 回包校验复用三端共用的那一份（parseDecisionReply），这里只多管一件事：
//      **答案形状不对时 usage 仍然要带回去**——上游回了 200 就是收了钱（同 #855）。

import {
  isDecisionUse, parseDecisionReply,
  type DecisionQuestion, type DecisionReply, type DecisionRequest, type DecisionState,
} from "../../../src/shared/decision.js";

export const DECISION_MAX_QUESTIONS = 64;
export const DECISION_MAX_OPTIONS = 64;
/** ≈ 32k token（OpenRouter 那条路的上下文）按 3 字节 / token 折；超了上游也是拒，
    不如在这里拒——少一次预扣、少一次往返 */
export const DECISION_MAX_BODY_BYTES = 96 * 1024;
const INSTRUCTIONS_MAX = 2000;
const ID_RE = /^[A-Za-z0-9_]{1,32}$/;

export type DecisionRequestParse = { ok: true; req: DecisionRequest } | { ok: false; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;

function parseQuestion(v: unknown): DecisionQuestion | null {
  if (!isObj(v) || !text(v.instructions, INSTRUCTIONS_MAX)) return null;
  const c = v.criteria;
  if (v.type === "noul") {
    if (!isObj(c) || !text(c.true, INSTRUCTIONS_MAX) || !text(c.false, INSTRUCTIONS_MAX)) return null;
    return { type: "noul", instructions: v.instructions, criteria: { true: c.true, false: c.false } };
  }
  if (v.type === "choice") {
    if (!isObj(c)) return null;
    const entries = Object.entries(c);
    if (entries.length < 2 || entries.length > DECISION_MAX_OPTIONS) return null;
    const criteria: Record<string, string> = {};
    for (const [k, d] of entries) {
      if (k === "" || k.length > 64 || !text(d, INSTRUCTIONS_MAX)) return null;
      criteria[k] = d;
    }
    return { type: "choice", instructions: v.instructions, criteria };
  }
  if (v.type === "score") {
    if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every((d) => text(d, INSTRUCTIONS_MAX))) return null;
    return { type: "score", instructions: v.instructions, criteria: c as string[] };
  }
  return null;
}

export function parseDecisionRequest(body: Record<string, unknown>, bodyBytes: number): DecisionRequestParse {
  if (bodyBytes > DECISION_MAX_BODY_BYTES) {
    return { ok: false, message: `请求体太大：${bodyBytes} 字节（上限 ${DECISION_MAX_BODY_BYTES}）` };
  }
  if (typeof body.model !== "string" || body.model === "") return { ok: false, message: "请求体要有 model" };
  if (!isDecisionUse(body.use)) return { ok: false, message: "use 不认识" };
  const s = body.state;
  if (!(typeof s === "string" || isObj(s) || Array.isArray(s))) return { ok: false, message: "state 要是字符串、对象或数组" };
  if (!isObj(body.questions)) return { ok: false, message: "questions 要是一个对象" };
  const entries = Object.entries(body.questions);
  if (entries.length === 0) return { ok: false, message: "questions 不能为空" };
  if (entries.length > DECISION_MAX_QUESTIONS) return { ok: false, message: `问题太多：${entries.length} 个（上限 ${DECISION_MAX_QUESTIONS}）` };
  const questions: Record<string, DecisionQuestion> = {};
  for (const [id, raw] of entries) {
    if (!ID_RE.test(id)) return { ok: false, message: `问题 id 不合法：${id.slice(0, 40)}` };
    const q = parseQuestion(raw);
    if (q === null) return { ok: false, message: `问题 ${id} 的形状不对` };
    questions[id] = q;
  }
  return { ok: true, req: { model: body.model, use: body.use, state: s as DecisionState, questions } };
}

export function decisionUpstreamBody(wireModel: string, req: DecisionRequest): string {
  return JSON.stringify({ model: wireModel, state: req.state, questions: req.questions });
}

export type DecisionUpstreamReply =
  | { ok: true; reply: DecisionReply }
  | { ok: false; message: string; inputTokens: number | null };

export function parseDecisionUpstreamReply(raw: string, req: DecisionRequest): DecisionUpstreamReply {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, message: "上游回的不是 JSON", inputTokens: null };
  }
  const reply = parseDecisionReply(payload, req.questions);
  if (reply !== null) return { ok: true, reply };
  const it = isObj(payload) && isObj(payload.usage) ? payload.usage.input_tokens : undefined;
  return { ok: false, message: "上游回包里的答案形状不对", inputTokens: typeof it === "number" && Number.isFinite(it) && it >= 0 ? it : null };
}
```

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/edge/decisionUpstream.test.ts && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/edge/src/decisionUpstream.ts tests/edge/decisionUpstream.test.ts
git commit -m "feat(edge): 决策那扇门的请求校验与上游映射——use 只到网关为止，答案坏了 usage 照带（#1281）"
```

---

### Task 4: 网关 `kind='decision'` + `serveDecision` + 那扇门 + 开关常量

**Files:**
- Create: `services/edge/src/decisionUses.ts`
- Modify: `services/edge/src/llmGateway.ts`（`RouteKind` :39 附近、`upstreamPathFor`、`LlmGatewayDeps`、`serveTts` 之后、`serve` 第一行）
- Modify: `services/edge/src/edge.ts`（三扇门那一行，约 :450）
- Modify: `services/edge/src/worker.ts`（`Env` 接口，`MINIMAX_API_KEY` 那一格旁边）
- Test: `tests/edge/llmGateway.test.ts`（末尾加一个 describe）、`tests/edge/edge.test.ts`（:57-67 那组门）

**Interfaces:**
- Consumes: Task 1 类型；Task 3 三个函数
- Produces: `RouteKind` 多 `"decision"`；`upstreamPathFor("decision") === "/decisions"`；`LlmGatewayDeps.decisionUses?: DecisionUses`（测试注入用，缺省读常量）；`DECISION_USES`（`services/edge/src/decisionUses.ts`）

- [ ] **Step 1: 写失败的测试**（`tests/edge/llmGateway.test.ts` 末尾；`quotaStub` / `upstream` / `caller` 是文件顶部已有的帮手）

```ts
// ---------------------------------------------------------------------------
// 决策那扇门（#1281）：kind=decision 打 /decisions，只按输入 token 计价，开关没开一个
// 上游字节都不发。
const jev: RouteRow = {
  id: "jev-1.13@openrouter", logicalModel: "jev-1.13", platform: "openrouter",
  baseUrl: "https://or/api/alpha", wireModel: "typesafe/jev-1.13",
  priceInMicroPerM: 42_000, priceCacheMicroPerM: 0, priceOutMicroPerM: 0, defaultMaxTokens: 1,
  kind: "decision",
};
const decisionReq = (body: unknown) =>
  new Request("https://edge/llm/v1/decision", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const DECISION_BODY = {
  model: "jev-1.13", use: "dispatch", state: { said: "帮我看下构建" },
  questions: { act: { type: "noul", instructions: "在要求做事吗", criteria: { true: "是", false: "否" } } },
};
const jevOk = (inputTokens: number | null = 120) => () =>
  Response.json({
    id: "gen-1", provider: "TypeSafe", model: "jev-1.13.0",
    answers: { act: { type: "noul", noul: 0.93 } },
    ...(inputTokens !== null ? { usage: { input_tokens: inputTokens, output_tokens: 12, cost: 0.000005 } } : {}),
  });

describe("决策那扇门（#1281）", () => {
  const gw = (up: ReturnType<typeof upstream>, quota: QuotaPort, uses: Record<string, "shadow" | "on"> = { dispatch: "on" }) =>
    createLlmGateway({ routes: async () => [jev], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl, decisionUses: uses });

  it("upstreamPathFor(decision) = /decisions", () => {
    expect(upstreamPathFor("decision")).toBe("/decisions");
  });

  it("成功：预扣按请求体字节估、结算按上游报的 input_tokens、只算输入价；上游收到的没有 use", async () => {
    const { quota, calls } = quotaStub();
    const holdArgs: number[] = [];
    quota.hold = async (_u, rid, est) => { calls.hold.push(rid); holdArgs.push(est); return { ok: true, chargedTo: "window" }; };
    const up = upstream(jevOk(120));
    const res = await gw(up, quota)(decisionReq(DECISION_BODY), caller);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: "jev-1.13.0", answers: { act: { type: "noul", noul: 0.93 } }, usage: { input_tokens: 120 } });
    const bytes = new TextEncoder().encode(JSON.stringify(DECISION_BODY)).length;
    expect(holdArgs).toEqual([Math.ceil((Math.ceil(bytes / 3) * 42_000) / 1_000_000)]);
    expect(calls.settle[0]!.usage).toEqual({ promptTokens: 120, cachedTokens: 0, completionTokens: 0 });
    expect(calls.settle[0]!.costMicro).toBe(Math.ceil((120 * 42_000) / 1_000_000));
    expect(res.headers.get(BILLING_HEADERS.cost)).toBe(String(calls.settle[0]!.costMicro));
    expect(res.headers.get(BILLING_HEADERS.h5)).toBe("100");
    const sent = up.seen[0]!;
    expect(sent.url).toBe("https://or/api/alpha/decisions");
    expect(sent.headers.get("authorization")).toBe("Bearer k");
    expect(await sent.json()).toEqual({ model: "typesafe/jev-1.13", state: DECISION_BODY.state, questions: DECISION_BODY.questions });
  });

  it("这一处没开：403 decision_use_disabled，**没预扣、没发上游**", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(jevOk());
    const res = await gw(up, quota, {})(decisionReq(DECISION_BODY), caller);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("decision_use_disabled");
    expect(calls.hold).toHaveLength(0);
    expect(up.seen).toHaveLength(0);
  });

  it("shadow 也放行（影子期要真的问得到）", async () => {
    const { quota } = quotaStub();
    const res = await gw(upstream(jevOk()), quota, { dispatch: "shadow" })(decisionReq(DECISION_BODY), caller);
    expect(res.status).toBe(200);
  });

  it("请求不合法：400，没预扣", async () => {
    const { quota, calls } = quotaStub();
    const res = await gw(upstream(jevOk()), quota)(decisionReq({ ...DECISION_BODY, questions: {} }), caller);
    expect(res.status).toBe(400);
    expect(calls.hold).toHaveLength(0);
  });

  it("上游没报 usage：按预扣那份估算结算", async () => {
    const { quota, calls } = quotaStub();
    await gw(upstream(jevOk(null)), quota)(decisionReq(DECISION_BODY), caller);
    const bytes = new TextEncoder().encode(JSON.stringify(DECISION_BODY)).length;
    expect(calls.settle[0]!.usage.promptTokens).toBe(Math.ceil(bytes / 3));
  });

  it("上游连不上 / 回非 2xx：release，502，不结算", async () => {
    for (const res of [() => { throw new Error("net"); }, () => new Response("no", { status: 529 })]) {
      const { quota, calls } = quotaStub();
      const out = await gw(upstream(res as () => Response), quota)(decisionReq(DECISION_BODY), caller);
      expect(out.status).toBe(502);
      expect(calls.release).toHaveLength(1);
      expect(calls.settle).toHaveLength(0);
    }
  });

  it("上游回 200 但答案形状不对：**照样结算**（收了钱），再回 502", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ model: "m", answers: {}, usage: { input_tokens: 77 } }));
    const out = await gw(up, quota)(decisionReq(DECISION_BODY), caller);
    expect(out.status).toBe(502);
    expect(calls.settle[0]!.usage.promptTokens).toBe(77);
    expect(calls.release).toHaveLength(0);
  });

  it("hold 被拒：原样走那三种回执", async () => {
    const { quota } = quotaStub({ ok: false, code: "no_subscription" });
    const out = await gw(upstream(jevOk()), quota)(decisionReq(DECISION_BODY), caller);
    expect(out.status).toBe(402);
  });
});
```

`tests/edge/edge.test.ts` 里那组「每扇门在没开托管时回 `llm_disabled`」的用例，把 `/llm/v1/decision` 加进它遍历的路径数组。

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/edge/llmGateway.test.ts tests/edge/edge.test.ts`
Expected: FAIL（`"decision"` 不是合法的 `RouteKind`，tsc/运行期都会先炸在夹具上）

- [ ] **Step 3: 实现**

① 新文件：

```ts
// services/edge/src/decisionUses.ts
// 决策模型的分处开关（#1281，spec §6）。**没列 = 关**，所以这张空表就是五处全关。
//
// 为什么是代码里的一个常量，不是 model_route 上的一列：加列要「migration 先、worker 后」，
// 而新 kind 要「worker 先、migration 后」（0037 的头注）——两条顺序相反的规则压在同一次
// 上线上。常量改一行走 PR，git 历史里留着「哪天凭什么数据开的」，关掉也是一行。
//
// 翻一格之前：那一处要先在 `shadow` 下跑过，PR 正文贴 `[decision]` 日志里的一致率与校准。
//   没列      → 网关对这个 use 回 403，三端一个请求都不发，行为一字不变
//   "shadow"  → 放行；三端照旧走今天那条路，决策模型并行问一次、只记对照日志
//   "on"      → 决策优先，没问出来 / 拿不准就回落到今天那条路

import type { DecisionUses } from "../../../src/shared/decision.js";

export const DECISION_USES: DecisionUses = {};
```

② `llmGateway.ts`：

```ts
// import 区
import type { DecisionUses } from "../../../src/shared/decision.js";
import { decisionUpstreamBody, parseDecisionRequest, parseDecisionUpstreamReply } from "./decisionUpstream.js";
import { DECISION_USES } from "./decisionUses.js";
```

`export type RouteKind = "chat" | "image" | "tts";` 改成（并在上面那段注释末尾补一句）：

```ts
/** …（原注释保留）
    `decision` = 决策模型（#1281）：不生成文字，收 state + 问题回类型化答案。它**输出价是 0**，
    漏进 `me.models` 会排到第一位 = 所有订阅用户的默认聊天款 + Auto 的 simple 档，而它压根
    不会聊天——所以同样单列一种 kind，且部署顺序是 worker 先、migration 后（0037 头注） */
export type RouteKind = "chat" | "image" | "tts" | "decision";
```

`upstreamPathFor` 函数体第一行前加：

```ts
  // 决策（#1281）：OpenRouter 的 Decisions 端点。base_url 是 `…/api/alpha`（路径里真有 alpha），
  // 请求体与回包都不是 OpenAI 形状——翻译在 decisionUpstream.ts，这里只答「打哪个 URL」
  if (kind === "decision") return "/decisions";
```

`LlmGatewayDeps` 末尾加：

```ts
  /** 决策模型的分处开关（#1281）。缺省读 `decisionUses.ts` 的常量；留成可注入只为测试能
      摆出「开着」的样子——生产装配不传 */
  decisionUses?: DecisionUses;
```

`serveTts` 的定义之后、`const serve = …` 之前加：

```ts
    // 决策那扇门（#1281）：与 tts 同一副骨架，差四处——
    // ① **先查开关**：这一处没开就 403，预扣都不做。开关是 edge 里的常量，随 /me 下发给
    //    三端；客户端本来就不会对没开的 use 发请求，这里拦的是「客户端那份快照陈旧」和
    //    「有人直接敲这扇门」；
    // ② 钱只算**输入** token（输出免费）：预扣按请求体字节 ÷ 3 估，结算用上游报的 input_tokens；
    // ③ 请求体摘掉 `use` 再发（那是我们自己的字段，上游不认识）；
    // ④ **上游回了 200 就结算**，哪怕答案形状不对（同 #855：收了钱的调用不许 release）——
    //    结算完再回 502，客户端据此回落到原来那条路。
    const serveDecision = async (route: RouteRow, key: string): Promise<Response> => {
      const bodyBytes = new TextEncoder().encode(raw).length;
      const parsed = parseDecisionRequest(body, bodyBytes);
      if (!parsed.ok) return apiError(400, parsed.message, "bad_request");
      const uses = deps.decisionUses ?? DECISION_USES;
      if (uses[parsed.req.use] === undefined) {
        return apiError(403, `决策模型在「${parsed.req.use}」这一处没有开`, "decision_use_disabled");
      }
      const estimate: UsageCounts = { promptTokens: Math.ceil(bodyBytes / 3), cachedTokens: 0, completionTokens: 0 };
      const requestId = newId();
      let held: HoldOutcome;
      try {
        held = await deps.quota.hold(caller.uid, requestId, costMicro(estimate, route));
      } catch {
        return apiError(503, "额度服务暂时不可用，稍后再试", "upstream");
      }
      if (!held.ok) return holdRejected(held);
      try {
        let res: Response;
        try {
          res = await doFetch(`${route.baseUrl}${upstreamPathFor(route.kind)}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: decisionUpstreamBody(route.wireModel, parsed.req),
            signal: req.signal,
          });
        } catch {
          await deps.quota.release(caller.uid, requestId);
          return apiError(502, `上游连不上：${route.platform}`, "upstream");
        }
        if (!res.ok) {
          await deps.quota.release(caller.uid, requestId);
          const snippet = (await res.text().catch(() => "")).slice(0, 300);
          return apiError(502, `上游 ${res.status}：${snippet}`, "upstream", { upstreamStatus: res.status });
        }
        const reply = parseDecisionUpstreamReply(await res.text(), parsed.req);
        const inputTokens = reply.ok ? reply.reply.inputTokens : reply.inputTokens;
        const usage: UsageCounts = inputTokens === null ? estimate : { promptTokens: inputTokens, cachedTokens: 0, completionTokens: 0 };
        const cost = costMicro(usage, route);
        await deps.quota.settle(caller.uid, requestId, { caller, route, usage, costMicro: cost });
        const headers = await remainingHeaders(caller.uid);
        if (!reply.ok) return apiError(502, reply.message, "upstream", {}, headers);
        return json(200, {
          model: reply.reply.model, answers: reply.reply.answers, usage: { input_tokens: usage.promptTokens },
        }, { ...headers, [BILLING_HEADERS.cost]: String(cost) });
      } catch (err) {
        await deps.quota.release(caller.uid, requestId).catch(() => {});
        return apiError(502, `处理请求时出错：${err instanceof Error ? err.message : String(err)}`, "upstream");
      }
    };
```

`serve` 的第一行 `if (route.kind === "tts") return serveTts(route, key);` 之后加：

```ts
      if (route.kind === "decision") return serveDecision(route, key);
```

> 注意：`settle` 之后再抛的异常会落进外层 `catch` 去 `release` 一个已经结算的 id——`release` 对已结算的 id 是 no-op（Quota DO 按 requestId 找 hold，找不到就什么都不做），与 `serveTts` 同一处境，不用另外处理。

③ `services/edge/src/edge.ts`：那一行条件末尾加 `|| pathname === "/llm/v1/decision"`，并在上面的注释里补一句「决策那扇门（#1281）：同一个处理函数，打哪个上游由路由行的 kind 决定」。

④ `services/edge/src/worker.ts` 的 `Env`，`MINIMAX_API_KEY?: string;` 之后加：

```ts
  /** OpenRouter：出图（#1081）与决策模型（#1281）两条路的上游。0031 那次漏了这一格，
      靠 `upstreamKeyOf` 的索引签名才没红——「加一家上游是两处」那条约定现在补齐 */
  OPENROUTER_API_KEY?: string;
```

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/edge/ && npx tsc --noEmit -p . && npx tsc --noEmit -p services/edge`
Expected: PASS（`services/edge` 有自己的 tsconfig；如果第二条命令报「找不到 tsconfig」，用 `ls services/edge/tsconfig*.json` 找到它的真名再跑）

- [ ] **Step 5: Commit**

```bash
git add services/edge/src/decisionUses.ts services/edge/src/llmGateway.ts services/edge/src/edge.ts services/edge/src/worker.ts tests/edge/llmGateway.test.ts tests/edge/edge.test.ts
git commit -m "feat(edge): kind='decision' 与 /llm/v1/decision——先查开关再预扣，只算输入价，回了 200 就结算（#1281）"
```

---

### Task 5: `/me` 下发 `decision` —— kind 阶梯、`modelsForMe`、`meFromParts` 第九参

**Files:**
- Modify: `services/edge/src/billingQueries.ts`（`parseRouteRows` 的 kind 那一行、`modelsForMe`、`meFromParts`）
- Modify: `services/edge/src/worker.ts`（`me()` 里调 `modelsForMe` / `meFromParts` 那两行，约 :647）
- Test: `tests/edge/billingQueries.test.ts`

**Interfaces:**
- Consumes: Task 1 `DecisionUses`；Task 4 `DECISION_USES`
- Produces: `modelsForMe(routes).decisionModels: string[]`；`meFromParts(sub, windows, addon, models, plans, modelPlatforms?, imageModels?, ttsModels?, decision?: { models: string[]; uses: DecisionUses })`

- [ ] **Step 1: 写失败的测试**（`tests/edge/billingQueries.test.ts` 末尾；`row` 用文件里现成的路由行夹具构造器——没有就照 `parseRouteRows` 用例里那份原始行对象抄）

```ts
describe("决策模型那一格（#1281）", () => {
  const raw = (over: Record<string, unknown>) => ({
    id: "x@p", logical_model: "x", platform: "p", base_url: "https://u", wire_model: "x",
    price_in_micro_per_m: 1, price_cache_micro_per_m: 0, price_out_micro_per_m: 1, default_max_tokens: 10, ...over,
  });
  it("kind='decision' 认得出；认不出的仍然按 chat（末端兜底不变）", () => {
    const rows = parseRouteRows([raw({ kind: "decision" }), raw({ id: "y@p", kind: "bogus" })]);
    expect(rows.map((r) => r.kind)).toEqual(["decision", "chat"]);
  });
  it("决策那一行**不进 models**（它输出价是 0，进去就是所有人的默认聊天款），单列一张 decisionModels", () => {
    const rows = parseRouteRows([
      raw({ id: "jev-1.13@openrouter", logical_model: "jev-1.13", platform: "openrouter", price_out_micro_per_m: 0, kind: "decision" }),
      raw({ id: "flash@deepseek", logical_model: "flash", kind: "chat" }),
    ]);
    const m = modelsForMe(rows);
    expect(m.models).toEqual(["flash"]);
    expect(m.decisionModels).toEqual(["jev-1.13"]);
    expect(m.modelPlatforms).toEqual({ flash: "p" });
  });
  it("meFromParts 第九参：有决策型号才带 uses；没有型号时 uses 一律清空", () => {
    // 测试也过 tsc：readonly 元组 spread 进不了可变数组形参，所以老老实实写全
    const addon = { remainingMicro: 0, expiresAt: null };
    expect(meFromParts(null, null, addon, ["flash"], [], {}, [], []).decision).toEqual({ models: [], uses: {} });
    expect(meFromParts(null, null, addon, ["flash"], [], {}, [], [], { models: ["jev-1.13"], uses: { dispatch: "shadow" } }).decision)
      .toEqual({ models: ["jev-1.13"], uses: { dispatch: "shadow" } });
    expect(meFromParts(null, null, addon, ["flash"], [], {}, [], [], { models: [], uses: { dispatch: "on" } }).decision)
      .toEqual({ models: [], uses: {} });
  });
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/edge/billingQueries.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`billingQueries.ts` 顶部 import 加 `import type { DecisionUses } from "../../../src/shared/decision.js";`

kind 那一行改成：

```ts
    const kind = r.kind === "image" ? "image" : r.kind === "tts" ? "tts" : r.kind === "decision" ? "decision" : "chat";
```

`modelsForMe` 的返回类型与返回值各多一格：

```ts
export function modelsForMe(routes: RouteRow[]): {
  models: string[]; imageModels: string[]; ttsModels: string[]; decisionModels: string[]; modelPlatforms: Record<string, string>;
} {
  // …（chat / modelPlatforms 不变）
  return {
    // …（前三张不变）
    // 第四张清单（#1281）：决策模型。消费方是三端那五处分类器，与前三张同样互不相通——
    // 它**输出价是 0**，漏进 models 会排到第一位 = 默认聊天款 + Auto 的 simple 档
    decisionModels: [...new Set(routes.filter((r) => r.kind === "decision").map((r) => r.logicalModel))],
    modelPlatforms,
  };
}
```

`meFromParts` 参数表末尾（`ttsModels: string[] = []` 之后）加：

```ts
  /** 决策模型（#1281）：供哪几款 + 五处各开哪一档。**一个对象参数不是两个数组**：这个函数
      已经有八个位置参数、其中三个是「数组或对象」，tsc 拦不住插错位置；一个带结构的参数
      插不错。缺省 = 这台网关不供决策模型 = 五处全关 */
  decision: { models: string[]; uses: DecisionUses } = { models: [], uses: {} }
```

返回对象里 `modelPlatforms,` 之后加：

```ts
    // 没有型号时 uses 一律清空：开关开着、路由行却不在（migration 没跑 / 那一行被停用），
    // 下发一张「开着」的表只会让三端去敲一扇必然 400 的门
    decision: { models: decision.models, uses: decision.models.length > 0 ? decision.uses : {} },
```

`worker.ts`：

```ts
import { DECISION_USES } from "./decisionUses.js";
// …
      const { models, imageModels, ttsModels, decisionModels, modelPlatforms } = modelsForMe(routes);
      return meFromParts(v.sub, v.windows, v.addon, models, plans, modelPlatforms, imageModels, ttsModels, { models: decisionModels, uses: DECISION_USES });
```

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/edge/ && npx tsc --noEmit -p . && npx tsc --noEmit -p services/edge`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/edge/src/billingQueries.ts services/edge/src/worker.ts tests/edge/billingQueries.test.ts
git commit -m "feat(edge): /me 下发 decision——决策那一行不进 models，开关表没有型号时清空（#1281）"
```

---

### Task 6: migration 0037（只写不跑）

**Files:**
- Create: `supabase/migrations/0037_model_route_decision.sql`
- Test: 既有的 `tests/docs/migrationNumbers.test.ts`（编号唯一）

**Interfaces:**
- Consumes: 无
- Produces: `model_route` 里一行 `jev-1.13@openrouter`（`logical_model='jev-1.13'`）。**本任务只落文件，不连任何数据库、不跑任何 SQL**——生产库动作等维护者明说。

- [ ] **Step 1: 先确认 0037 没被别的 lane 占掉**

Run: `git fetch origin && git ls-tree -r --name-only origin/main supabase/migrations | tail -3 && ls supabase/migrations | tail -3`
Expected: 两边最大的都是 `0036_task_sessions.sql`。如果 origin/main 上已经有 `0037_*`，本任务的文件名与文件内每一处 `0037` 改成 `max + 1`，并在回报里写明。

- [ ] **Step 2: 写文件**

```sql
-- 0037_model_route_decision.sql —— model_route 加 kind='decision' + 上决策模型 Jev 那一款（issue #1281）。幂等，重跑不炸。
-- 与 0024–0036 同一约定：Supabase SQL editor / Management API 手动执行一次（多条语句分开发，
-- Management API 一次只回最后一条的结果）。
--
-- **顺序：先部署 edge worker，再跑本条。反过来是一次事故，不是一次小毛病。**
-- 旧 worker 的 `parseRouteRows` 对认不出的 kind 按 chat 处理（那是故意的：一个拼错的 kind
-- 不该让一款模型从网关上消失），而这一行的 `price_out` 是 **0**、`routesQuery` 按
-- `priority, price_out, id` 升序——本条先跑的话，这一行会在新 worker 上线之前排到
-- `me.models[0]`，也就是**所有订阅用户的默认聊天款 + Auto 的 simple 档**（ADR-0237：
-- 「默认款 = 最便宜那款，是个承诺」），而它压根不会聊天：每一条没指定型号的消息都会 502。
-- 0033 的头注写过同一条规则（那次是语音行漏进选单当 hard 档），这一次锋利得多——那次漏的
-- 是清单的末尾，这次漏的是开头。反过来（worker 先）什么都不会发生：没有这一行 =
-- `me.decision.models` 为空 = 三端五处全部按原样走。
--
-- 背景：Otto 里有五处拿便宜聊天模型当分类器（派活 / Auto 判难度 / 云会话重命名 / 语音断句 /
-- 记忆分档）。Jev（TypeSafe AI，2026-09-15 发布）不生成文字，收 state + 一组类型化问题，
-- 一次前向回类型化答案 + 校准概率。路是「桌面 / runtime → edge 网关 `/llm/v1/decision` →
-- OpenRouter 的 Decisions 端点」，官方 key 只在 Worker secret（`OPENROUTER_API_KEY`，出图那条路
-- 已经在用的那一把）。网关按路由行的 `kind` 决定打 `/decisions`（`upstreamPathFor`）。
--
-- **这一行上线之后五处仍然全关**：真正的开关是 edge 里的常量 `DECISION_USES`
-- （services/edge/src/decisionUses.ts，初始 `{}`），随 `/billing/v1/me` 下发三端。这一行只回答
-- 「网关供不供」，那张表回答「哪一处开着哪一档」。停掉整条路：把这一行 `enabled` 改成 false。
--
-- **价怎么定的**：OpenRouter 模型页（2026-09-20）`typesafe/jev-1.13` = $0.042 / 百万输入 token，
-- 输出免费。本仓 micro = 1e-6 美元（对过 0031 那行 `$60/M ↔ 60000000`）→ `price_in = 42000`，
-- `price_cache = 0`（这条路没有 cache 一说）、`price_out = 0`。网关只把上游报的 `input_tokens`
-- 填进 `prompt_tokens`，于是现成的 `costMicro()` 一个字不用改。量级：一次派活判定约 300–800
-- 输入 token ≈ 13–34 micro。
--
-- `default_max_tokens` 只是名义值：决策的预扣不走 `estimateMicro`（那条按 max_tokens 顶格估
-- 输出），而是按请求体字节 ÷ 3 估输入，所以这一格不参与任何计算；填 1 只为过表上的正数约束。
--
-- `base_url` 里真的有 `alpha`：OpenRouter 把这个端点挂在 `/api/alpha/decisions`（2026-09-20 实测：
-- 不带凭据打过去回 401，`/api/v1/decisions` 回 404）。它改路径那天，三端五处一起回落到原来
-- 那条 LLM 路——不会坏，只是安静地失效；改这一行的 `base_url` 即可，不用发版。

-- ① 认得的值多一种。约束用 check 不用 enum（0031 的理由：加一种改一条 alter 就够）
alter table public.model_route drop constraint if exists model_route_kind_check;
alter table public.model_route add constraint model_route_kind_check check (kind in ('chat', 'image', 'tts', 'decision'));

-- ② 决策那一款。id 沿用既有的 `<logical>@<platform>` 格式
insert into public.model_route (
  id, logical_model, platform, base_url, wire_model,
  price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m,
  default_max_tokens, quantization, priority, enabled, kind
) values (
  'jev-1.13@openrouter', 'jev-1.13', 'openrouter',
  'https://openrouter.ai/api/alpha', 'typesafe/jev-1.13',
  42000, 0, 0,
  1, 'none', 10, true, 'decision'
)
on conflict (id) do update set
  logical_model = excluded.logical_model, platform = excluded.platform,
  base_url = excluded.base_url, wire_model = excluded.wire_model,
  price_in_micro_per_m = excluded.price_in_micro_per_m,
  price_cache_micro_per_m = excluded.price_cache_micro_per_m,
  price_out_micro_per_m = excluded.price_out_micro_per_m,
  default_max_tokens = excluded.default_max_tokens,
  quantization = excluded.quantization, priority = excluded.priority,
  enabled = excluded.enabled, kind = excluded.kind;
```

- [ ] **Step 3: 跑编号断言 + 控制字符断言**

Run: `npx vitest run tests/docs/migrationNumbers.test.ts tests/architecture.noControlChars.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0037_model_route_decision.sql
git commit -m "feat(db): migration 0037——model_route 认得 kind='decision' + Jev 那一行（只写不跑；必须 worker 先于它，#1281）"
```

---

### Task 7: runtime 的所有者通道 + 派活判决 `dispatchDecision.ts`

**Files:**
- Create: `services/runtime/src/decisionOwner.ts`
- Create: `services/runtime/src/dispatchDecision.ts`
- Test: `tests/runtime/decisionOwner.test.ts`, `tests/runtime/dispatchDecision.test.ts`

**Interfaces:**
- Consumes: Task 1 全部；`services/runtime/src/dispatch.ts` 已有的 `DispatchInput` / `DispatchVerdict` / `DISPATCH_MAX_TARGETS` / `DISPATCH_TEXT_MAX_CHARS`；`src/shared/promptSafe.ts` 的 `promptSafe` / `promptSafeBody`；`src/shared/billing.ts` 的四个头常量
- Produces:
  - `interface OwnerDecisionDeps { edgeBase; runtimeSecret; ownerUid; workspaceId; sessionId; agentId?; fetchImpl?; log? }`
  - `requestDecisionAsOwner(deps: OwnerDecisionDeps, req: DecisionRequest, timeoutMs: number): Promise<DecisionReply | null>`
  - `DISPATCH_NONE_BELOW = 0.30`, `DISPATCH_PICK_AT = 0.60`, `DISPATCH_ACT_AT = 0.70`, `DISPATCH_DECISION_TIMEOUT_MS = 1200`
  - `dispatchQuestions(input): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> }`
  - `verdictFromScores(reply, input): { verdict: DispatchVerdict | "escalate"; scores: Record<string, number> } | null`
  - `dispatchVia(o: { mode; model: string | null; input; decide; llm; log? }): Promise<DispatchVerdict>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/runtime/decisionOwner.test.ts
import { describe, expect, it } from "vitest";
import { requestDecisionAsOwner } from "../../services/runtime/src/decisionOwner.js";
import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../src/shared/billing.js";
import { noul } from "../../src/shared/decision.js";

describe("requestDecisionAsOwner：替团队所有者调 /llm/v1/decision", () => {
  const req = { model: "jev-1.13", use: "dispatch" as const, state: "x", questions: { act: noul("q", "y", "n") } };
  const run = async (agentId?: string) => {
    const seen: Request[] = [];
    const fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(i, init));
      return Response.json({ model: "jev-1.13.0", answers: { act: { type: "noul", noul: 0.5 } } });
    }) as typeof fetch;
    const r = await requestDecisionAsOwner(
      { edgeBase: "https://edge", runtimeSecret: "s3", ownerUid: "owner-1", workspaceId: "ws-1", sessionId: "cs-1", fetchImpl, ...(agentId ? { agentId } : {}) },
      req, 500,
    );
    return { r, sent: seen[0]! };
  };
  it("四个头齐全，打的是 /llm/v1/decision", async () => {
    const { r, sent } = await run();
    expect(r?.answers.act).toEqual({ type: "noul", noul: 0.5 });
    expect(sent.url).toBe("https://edge/llm/v1/decision");
    expect(sent.headers.get("x-runtime-secret")).toBe("s3");
    expect(sent.headers.get(ON_BEHALF_HEADER)).toBe("owner-1");
    expect(sent.headers.get(WORKSPACE_HEADER)).toBe("ws-1");
    expect(sent.headers.get(SESSION_HEADER)).toBe("cs-1");
    expect(sent.headers.get(AGENT_HEADER)).toBeNull(); // 不属于任何一只 agent 的调用：空 = 未归因（ADR-0221）
  });
  it("给了 agentId 才带 agent 头（Auto 那一处是替某一只判的）", async () => {
    expect((await run("dev")).sent.headers.get(AGENT_HEADER)).toBe("dev");
  });
});
```

```ts
// tests/runtime/dispatchDecision.test.ts
import { describe, expect, it } from "vitest";
import {
  DISPATCH_ACT_AT, DISPATCH_NONE_BELOW, DISPATCH_PICK_AT, dispatchQuestions, dispatchVia, verdictFromScores,
} from "../../services/runtime/src/dispatchDecision.js";
import type { DispatchInput, DispatchVerdict } from "../../services/runtime/src/dispatch.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const ROSTER = [
  { agentId: "admin", name: "管理员", description: "统筹，没人对口的活归它" },
  { agentId: "dev", name: "开发", description: "写代码、修构建" },
  { agentId: "ops", name: "运营", description: "文案与投放" },
];
const input = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  roster: ROSTER, fallbackAgentId: "admin", context: ["[小红]: 早", "[开发]: 早，构建我在看"], fromLabel: "小红", text: "构建为什么红了", ...over,
});
const reply = (act: number, agents: number[]): DecisionReply => ({
  model: "jev-1.13.0", inputTokens: 100,
  answers: { act: { type: "noul", noul: act }, ...Object.fromEntries(agents.map((p, i) => [`a${i + 1}`, { type: "noul", noul: p }])) },
});

describe("dispatchQuestions", () => {
  it("一个 act + 每只一个 a<n>；**键是编号不是名字**", () => {
    const { questions } = dispatchQuestions(input());
    expect(Object.keys(questions)).toEqual(["act", "a1", "a2", "a3"]);
    expect(Object.values(questions).every((q) => q.type === "noul")).toBe(true);
  });
  it("state 带名册（含 fallback 记号）、最近几句、这句话；名字里的 ] 与换行撑不破结构", () => {
    const { state } = dispatchQuestions(input({ roster: [{ agentId: "x", name: "坏]名\n字", description: "d" }], fallbackAgentId: null }));
    const roster = state.roster as { n: number; name: string; fallback: boolean }[];
    expect(roster[0]!.n).toBe(1);
    expect(roster[0]!.fallback).toBe(false);
    expect(roster[0]!.name).not.toContain("]");
    expect(roster[0]!.name).not.toContain("\n");
    expect(state.recent).toEqual(["[小红]: 早", "[开发]: 早，构建我在看"]);
    expect((state.said as { text: string }).text).toBe("构建为什么红了");
  });
  it("这句话超长时截断到 DISPATCH_TEXT_MAX_CHARS", () => {
    const { state } = dispatchQuestions(input({ text: "字".repeat(5000) }));
    expect((state.said as { text: string }).text.length).toBeLessThanOrEqual(1200);
  });
});

describe("verdictFromScores：判决表（阈值是初值，边界用常量表达）", () => {
  it("不像在要求做事 → none", () => {
    expect(verdictFromScores(reply(DISPATCH_NONE_BELOW - 0.01, [0.1, 0.1, 0.1]), input())?.verdict).toEqual({ kind: "none" });
  });
  it("有对得上的 → picked，按 P 降序，同分按名册顺序", () => {
    const v = verdictFromScores(reply(0.9, [0.2, DISPATCH_PICK_AT, 0.95]), input())?.verdict;
    expect(v).toEqual({ kind: "picked", agentIds: ["ops", "dev"] });
  });
  it("封顶三只", () => {
    const four = input({ roster: [...ROSTER, { agentId: "qa", name: "测试", description: "" }] });
    const v = verdictFromScores(reply(0.9, [0.9, 0.9, 0.9, 0.9]), four)?.verdict as Extract<DispatchVerdict, { kind: "picked" }>;
    expect(v.agentIds).toEqual(["admin", "dev", "ops"]);
  });
  it("明确要做事、但没人对得上 → 归 fallback 那一只", () => {
    expect(verdictFromScores(reply(DISPATCH_ACT_AT, [0.2, 0.3, 0.1]), input())?.verdict).toEqual({ kind: "picked", agentIds: ["admin"] });
  });
  it("同上但没有 fallback → escalate", () => {
    expect(verdictFromScores(reply(0.9, [0.2, 0.3, 0.1]), input({ fallbackAgentId: null }))?.verdict).toBe("escalate");
  });
  it("中间地带（要不要做事拿不准、也没人对得上）→ escalate", () => {
    expect(verdictFromScores(reply(0.5, [0.2, 0.3, 0.1]), input())?.verdict).toBe("escalate");
  });
  it("自相矛盾（不像在要求做事，却有一只强烈对得上）→ escalate，不硬判 none", () => {
    expect(verdictFromScores(reply(0.1, [0.1, 0.9, 0.1]), input())?.verdict).toBe("escalate");
  });
  it("scores 原样带出（日志要用）", () => {
    expect(verdictFromScores(reply(0.9, [0.1, 0.8, 0.2]), input())?.scores).toEqual({ act: 0.9, a1: 0.1, a2: 0.8, a3: 0.2 });
  });
  it("回包里缺 act → null", () => {
    expect(verdictFromScores({ model: "m", inputTokens: null, answers: {} }, input())).toBeNull();
  });
});

describe("dispatchVia：三态", () => {
  const llmVerdict: DispatchVerdict = { kind: "picked", agentIds: ["dev"] };
  const mk = (mode: "off" | "shadow" | "on", decide: () => Promise<DecisionReply | null>, model: string | null = "jev-1.13") => {
    let llmCalls = 0;
    const logs: string[] = [];
    const p = dispatchVia({ mode, model, input: input(), decide: async () => decide(), llm: async () => { llmCalls++; return llmVerdict; }, log: (l) => logs.push(l) });
    return { p, llmCalls: () => llmCalls, logs };
  };
  it("off：decide 一下都不碰", async () => {
    let touched = false;
    const t = mk("off", async () => { touched = true; return reply(0.9, [0, 0, 0.9]); });
    expect(await t.p).toEqual(llmVerdict);
    expect(touched).toBe(false);
  });
  it("on + 有把握：用决策的判决，LLM 一次都不打", async () => {
    const t = mk("on", async () => reply(0.9, [0.1, 0.1, 0.9]));
    expect(await t.p).toEqual({ kind: "picked", agentIds: ["ops"] });
    expect(t.llmCalls()).toBe(0);
  });
  it("on + 没问出来 / escalate / 没有型号 / 名册为空 → LLM", async () => {
    expect(await mk("on", async () => null).p).toEqual(llmVerdict);
    expect(await mk("on", async () => reply(0.5, [0.2, 0.2, 0.2])).p).toEqual(llmVerdict);
    expect(await mk("on", async () => reply(0.9, [0, 0, 0.9]), null).p).toEqual(llmVerdict);
  });
  it("shadow：LLM 说了算，日志里两边的判决都在", async () => {
    const t = mk("shadow", async () => reply(0.9, [0.1, 0.1, 0.9]));
    expect(await t.p).toEqual(llmVerdict);
    await new Promise((r) => setTimeout(r, 0));
    const line = JSON.parse(t.logs.find((l) => l.startsWith("[decision] "))!.replace("[decision] ", ""));
    expect(line).toMatchObject({ use: "dispatch", mode: "shadow", verdict: "picked:ops", legacy: "picked:dev" });
  });
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/runtime/decisionOwner.test.ts tests/runtime/dispatchDecision.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// services/runtime/src/decisionOwner.ts
// decisionOwner —— runtime 替**团队所有者**问决策模型（#1281）。
//
// runtime 独有的只有一样：怎么向网关证明身份（`x-runtime-secret` + on-behalf 头，云会话
// 统一走所有者的订阅额度，ADR-0233）。问什么、怎么验回包都在三端共用的 decision.ts 里。
// 这四个头原来在 autoModel / dispatch / sessionTitler 里各抄了一遍；这里是第四处用到它们
// 的地方，先收成一个函数——那三处不在这次改动的射程里，不顺手动。

import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../../src/shared/billing.js";
import { requestDecision, type DecisionReply, type DecisionRequest } from "../../../src/shared/decision.js";

export interface OwnerDecisionDeps {
  edgeBase: string;
  runtimeSecret: string;
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  /** 只有「替某一只 agent 判」的调用才带（Auto）。派活 / 重命名不属于任何一只：
      `usage_event.agent_id` 空串 = 未归因（ADR-0221） */
  agentId?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export function requestDecisionAsOwner(deps: OwnerDecisionDeps, req: DecisionRequest, timeoutMs: number): Promise<DecisionReply | null> {
  return requestDecision(
    {
      llmBase: `${deps.edgeBase}/llm/v1`,
      headers: {
        "x-runtime-secret": deps.runtimeSecret,
        [ON_BEHALF_HEADER]: deps.ownerUid,
        [WORKSPACE_HEADER]: deps.workspaceId,
        [SESSION_HEADER]: deps.sessionId,
        ...(deps.agentId ? { [AGENT_HEADER]: deps.agentId } : {}),
      },
      timeoutMs,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    req,
  );
}
```

```ts
// services/runtime/src/dispatchDecision.ts
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
/** 厂商自报 70–500ms，经 OpenRouter 与 edge 各多一跳。上游回 5xx / 429 是立刻回落，
    只有「挂住不回」才付满这一格，付完才开始今天那条 5 秒的 LLM 路 */
export const DISPATCH_DECISION_TIMEOUT_MS = 1200;

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
```

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/runtime/decisionOwner.test.ts tests/runtime/dispatchDecision.test.ts tests/runtime/dispatch.test.ts && npx tsc --noEmit -p .`
Expected: PASS（`dispatch.test.ts` 一条不改、照样全绿）

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/decisionOwner.ts services/runtime/src/dispatchDecision.ts tests/runtime/decisionOwner.test.ts tests/runtime/dispatchDecision.test.ts
git commit -m "feat(runtime): 派活前置决策模型——N+1 个是/否，拿不准的交给 LLM 而不是硬猜（#1281）"
```

---

### Task 8: Auto 判难度 —— noul 前置 + 今天那条 LLM 路补超时

**Files:**
- Modify: `src/shared/autoModel.ts`
- Modify: `services/runtime/src/autoModel.ts`
- Test: `tests/shared/autoModel.test.ts`, `tests/runtime/autoModel.test.ts`

**Interfaces:**
- Consumes: Task 1；Task 7 的 `requestDecisionAsOwner`
- Produces:
  - shared：`AUTO_SIMPLE_BELOW = 0.20`, `AUTO_DECISION_TIMEOUT_MS = 1200`, `AUTO_LLM_TIMEOUT_MS = 8000`, `autoQuestions(text)`, `difficultyFromHard(p): Difficulty`，`AutoModelDeps.decision?: { mode: DecisionModeState; ask: (state, questions) => Promise<DecisionReply | null> }`，`AutoModelDeps.llmTimeoutMs?: number`
  - runtime：`AutoModelDeps.decision?: { mode: DecisionModeState; model: string }`

- [ ] **Step 1: 写失败的测试**（两个文件各加一个 describe；`okRes` / `reply` 是各自文件里现成的帮手）

```ts
// tests/shared/autoModel.test.ts 末尾
import { AUTO_SIMPLE_BELOW, autoQuestions, difficultyFromHard } from "../../src/shared/autoModel.js";
import type { DecisionReply } from "../../src/shared/decision.js";

describe("决策模型前置（#1281）", () => {
  const MODELS = ["cheap", "mid", "strong"];
  const hard = (p: number): DecisionReply => ({ model: "jev-1.13.0", inputTokens: 50, answers: { hard: { type: "noul", noul: p } } });
  const llmSaysSimple = (async () => Response.json({ choices: [{ message: { content: "simple" } }] })) as typeof fetch;
  const neverFetch = (async () => { throw new Error("LLM 不该被打"); }) as typeof fetch;

  it("「拿不准算 hard」是一个阈值：P(hard) ≤ AUTO_SIMPLE_BELOW 才 simple", () => {
    expect(difficultyFromHard(AUTO_SIMPLE_BELOW)).toBe("simple");
    expect(difficultyFromHard(AUTO_SIMPLE_BELOW + 0.01)).toBe("hard");
    expect(difficultyFromHard(0.5)).toBe("hard");
  });
  it("autoQuestions：一个 noul，正文截断到 CLASSIFY_MAX_CHARS", () => {
    const { state, questions } = autoQuestions("字".repeat(5000));
    expect(Object.keys(questions)).toEqual(["hard"]);
    expect((state as { request: string }).request.length).toBe(1200);
  });
  it("on + 有答案：按它挑，LLM 一次都不打", async () => {
    const deps = { llmBase: "https://e/llm/v1", headers: {}, fetchImpl: neverFetch, decision: { mode: "on" as const, ask: async () => hard(0.05) } };
    expect(await pickAutoModel(deps, "你好", MODELS)).toBe("cheap");
    expect(await pickAutoModel({ ...deps, decision: { mode: "on" as const, ask: async () => hard(0.6) } }, "重构整个模块", MODELS)).toBe("strong");
  });
  it("on + 没问出来：原样走今天那条 LLM 路", async () => {
    const deps = { llmBase: "https://e/llm/v1", headers: {}, fetchImpl: llmSaysSimple, decision: { mode: "on" as const, ask: async () => null } };
    expect(await pickAutoModel(deps, "你好", MODELS)).toBe("cheap");
  });
  it("shadow：LLM 说了算", async () => {
    const deps = { llmBase: "https://e/llm/v1", headers: {}, fetchImpl: llmSaysSimple, decision: { mode: "shadow" as const, ask: async () => hard(0.99) } };
    expect(await pickAutoModel(deps, "你好", MODELS)).toBe("cheap");
  });
  it("清单不足两款：连决策都不问", async () => {
    let asked = false;
    const deps = { llmBase: "x", headers: {}, fetchImpl: neverFetch, decision: { mode: "on" as const, ask: async () => { asked = true; return hard(0.9); } } };
    expect(await pickAutoModel(deps, "x", ["only"])).toBeNull();
    expect(asked).toBe(false);
  });
  it("今天那条 LLM 路挂住不回：到点回 null（原来会把 turn 的起跑永久卡住）", async () => {
    const hang = ((_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_r, rej) => { init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); })) as typeof fetch;
    const logs: string[] = [];
    expect(await pickAutoModel({ llmBase: "x", headers: {}, fetchImpl: hang, llmTimeoutMs: 30, log: (m) => logs.push(m) }, "x", MODELS)).toBeNull();
    expect(logs.join()).toContain("超时");
  });
});
```

```ts
// tests/runtime/autoModel.test.ts 末尾
describe("runtime 接线：给了 decision 就经 /llm/v1/decision 替所有者问（#1281）", () => {
  it("on：打的是 /decision，带 agent 头；回 P(hard)=0.9 → 最贵那款", async () => {
    const seen: Request[] = [];
    const fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(i, init));
      return Response.json({ model: "jev-1.13.0", answers: { hard: { type: "noul", noul: 0.9 } } });
    }) as typeof fetch;
    const picked = await pickAutoModel(
      { edgeBase: "https://edge", runtimeSecret: "s", ownerUid: "o", workspaceId: "w", sessionId: "c", agentId: "dev", fetchImpl, decision: { mode: "on", model: "jev-1.13" } },
      "重构计费模块", ["cheap", "strong"],
    );
    expect(picked).toBe("strong");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://edge/llm/v1/decision");
    expect(seen[0]!.headers.get(AGENT_HEADER)).toBe("dev");
    expect((await seen[0]!.json()).use).toBe("auto");
  });
});
```

> `AGENT_HEADER` 从 `../../src/shared/billing.js` import（这个测试文件若还没 import 它，补上）。

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/shared/autoModel.test.ts tests/runtime/autoModel.test.ts`
Expected: FAIL（`autoQuestions` 不存在）

- [ ] **Step 3: 实现**

`src/shared/autoModel.ts`：

import 区（文件头注释之后）加：

```ts
import {
  noul, withDecision,
  type DecisionModeState, type DecisionOutcome, type DecisionQuestion, type DecisionReply, type DecisionState,
} from "./decision.js";
```

文件头注释末尾补一节：

```ts
//
// ## 决策模型前置（#1281）
//
// 给了 `deps.decision` 就先问它一个是/否：「这条请求需要强模型吗」。于是文件头那条
// 「拿不准算 hard」从提示词里的一句**请求**变成 `AUTO_SIMPLE_BELOW` 这个**阈值**——
// 模型听不听话不再是判据的一部分。没问出来（超时 / 网关 403 / 形状不对）原样走下面那条
// LLM 路，LLM 路再失败才是 null：两层回落，没有哪一层会比改动前更差。
```

常量与两个纯函数（放在 `modelForDifficulty` 之后）：

```ts
/** P(需要强模型) ≤ 它才走便宜那款；其余一律 hard。**初值**，由影子期的校准数据改。
    取 0.2 不取 0.5：判错往便宜了走是一整轮白跑，往贵了走只是这一轮多花点钱 */
export const AUTO_SIMPLE_BELOW = 0.2;
/** 调用方拼 `ask` 时用的超时。只有「挂住不回」才付满它，付完才开始 LLM 那条路 */
export const AUTO_DECISION_TIMEOUT_MS = 1200;
/** LLM 那条路的超时。**这是一个有意的行为改动**（#1281 探查时发现的旧账）：原来这里没有
    AbortController，一次挂住的网关调用会把 turn 的起跑永久卡住——派活（5s）与重命名（6s）
    都有，唯独这一处漏了 */
export const AUTO_LLM_TIMEOUT_MS = 8000;

export function difficultyFromHard(p: number): Difficulty {
  return p <= AUTO_SIMPLE_BELOW ? "simple" : "hard";
}

/** 是/否两格的说明逐条抄自 CLASSIFY_SYSTEM：两条路问的必须是同一个问题，
    不然影子期量出来的「一致率」量的是两份提示词的差别，不是两个模型的差别 */
export function autoQuestions(text: string): { state: DecisionState; questions: Record<string, DecisionQuestion> } {
  return {
    state: { request: text.slice(0, CLASSIFY_MAX_CHARS) },
    questions: {
      hard: noul(
        "用户发来了 `request` 这条请求。它需要强模型来处理吗？",
        "写代码或改代码、多步骤任务、需要推理或规划、数据分析、长文档处理、需求本身有歧义要先判断的",
        "闲聊、问候、简单问答、改一句话、格式转换、明确且范围很小的改动",
      ),
    },
  };
}
```

`AutoModelDeps` 加两格：

```ts
  /** 决策模型前置（#1281）。缺席 = 行为与改动前逐字相同。`ask` 由调用方拼好——型号、
      `use: "auto"`、超时、身份头都在它那一侧（两条路唯一的差别仍然是怎么证明身份） */
  decision?: {
    mode: DecisionModeState;
    ask: (state: DecisionState, questions: Record<string, DecisionQuestion>) => Promise<DecisionReply | null>;
  };
  /** LLM 那条路的超时；缺省 AUTO_LLM_TIMEOUT_MS。留成可注入只为测试不用等 8 秒 */
  llmTimeoutMs?: number;
```

把现有 `pickAutoModel` 的函数体整体改名为内部函数 `pickViaLlm(deps, text, models)`（签名相同），在里面补超时；再写新的 `pickAutoModel`：

```ts
async function pickViaLlm(deps: AutoModelDeps, text: string, models: readonly string[]): Promise<string | null> {
  const cheap = models[0]!;
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.llmTimeoutMs ?? AUTO_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${deps.llmBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...deps.headers },
      body: JSON.stringify({
        model: cheap,
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: text.slice(0, CLASSIFY_MAX_CHARS) },
        ],
        // （原注释保留：8 而不是 1 ……）
        max_tokens: 8,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      deps.log?.(`Auto 选型：网关回 ${res.status}，这一轮按原样走`);
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    const d = typeof content === "string" ? parseDifficulty(content) : null;
    if (d === null) {
      deps.log?.("Auto 选型：分类器没给出可识别的答案，这一轮按原样走");
      return null;
    }
    return modelForDifficulty(d, models);
  } catch (e) {
    deps.log?.(`Auto 选型：${controller.signal.aborted ? `分类器超时（${timeoutMs}ms）` : (e as Error).message}，这一轮按原样走`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function pickAutoModel(
  deps: AutoModelDeps,
  text: string,
  models: readonly string[]
): Promise<string | null> {
  if (models.length < 2) return null;
  const d = deps.decision;
  if (!d) return pickViaLlm(deps, text, models);
  return withDecision<string | null>({
    use: "auto",
    mode: d.mode,
    viaDecision: async (): Promise<DecisionOutcome<string | null>> => {
      const { state, questions } = autoQuestions(text);
      const a = (await d.ask(state, questions))?.answers.hard;
      if (!a || a.type !== "noul") return null;
      return { value: modelForDifficulty(difficultyFromHard(a.noul), models), scores: { hard: a.noul } };
    },
    viaLegacy: () => pickViaLlm(deps, text, models),
    show: (v) => v,
    ...(deps.log ? { log: deps.log } : {}),
  });
}
```

（原 `pickAutoModel` 上面那段 JSDoc 留在新的 `pickAutoModel` 上。）

`services/runtime/src/autoModel.ts`：

```ts
import { AUTO_DECISION_TIMEOUT_MS, pickAutoModel as pickShared } from "../../../src/shared/autoModel.js";
import type { DecisionModeState } from "../../../src/shared/decision.js";
import { requestDecisionAsOwner } from "./decisionOwner.js";
```

`AutoModelDeps` 加：

```ts
  /** 决策模型前置（#1281）。daemon 从所有者的 /me 快照里读出这一处的档位与型号再递进来；
      缺席 = 网关不供决策模型 = 行为与改动前逐字相同 */
  decision?: { mode: DecisionModeState; model: string };
```

`pickAutoModel` 里递给 `pickShared` 的那个对象末尾加：

```ts
      ...(deps.decision
        ? {
            decision: {
              mode: deps.decision.mode,
              ask: (state, questions) =>
                requestDecisionAsOwner(
                  {
                    edgeBase: deps.edgeBase, runtimeSecret: deps.runtimeSecret, ownerUid: deps.ownerUid,
                    workspaceId: deps.workspaceId, sessionId: deps.sessionId,
                    ...(deps.agentId ? { agentId: deps.agentId } : {}),
                    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
                    ...(deps.log ? { log: deps.log } : {}),
                  },
                  { model: deps.decision!.model, use: "auto", state, questions },
                  AUTO_DECISION_TIMEOUT_MS,
                ),
            },
          }
        : {}),
```

> 闭包里的 `deps.decision!` 若让 lint / tsc 不高兴，先在外面 `const dm = deps.decision;` 再引用 `dm.model`。

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/shared/autoModel.test.ts tests/runtime/autoModel.test.ts tests/main/agent.test.ts && npx tsc --noEmit -p .`
Expected: PASS（`agent.test.ts` 里既有的 Auto 用例一条不改、照样全绿——它们不给 `decision`，走的是原来那条路）

- [ ] **Step 5: Commit**

```bash
git add src/shared/autoModel.ts services/runtime/src/autoModel.ts tests/shared/autoModel.test.ts tests/runtime/autoModel.test.ts
git commit -m "feat(auto): 判难度前置决策模型——「拿不准算 hard」从一句请求变成一个阈值；LLM 那条路补上漏掉的超时（#1281）"
```

---

### Task 9: 云会话重命名的 KEEP 闸

**Files:**
- Modify: `services/runtime/src/sessionTitler.ts`
- Test: `tests/runtime/sessionTitler.test.ts`

**Interfaces:**
- Consumes: Task 1；Task 7 的 `requestDecisionAsOwner`
- Produces: `TITLE_KEEP_AT = 0.80`, `TITLE_DECISION_TIMEOUT_MS = 1500`, `titleKeepQuestions(input)`，`TitleDeps.decision?: { mode; ask }`，`OwnerTitleDeps.decision?: { mode; model: string }`

- [ ] **Step 1: 写失败的测试**（`tests/runtime/sessionTitler.test.ts` 末尾）

```ts
import { TITLE_KEEP_AT, titleKeepQuestions } from "../../services/runtime/src/sessionTitler.js";
import type { DecisionReply } from "../../src/shared/decision.js";

describe("KEEP 闸（#1281）：标题还说得清就一次 LLM 都不打", () => {
  const INPUT = { currentTitle: "修构建", context: ["[小红]: 构建为什么红了", "[开发]: 我看看"] };
  const fits = (p: number): DecisionReply => ({ model: "jev-1.13.0", inputTokens: 40, answers: { fits: { type: "noul", noul: p } } });
  const llmRenames = (async () => Response.json({ choices: [{ message: { content: "聊晚饭" } }] })) as typeof fetch;
  const neverFetch = (async () => { throw new Error("LLM 不该被打"); }) as typeof fetch;
  const deps = (fetchImpl: typeof fetch, ask: () => Promise<DecisionReply | null>, mode: "shadow" | "on" = "on") =>
    ({ llmBase: "https://e/llm/v1", headers: {}, fetchImpl, decision: { mode, ask } });

  it("titleKeepQuestions：一个 noul，标题与对话都在 state 里", () => {
    const { state, questions } = titleKeepQuestions(INPUT);
    expect(Object.keys(questions)).toEqual(["fits"]);
    expect(state).toMatchObject({ title: "修构建", recent: INPUT.context });
  });
  it("P(还对得上) ≥ TITLE_KEEP_AT → null（= KEEP），LLM 一次都不打", async () => {
    expect(await requestTitle(deps(neverFetch, async () => fits(TITLE_KEEP_AT)), INPUT, ["cheap"])).toBeNull();
  });
  it("低于它 → 交给 LLM 起名（Jev 写不了字，它只挡在前面）", async () => {
    expect(await requestTitle(deps(llmRenames, async () => fits(0.3)), INPUT, ["cheap"])).toEqual({ title: "聊晚饭", model: "cheap" });
  });
  it("没问出来 → LLM", async () => {
    expect(await requestTitle(deps(llmRenames, async () => null), INPUT, ["cheap"])).toEqual({ title: "聊晚饭", model: "cheap" });
  });
  it("还没有标题：不问决策（没有东西可 KEEP）", async () => {
    let asked = false;
    const d = deps(llmRenames, async () => { asked = true; return fits(0.99); });
    expect(await requestTitle(d, { ...INPUT, currentTitle: "  " }, ["cheap"])).toEqual({ title: "聊晚饭", model: "cheap" });
    expect(asked).toBe(false);
  });
  it("shadow：LLM 说了算", async () => {
    expect(await requestTitle(deps(llmRenames, async () => fits(0.99), "shadow"), INPUT, ["cheap"])).toEqual({ title: "聊晚饭", model: "cheap" });
  });
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/runtime/sessionTitler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

import 区加：

```ts
import {
  noul, withDecision,
  type DecisionModeState, type DecisionOutcome, type DecisionQuestion, type DecisionReply, type DecisionState,
} from "../../../src/shared/decision.js";
import { requestDecisionAsOwner } from "./decisionOwner.js";
```

常量与纯函数（放在 `titlePrompt` 之后）：

```ts
/** P(当前标题还说得清这段对话) 到它 = KEEP，一次 LLM 都不打。**初值**。
    取高不取低：判错成 KEEP 的代价是标题晚改一轮（5 句人话之后还会再判），
    判错成「要改」的代价只是多打一次今天本来就会打的 LLM——而它自己仍然可以回 KEEP */
export const TITLE_KEEP_AT = 0.8;
export const TITLE_DECISION_TIMEOUT_MS = 1500;

/** 决策模型写不了标题，所以它只回答那一步里**不用生成文字**的那一半：还用不用改。
    今天每 5 句人话打一次 LLM，多数轮回 KEEP——为了一个「不用改」的答案付一次完整调用 */
export function titleKeepQuestions(input: TitleInput): { state: DecisionState; questions: Record<string, DecisionQuestion> } {
  return {
    state: { title: promptSafe(input.currentTitle.trim()), recent: input.context.map((l) => promptSafeBody(l)) },
    questions: {
      fits: noul(
        "`title` 是这段群聊此刻的标题，`recent` 是最近的对话。这个标题还说得清这段对话在聊什么吗？",
        "对话仍然围绕标题说的那件事，或者是它的自然延续",
        "话题确实换了，标题已经对不上现在在聊的事",
      ),
    },
  };
}
```

`TitleDeps` 加：

```ts
  /** KEEP 闸（#1281）。缺席 = 行为与改动前逐字相同 */
  decision?: {
    mode: DecisionModeState;
    ask: (state: DecisionState, questions: Record<string, DecisionQuestion>) => Promise<DecisionReply | null>;
  };
```

把现有 `requestTitle` 的函数体整体改名为内部函数 `requestTitleViaLlm`（签名相同、一字不改），再写新的 `requestTitle`（原 JSDoc 留在它上面）：

```ts
export async function requestTitle(
  deps: TitleDeps,
  input: TitleInput,
  models: readonly string[]
): Promise<TitleVerdict | null> {
  const d = deps.decision;
  // 还没有标题 = 没有东西可 KEEP，直接起名
  if (!d || input.currentTitle.trim() === "") return requestTitleViaLlm(deps, input, models);
  return withDecision<TitleVerdict | null>({
    use: "title",
    mode: d.mode,
    viaDecision: async (): Promise<DecisionOutcome<TitleVerdict | null>> => {
      const { state, questions } = titleKeepQuestions(input);
      const a = (await d.ask(state, questions))?.answers.fits;
      if (!a || a.type !== "noul") return null;
      const scores = { fits: a.noul };
      // `value: null` 是一个**答案**（KEEP），不是「没答案」——withDecision 分得清这两样
      return a.noul >= TITLE_KEEP_AT ? { value: null, scores } : { escalate: true, scores };
    },
    viaLegacy: () => requestTitleViaLlm(deps, input, models),
    show: (v) => (v === null ? "KEEP" : "renamed"),
    ...(deps.log ? { log: deps.log } : {}),
  });
}
```

`OwnerTitleDeps` 加 `decision?: { mode: DecisionModeState; model: string };`，`requestTitleAsOwner` 里递给 `requestTitle` 的对象末尾加（形状同 Task 8 runtime 那段，`use: "title"`、超时 `TITLE_DECISION_TIMEOUT_MS`、**不带 agentId**）：

```ts
      ...(deps.decision
        ? {
            decision: {
              mode: deps.decision.mode,
              ask: (state: DecisionState, questions: Record<string, DecisionQuestion>) =>
                requestDecisionAsOwner(
                  {
                    edgeBase: deps.edgeBase, runtimeSecret: deps.runtimeSecret, ownerUid: deps.ownerUid,
                    workspaceId: deps.workspaceId, sessionId: deps.sessionId,
                    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
                    ...(deps.log ? { log: deps.log } : {}),
                  },
                  { model: deps.decision!.model, use: "title", state, questions },
                  TITLE_DECISION_TIMEOUT_MS,
                ),
            },
          }
        : {}),
```

> `show` 故意只写 `"renamed"` 不写标题正文：日志行不该带会话内容。

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/runtime/sessionTitler.test.ts && npx tsc --noEmit -p .`
Expected: PASS（既有用例一条不改）

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/sessionTitler.ts tests/runtime/sessionTitler.test.ts
git commit -m "feat(runtime): 重命名前置 KEEP 闸——标题还说得清就一次 LLM 都不打（#1281）"
```

---

### Task 10: `daemon.ts` 三个注入点接线

**Files:**
- Modify: `services/runtime/src/daemon.ts`（`pickAutoModel` 约 :554、`dispatch` 约 :578、`retitle` 约 :637）
- Test: `tests/runtime/daemonDecisionWiring.test.ts`（新）

**Interfaces:**
- Consumes: Task 1 `modeOf` / `decisionModelOf`；Task 7 `dispatchVia` / `requestDecisionAsOwner` / `DISPATCH_DECISION_TIMEOUT_MS`；Task 8 / 9 的 `decision` 依赖
- Produces: 无新符号。**`services/runtime/src/sessionService.ts` 一个字不改**（与 #1280 的约定）。

`daemon.ts` 一 import 就要连 docker / Supabase，进不了 vitest（AGENTS.md 里 ADR-0287 那条同样的处境），所以接线的保鲜期是一条**读源码**的断言。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/runtime/daemonDecisionWiring.test.ts
// daemon.ts 进不了 vitest（import 即连 docker / Supabase），而三处决策前置的接线全在它
// 身上：漏接一处的失败模式是**安静的**——那一处永远走原来那条路，没有任何一条测试会红。
// 所以判据落在源码上（同 tests/runtime/sandbox.test.ts 对 freeKib 的处置）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：三处决策前置都接上了（#1281）", () => {
  it.each(["dispatch", "auto", "title"])("读了「%s」这一处的开关", (use) => {
    expect(src).toContain(`modeOf(me, "${use}")`);
  });
  it("型号从同一份 /me 快照里取，不写死", () => {
    expect(src).toContain("decisionModelOf(me)");
    expect(src).not.toMatch(/["']jev-/);
  });
  it("派活走 dispatchVia，且 LLM 那条路仍然是 requestDispatchAsOwner", () => {
    expect(src).toMatch(/dispatchVia\(\{[\s\S]*?llm:\s*\(\)\s*=>\s*requestDispatchAsOwner\(/);
  });
});
```

另加一条守住约定的断言（同一个文件）：

```ts
it("sessionService.ts 不认识决策模型（只在 daemon 的注入点包一层，#1280 的约定）", () => {
  const svc = readFileSync(new URL("../../services/runtime/src/sessionService.ts", import.meta.url), "utf8");
  expect(svc).not.toMatch(/shared\/decision\.js|dispatchDecision|decisionOwner/);
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/runtime/daemonDecisionWiring.test.ts`
Expected: FAIL（前三组）

- [ ] **Step 3: 实现**

import 区加：

```ts
import { decisionModelOf, modeOf } from "../../../src/shared/decision.js";
import { requestDecisionAsOwner } from "./decisionOwner.js";
import { DISPATCH_DECISION_TIMEOUT_MS, dispatchVia } from "./dispatchDecision.js";
```

`pickAutoModel` 那个闭包：在 `return pickAutoModel(` 之前取型号，递进去的对象末尾多一格——

```ts
        // 决策模型前置（#1281）：这一处开着哪一档、网关供哪一款，都从**同一份** /me 快照里读
        // （edge 里那张开关表随它下发，60s 缓存）——翻一格最迟一分钟生效，不用重启 daemon
        const decisionModel = decisionModelOf(me);
        return pickAutoModel(
          {
            // …（原来那七格不变）
            ...(decisionModel !== null ? { decision: { mode: modeOf(me, "auto"), model: decisionModel } } : {}),
          },
          text,
          me.models
        );
```

`dispatch` 那个闭包：三条 `me` 判断不变，`return requestDispatchAsOwner(…)` 换成——

```ts
        const owner = {
          edgeBase: config.edgeBase,
          runtimeSecret: config.runtimeSecret,
          ownerUid,
          workspaceId,
          sessionId,
          log: (m: string) => console.warn(`[otto-runtime] ${m}（session=${sessionId}）`),
        };
        // 决策模型前置（#1281）：有把握的当场判，拿不准 / 没问出来的照旧交给下面那条 LLM 路——
        // failed 与群里那句「没派出去」仍然只由它说
        return dispatchVia({
          mode: modeOf(me, "dispatch"),
          model: decisionModelOf(me),
          input,
          decide: (req) => requestDecisionAsOwner(owner, req, DISPATCH_DECISION_TIMEOUT_MS),
          llm: () => requestDispatchAsOwner(owner, input, me.models),
          log: owner.log,
        });
```

`retitle` 那个闭包：同 `pickAutoModel` 的改法，`modeOf(me, "title")`。

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/runtime/ && npx tsc --noEmit -p .`
Expected: PASS。`services/runtime` 若有自己的 tsconfig（`ls services/runtime/tsconfig*.json`），也跑一遍。

- [ ] **Step 5: Commit**

```bash
git add services/runtime/src/daemon.ts tests/runtime/daemonDecisionWiring.test.ts
git commit -m "feat(runtime): daemon 的三个注入点接上决策前置——开关与型号从同一份 /me 快照读，sessionService 不动（#1281）"
```

---

### Task 11: 桌面的 `decisionClient` + Auto 接线

**Files:**
- Create: `src/main/decisionClient.ts`
- Modify: `src/main/agent.ts`（`HostedCapability` :112-116、`pickAutoModel` :1067-1087）
- Modify: `src/main/index.ts`（`hostedDeps` 约 :1595）
- Test: `tests/main/decisionClient.test.ts`（新）、`tests/main/agent.test.ts`（Auto 那组末尾加一条）

**Interfaces:**
- Consumes: Task 1；Task 8 的 `AUTO_DECISION_TIMEOUT_MS` 与 `AutoModelDeps.decision`
- Produces:
  - `interface DecisionClient { mode(use: DecisionUse): DecisionModeState; decide(use, state, questions, timeoutMs): Promise<DecisionReply | null> }`
  - `createDecisionClient(deps: DecisionClientDeps): DecisionClient`
  - `HostedCapability.decision?: DecisionClient`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/main/decisionClient.test.ts
import { describe, expect, it } from "vitest";
import { createDecisionClient } from "../../src/main/decisionClient.js";
import { noul } from "../../src/shared/decision.js";
import type { BillingMe } from "../../src/shared/billing.js";

const ME = (uses: Record<string, "shadow" | "on">, models = ["jev-1.13"]): BillingMe => ({
  plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  models: ["cheap", "strong"], imageModels: [], ttsModels: [], modelPlatforms: {}, decision: { models, uses },
});
function rig(o: { me: BillingMe | null; subscribed?: boolean; exhausted?: boolean; token?: string | null; res?: () => Response }) {
  const noted: { headers: number; exhausted: unknown[] } = { headers: 0, exhausted: [] };
  const seen: Request[] = [];
  const client = createDecisionClient({
    quota: {
      snapshot: () => ({ me: o.me, fetchedAt: 0, exhausted: null }),
      routeInput: () => ({ subscribed: o.subscribed ?? true, exhausted: o.exhausted ?? false, supportsModel: false }),
      noteHeaders: () => { noted.headers++; },
      noteExhausted: (i) => { noted.exhausted.push(i); },
    },
    edgeBaseUrl: () => "https://edge",
    accessToken: async () => (o.token === undefined ? "jwt" : o.token),
    fetchImpl: (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(i, init));
      return (o.res ?? (() => Response.json({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.4 } } })))();
    }) as typeof fetch,
  });
  return { client, seen, noted };
}
const Q = { q: noul("问", "是", "否") };

describe("decisionClient.mode：任何一格不过都是 off", () => {
  it("没快照 / 没订阅 / 额度用完 / 网关不供 / 这一处没列", () => {
    expect(rig({ me: null }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ auto: "on" }), subscribed: false }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ auto: "on" }), exhausted: true }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ auto: "on" }, []) }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ dispatch: "on" }) }).client.mode("auto")).toBe("off");
  });
  it("都过了：回那一档", () => {
    expect(rig({ me: ME({ auto: "shadow" }) }).client.mode("auto")).toBe("shadow");
  });
});

describe("decisionClient.decide", () => {
  it("off：一个字节都不发", async () => {
    const r = rig({ me: ME({}) });
    expect(await r.client.decide("auto", "x", Q, 100)).toBeNull();
    expect(r.seen).toHaveLength(0);
  });
  it("拿不到 JWT：不发空 Bearer", async () => {
    const r = rig({ me: ME({ auto: "on" }), token: null });
    expect(await r.client.decide("auto", "x", Q, 100)).toBeNull();
    expect(r.seen).toHaveLength(0);
  });
  it("成功：带用户 JWT 打 /llm/v1/decision，型号取快照里那一款，记额度头", async () => {
    const r = rig({ me: ME({ auto: "on" }) });
    const reply = await r.client.decide("auto", { request: "你好" }, Q, 100);
    expect(reply?.answers.q).toEqual({ type: "noul", noul: 0.4 });
    expect(r.seen[0]!.url).toBe("https://edge/llm/v1/decision");
    expect(r.seen[0]!.headers.get("authorization")).toBe("Bearer jwt");
    expect(await r.seen[0]!.json()).toMatchObject({ model: "jev-1.13", use: "auto" });
    expect(r.noted.headers).toBe(1);
  });
  it("429 quota_exhausted：记 noteExhausted（界面上那枚环跟着动），回 null", async () => {
    const r = rig({
      me: ME({ auto: "on" }),
      res: () => new Response(JSON.stringify({ error: { message: "5 小时额度已用完", type: "otto_edge", code: "quota_exhausted", window: "5h", resetAt: 123 } }), { status: 429 }),
    });
    expect(await r.client.decide("auto", "x", Q, 100)).toBeNull();
    expect(r.noted.exhausted).toEqual([{ window: "5h", resetAt: 123 }]);
  });
});
```

`tests/main/agent.test.ts` 的 Auto 那组（:196-256）末尾，照那一组既有用例的装配方式加一条：`hosted` 里多给 `decision: { mode: () => "on", decide: async () => ({ model: "jev-1.13.0", inputTokens: 1, answers: { hard: { type: "noul", noul: 0.9 } } }) }`，把全局 `fetch` 桩成「一被调就抛」，断言 `pickAutoModel("重构计费模块")` 之后日志里多了一条 `model_changed`、`model` 是清单里最后一款、`auto === true`。

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/main/decisionClient.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/main/decisionClient.ts
// decisionClient —— 桌面主进程问决策模型的那一条路（#1281）。
//
// 路是「桌面主进程 → edge 网关 `/llm/v1/decision` → OpenRouter」，与 teamVoice / generate_image
// 同一个形状：官方 key 只在 Worker secret 里，钱记在**用户自己**的订阅额度上（自己的 JWT），
// hold / settle / usage_event 整套现成。
//
// 与那两条路不同的一处：**这里从不向用户报错**。出图 / 语音 blocked 时要说清四种情形各是
// 什么（没订阅 / 额度用完 / 网关不供 / 拿不到 JWT），因为用户点了一颗钮在等结果；决策调用
// 是用户看不见的前置判断，任何一格不过都只有一个后果——`mode` 回 off / `decide` 回 null，
// 调用方走原来那条路。所以没有 routeDecision / decisionBlocked 那一对，原因只进日志。
//
// 「订阅 / 额度用完」两格读 `routeInput("")`，与聊天、出图、语音**同源**：各判一遍就会出现
// 「聊天说额度用完了、决策却照跑」。空串同 index.ts 的 `isSubscribed()`——那两格与问哪一款无关。

import { parseBillingError } from "../shared/billing.js";
import {
  decisionModelOf, modeOf, requestDecision,
  type DecisionModeState, type DecisionQuestion, type DecisionReply, type DecisionState, type DecisionUse,
} from "../shared/decision.js";
import type { HostedQuota } from "./hostedQuota.js";

export interface DecisionClientDeps {
  quota: Pick<HostedQuota, "snapshot" | "routeInput" | "noteHeaders" | "noteExhausted">;
  edgeBaseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface DecisionClient {
  /** 这一处此刻开着哪一档。**同步**：渲染层 / 工具要据此决定「要不要走那套逻辑」，
      而拿 JWT 是异步的——同 ttsBlocked 与 routeTts 拆两半的理由 */
  mode(use: DecisionUse): DecisionModeState;
  decide(
    use: DecisionUse,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    timeoutMs: number,
  ): Promise<DecisionReply | null>;
}

export function createDecisionClient(deps: DecisionClientDeps): DecisionClient {
  const mode = (use: DecisionUse): DecisionModeState => {
    const r = deps.quota.routeInput("");
    if (!r.subscribed || r.exhausted) return "off";
    return modeOf(deps.quota.snapshot().me, use);
  };
  return {
    mode,
    async decide(use, state, questions, timeoutMs) {
      if (mode(use) === "off") return null;
      const model = decisionModelOf(deps.quota.snapshot().me);
      if (model === null) return null;
      const token = await deps.accessToken();
      if (!token) return null; // 不发空 Bearer
      return requestDecision(
        {
          llmBase: `${deps.edgeBaseUrl()}/llm/v1`,
          headers: { authorization: `Bearer ${token}` },
          timeoutMs,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.log ? { log: deps.log } : {}),
          // 额度头与 chat / 语音那条路同一份纪律：成功就 noteHeaders，429 quota_exhausted 就 noteExhausted
          onResponse: async (res) => {
            if (res.ok) return deps.quota.noteHeaders(res.headers);
            const e = parseBillingError(res.status, await res.json().catch(() => null));
            if (e?.code === "quota_exhausted") {
              deps.quota.noteExhausted({ ...(e.window ? { window: e.window } : {}), ...(e.resetAt !== undefined ? { resetAt: e.resetAt } : {}) });
            }
          },
        },
        { model, use, state, questions },
      );
    },
  };
}
```

`src/main/agent.ts`：

```ts
import { AUTO_DECISION_TIMEOUT_MS, pickAutoModel as pickAutoModelShared } from "../shared/autoModel.js";
import type { DecisionClient } from "./decisionClient.js";
```

`HostedCapability` 加一格：

```ts
  /** 决策模型（#1281）。**可选**：缺席 = 行为与改动前逐字相同，所以没装配托管的那些装配
      （探针 / 测试 / 裸装配）不用动；装配了的三处（主会话 / 子 agent / 子会话重建）跟着
      `hostedDeps` 这一个对象原样接住——同这个接口具名的理由 */
  decision?: DecisionClient;
```

`pickAutoModel` 里递给 `pickAutoModelShared` 的对象，`log` 之后加：

```ts
          // 决策模型前置（#1281）：开着哪一档由 edge 下发的那张表说了算；off 时 shared 那一层
          // 一下都不碰 `ask`，所以这里无条件递进去
          ...(h.decision
            ? {
                decision: {
                  mode: h.decision.mode("auto"),
                  ask: (state, questions) => h.decision!.decide("auto", state, questions, AUTO_DECISION_TIMEOUT_MS),
                },
              }
            : {}),
```

> 闭包里的 `h.decision!`：先 `const dc = h.decision;` 再用 `dc`，别留非空断言。

`src/main/index.ts`：把

```ts
  const hostedDeps = {
    quota: hostedQuota,
    edgeBaseUrl: () => edgeBaseUrl(),
    accessToken: () => accountManager?.getAccessToken() ?? Promise.resolve(null),
  };
```

改成

```ts
  const hostedBase = {
    quota: hostedQuota,
    edgeBaseUrl: () => edgeBaseUrl(),
    accessToken: () => accountManager?.getAccessToken() ?? Promise.resolve(null),
  };
  // 决策模型（#1281）：五处分类器的前置判断走这一条。挂在 hostedDeps 上而不是单独往下递——
  // 主会话 / 子 agent / 子会话重建三处本来就原样接住这个对象，单独递就要三处各接一次
  const decisionClient = createDecisionClient({ ...hostedBase, log: (m) => console.warn(m) });
  const hostedDeps = { ...hostedBase, decision: decisionClient };
```

并 `import { createDecisionClient } from "./decisionClient.js";`

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/main/decisionClient.test.ts tests/main/agent.test.ts tests/main/subagentAgent.test.ts tests/main/teamVoice.test.ts && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/decisionClient.ts src/main/agent.ts src/main/index.ts tests/main/decisionClient.test.ts tests/main/agent.test.ts
git commit -m "feat(main): 桌面的决策通道 + Auto 接线——订阅/额度两格与聊天同源，任何一格不过都只是走原来那条路（#1281）"
```

---

### Task 12: 语音「扣住再合并」的纯状态机 `utteranceHold.ts`

**Files:**
- Create: `src/renderer/src/lib/utteranceHold.ts`
- Test: `tests/renderer/utteranceHold.test.ts`

**Interfaces:**
- Consumes: 无（纯逻辑，不 import 任何东西）
- Produces:
  - `HOLD_BELOW = 0.35`, `HOLD_MS = 1800`, `VERDICT_WAIT_MS = 200`, `HOLD_MAX_MERGES = 3`, `HOLD_MAX_AGE_MS = 8000`
  - `interface HoldState`, `HOLD_IDLE: HoldState`
  - `type HoldEvent = {type:"quiet";text} | {type:"verdict";key;p:number|null} | {type:"partial";text} | {type:"final";text} | {type:"tick"} | {type:"reset"}`
  - `type HoldEffect = {type:"judge";key;text} | {type:"send";text} | {type:"wake";at:number}`
  - `holdStep(s, ev, now, opts: { hold: boolean }): { state: HoldState; effects: HoldEffect[] }`
  - `joinSpoken(a, b): string`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/renderer/utteranceHold.test.ts
import { describe, expect, it } from "vitest";
import {
  HOLD_BELOW, HOLD_IDLE, HOLD_MAX_AGE_MS, HOLD_MAX_MERGES, HOLD_MS, VERDICT_WAIT_MS, holdStep, joinSpoken,
  type HoldEffect, type HoldEvent, type HoldState,
} from "../../src/renderer/src/lib/utteranceHold.js";

/** 把一串 (事件, 时刻) 喂进去，收集全部副作用 */
function run(steps: [HoldEvent, number][], hold = true, from: HoldState = HOLD_IDLE) {
  let state = from;
  const effects: HoldEffect[] = [];
  for (const [ev, now] of steps) {
    const r = holdStep(state, ev, now, { hold });
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects, sent: effects.filter((e) => e.type === "send").map((e) => (e as { text: string }).text) };
}

describe("joinSpoken", () => {
  it("中文直接接，两头都是 ASCII 才补空格", () => {
    expect(joinSpoken("", "你好")).toBe("你好");
    expect(joinSpoken("我想让你。", "帮我看一下")).toBe("我想让你。帮我看一下");
    expect(joinSpoken("push to", "main")).toBe("push to main");
  });
});

describe("停嘴那一刻投机问一次", () => {
  it("quiet → judge；同一段文字只问一次；太短不问", () => {
    const r = run([[{ type: "quiet", text: "帮我看一下构建" }, 0], [{ type: "quiet", text: "帮我看一下构建" }, 50], [{ type: "quiet", text: "嗯" }, 60]]);
    expect(r.effects).toEqual([{ type: "judge", key: "帮我看一下构建", text: "帮我看一下构建" }]);
  });
  it("扣着的时候问的是**合起来**的那句，key 仍是新那一段", () => {
    const held: HoldState = { ...HOLD_IDLE, buffer: "我想让你。", merges: 1, heldSince: 0, flushAt: 1800 };
    const r = run([[{ type: "quiet", text: "帮我看一下构建" }, 100]], true, held);
    expect(r.effects).toEqual([{ type: "judge", key: "帮我看一下构建", text: "我想让你。帮我看一下构建" }]);
  });
});

describe("final 到了", () => {
  it("答案已到且说完了 → 同一拍发出去", () => {
    const r = run([[{ type: "quiet", text: "好的谢谢" }, 0], [{ type: "verdict", key: "好的谢谢", p: 0.95 }, 300], [{ type: "final", text: "好的谢谢" }, 700]]);
    expect(r.sent).toEqual(["好的谢谢"]);
  });
  it("答案已到且没说完 → 扣住，起一只 HOLD_MS 的表", () => {
    const r = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: HOLD_BELOW - 0.01 }, 300], [{ type: "final", text: "我想让你。" }, 700]]);
    expect(r.sent).toEqual([]);
    expect(r.state.buffer).toBe("我想让你。");
    expect(r.effects.at(-1)).toEqual({ type: "wake", at: 700 + HOLD_MS });
  });
  it("扣着、人接着说了、下一句说完了 → 合并成一条发", () => {
    const r = run([
      [{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.1 }, 300], [{ type: "final", text: "我想让你。" }, 700],
      [{ type: "partial", text: "帮我" }, 1200],
      [{ type: "quiet", text: "帮我看一下构建。" }, 2500], [{ type: "verdict", key: "帮我看一下构建。", p: 0.9 }, 2800], [{ type: "final", text: "帮我看一下构建。" }, 3200],
    ]);
    expect(r.sent).toEqual(["我想让你。帮我看一下构建。"]);
    expect(r.state.buffer).toBe("");
  });
  it("扣着、人没再开口 → 表到点把扣着的发出去", () => {
    const r = run([
      [{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.1 }, 300], [{ type: "final", text: "我想让你。" }, 700],
      [{ type: "tick" }, 700 + HOLD_MS - 1], [{ type: "tick" }, 700 + HOLD_MS],
    ]);
    expect(r.sent).toEqual(["我想让你。"]);
  });
  it("答案还在路上 → 最多等 VERDICT_WAIT_MS；到点按说完了算", () => {
    const r = run([[{ type: "quiet", text: "帮我看一下构建" }, 0], [{ type: "final", text: "帮我看一下构建" }, 700]]);
    expect(r.sent).toEqual([]);
    expect(r.effects.at(-1)).toEqual({ type: "wake", at: 700 + VERDICT_WAIT_MS });
    const after = holdStep(r.state, { type: "tick" }, 700 + VERDICT_WAIT_MS, { hold: true });
    expect(after.effects).toEqual([{ type: "send", text: "帮我看一下构建" }]);
  });
  it("等的那一下里答案回来了 → 当场按它判", () => {
    const r = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "final", text: "我想让你。" }, 700], [{ type: "verdict", key: "我想让你。", p: 0.05 }, 800]]);
    expect(r.sent).toEqual([]);
    expect(r.state.buffer).toBe("我想让你。");
  });
  it("从没问过（quiet 没来过）→ 照今天的发", () => {
    expect(run([[{ type: "final", text: "你好" }, 0]]).sent).toEqual(["你好"]);
  });
  it("judge 失败（p 是 null）→ 按说完了算", () => {
    const r = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: null }, 300], [{ type: "final", text: "我想让你。" }, 700]]);
    expect(r.sent).toEqual(["我想让你。"]);
  });
});

describe("两道封顶", () => {
  it(`最多连扣 ${HOLD_MAX_MERGES} 次，第 ${HOLD_MAX_MERGES + 1} 句无论如何发出去`, () => {
    const steps: [HoldEvent, number][] = [];
    for (let i = 0; i <= HOLD_MAX_MERGES; i++) {
      const t = `第${i}段，`;
      const at = i * 1000;
      steps.push([{ type: "quiet", text: t }, at], [{ type: "verdict", key: t, p: 0.01 }, at + 100], [{ type: "final", text: t }, at + 200]);
    }
    const r = run(steps);
    expect(r.sent).toEqual(["第0段，第1段，第2段，第3段，"]);
  });
  it("人一直在说：从第一次扣住起 HOLD_MAX_AGE_MS 到点，把扣着的先发出去", () => {
    const r = run([
      [{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.1 }, 100], [{ type: "final", text: "我想让你。" }, 200],
      [{ type: "partial", text: "帮" }, 500],
    ]);
    expect(r.effects.at(-1)).toEqual({ type: "wake", at: 200 + HOLD_MAX_AGE_MS });
    const after = holdStep(r.state, { type: "tick" }, 200 + HOLD_MAX_AGE_MS, { hold: true });
    expect(after.effects).toEqual([{ type: "send", text: "我想让你。" }]);
  });
});

describe("hold:false（影子期 / 没开）：照问不误，但一拍都不耽误", () => {
  it("答案说没说完也照发；答案在路上也不等", () => {
    const a = run([[{ type: "quiet", text: "我想让你。" }, 0], [{ type: "verdict", key: "我想让你。", p: 0.01 }, 300], [{ type: "final", text: "我想让你。" }, 700]], false);
    expect(a.sent).toEqual(["我想让你。"]);
    const b = run([[{ type: "quiet", text: "帮我看一下" }, 0], [{ type: "final", text: "帮我看一下" }, 700]], false);
    expect(b.sent).toEqual(["帮我看一下"]);
  });
});

describe("reset（关麦 / 换会话）", () => {
  it("扣着的那句照样发出去——人确实说了", () => {
    const held: HoldState = { ...HOLD_IDLE, buffer: "我想让你。", merges: 1, heldSince: 0, flushAt: 1800 };
    const r = holdStep(held, { type: "reset" }, 100, { hold: true });
    expect(r.effects).toEqual([{ type: "send", text: "我想让你。" }]);
    expect(r.state).toEqual(HOLD_IDLE);
  });
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/renderer/utteranceHold.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/renderer/src/lib/utteranceHold.ts
// utteranceHold —— 语音通话里「这句话说完了吗」的扣住 / 合并状态机（#1281，spec §5.4 ⑤）。
//
// 病：helper 的 `utteranceLooksFinished` 是标点启发式（句末标点 = 说完），而识别器在人
// 换气时就补句号——于是 700ms 收口，一句「我想让你。帮我看一下构建。」切成两条发出去，
// 前半条还会先起一轮 turn（#1196 的同一族）。
//
// 治法：人一停嘴（能量门从真变假）就**投机**问一次决策模型「这句说完了吗」；700ms 之后
// helper 的 `final` 到时答案通常已经回来——判「没说完」就把这句扣住，等下一句来了合并成
// 一条再发。全程不动 Swift：重编 helper 要维护者重新点一次 TCC 授权（ADR-0273 / 0277）。
// 所以**只治切碎，不治另一半**（没标点的整句白等 2.5s——那要给 helper 加 `commit` 命令）。
//
// 纯函数：时间与副作用全部从外面来（同 Swift 那个 `Endpointer` 的写法，测试不用等）。
// 调用方（store.ts）把 `judge` 变成一次 IPC、把 `wake` 变成一个 setTimeout、把 `send`
// 变成 cloudSay。
//
// 三条保命线：
//   ① **判不出来 = 说完了**：答案没到 / 问失败 / 从没问过，一律照今天的发。
//   ② 两道封顶：最多连扣 HOLD_MAX_MERGES 次；从第一次扣住起 HOLD_MAX_AGE_MS 无论如何发。
//      决策模型判错的最坏后果因此是「这句话晚 1.8 秒出门」，不是「这句话没了」。
//   ③ `hold: false`（影子期）：照问不误（主进程那侧据此记对照日志），但**一拍都不耽误**
//      ——连「等答案那 200ms」都不等。

/** P(说完了) 低于它才扣。**初值**，由影子期的真值数据改：那一处的真值是观测得到的
    （final 之后 1.8 秒内人有没有接着说），主进程的 endpointJudge 在记 */
export const HOLD_BELOW = 0.35;
/** 扣住之后等人接着说的时长。取 1.8s：helper 对「没说完」的句子本来就肯等 2.5s */
export const HOLD_MS = 1800;
/** final 到了、答案还在路上：最多再等这么久。投机问是在 ≥700ms 之前发出的，
    正常情况下答案早到了；这一格只兜「这一次特别慢」 */
export const VERDICT_WAIT_MS = 200;
export const HOLD_MAX_MERGES = 3;
export const HOLD_MAX_AGE_MS = 8000;
const VERDICTS_KEPT = 8;
/** 「嗯」「好」不值得问：一个字的应声怎么判都是说完了 */
const MIN_JUDGE_CHARS = 2;

export interface HoldState {
  /** 扣着的文字；空串 = 没扣着 */
  buffer: string;
  merges: number;
  /** 第一次扣住的时刻（总封顶从它起算） */
  heldSince: number | null;
  /** 哪一刻该把 buffer 发出去；null = 没有表在走 */
  flushAt: number | null;
  /** 最近几段的答案，按「新那一段」的文字记（不按合起来的那句——final 到时手里只有新那一段） */
  verdicts: readonly { key: string; p: number }[];
  /** 在途那一问的 key。同一时刻最多一个：网关按人限 4 个并发，语音不该挤掉聊天那条流 */
  asked: string | null;
  /** final 到了、答案没到 */
  waiting: { text: string; until: number } | null;
}

export const HOLD_IDLE: HoldState = { buffer: "", merges: 0, heldSince: null, flushAt: null, verdicts: [], asked: null, waiting: null };

export type HoldEvent =
  | { type: "quiet"; text: string }
  | { type: "verdict"; key: string; p: number | null }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "tick" }
  | { type: "reset" };

export type HoldEffect =
  | { type: "judge"; key: string; text: string }
  | { type: "send"; text: string }
  | { type: "wake"; at: number };

type Step = { state: HoldState; effects: HoldEffect[] };

const isAscii = (ch: string | undefined): boolean => ch !== undefined && ch.charCodeAt(0) < 128;
/** 两段接成一句：中文直接接，两头都是 ASCII 才补一个空格 */
export function joinSpoken(a: string, b: string): string {
  if (a === "") return b;
  if (b === "") return a;
  return isAscii(a.at(-1)) && isAscii(b[0]) ? `${a} ${b}` : `${a}${b}`;
}

const released = (s: HoldState): HoldState => ({ ...s, buffer: "", merges: 0, heldSince: null, flushAt: null, waiting: null });

/** 这一段的去向定下来了：扣住，还是（连同之前扣着的）发出去 */
function settle(s: HoldState, text: string, p: number | null, now: number, hold: boolean): Step {
  const full = joinSpoken(s.buffer, text);
  const canHold =
    hold && p !== null && p < HOLD_BELOW && s.merges < HOLD_MAX_MERGES &&
    (s.heldSince === null || now - s.heldSince < HOLD_MAX_AGE_MS);
  if (!canHold) return { state: released(s), effects: [{ type: "send", text: full }] };
  const flushAt = now + HOLD_MS;
  return {
    state: { ...s, buffer: full, merges: s.merges + 1, heldSince: s.heldSince ?? now, flushAt, waiting: null },
    effects: [{ type: "wake", at: flushAt }],
  };
}

export function holdStep(s: HoldState, ev: HoldEvent, now: number, opts: { hold: boolean }): Step {
  const same: Step = { state: s, effects: [] };
  switch (ev.type) {
    case "quiet": {
      const key = ev.text.trim();
      if (key.length < MIN_JUDGE_CHARS || s.asked === key || s.verdicts.some((v) => v.key === key)) return same;
      // 问的是**合起来**的那句：后半句单独看往往是完整的，合起来才看得出它是不是一整句
      return { state: { ...s, asked: key }, effects: [{ type: "judge", key, text: joinSpoken(s.buffer, key) }] };
    }
    case "verdict": {
      const verdicts = ev.p === null ? s.verdicts : [...s.verdicts.filter((v) => v.key !== ev.key), { key: ev.key, p: ev.p }].slice(-VERDICTS_KEPT);
      const next: HoldState = { ...s, verdicts, asked: s.asked === ev.key ? null : s.asked };
      if (next.waiting !== null && next.waiting.text === ev.key) return settle({ ...next, waiting: null }, ev.key, ev.p, now, opts.hold);
      return { state: next, effects: [] };
    }
    case "partial": {
      if (s.buffer === "" || ev.text.trim() === "") return same;
      // 人接着说了：1.8s 那只表停掉（等下一个 final 来合并），只留总封顶
      const flushAt = (s.heldSince ?? now) + HOLD_MAX_AGE_MS;
      return flushAt === s.flushAt ? same : { state: { ...s, flushAt }, effects: [{ type: "wake", at: flushAt }] };
    }
    case "final": {
      const text = ev.text.trim();
      if (text === "") return same;
      if (s.waiting !== null) {
        // 上一句还在等答案、下一句已经到了：上一句按说完了算，再处理这一句
        const first = settle({ ...s, waiting: null }, s.waiting.text, null, now, opts.hold);
        const second = holdStep(first.state, ev, now, opts);
        return { state: second.state, effects: [...first.effects, ...second.effects] };
      }
      const known = s.verdicts.find((v) => v.key === text);
      if (known !== undefined) return settle(s, text, known.p, now, opts.hold);
      if (opts.hold && s.asked === text) {
        const until = now + VERDICT_WAIT_MS;
        return { state: { ...s, waiting: { text, until } }, effects: [{ type: "wake", at: until }] };
      }
      return settle(s, text, null, now, opts.hold);
    }
    case "tick": {
      let cur = s;
      const effects: HoldEffect[] = [];
      if (cur.waiting !== null && now >= cur.waiting.until) {
        const r = settle({ ...cur, waiting: null }, cur.waiting.text, null, now, opts.hold);
        cur = r.state;
        effects.push(...r.effects);
      }
      if (cur.buffer !== "" && cur.flushAt !== null && now >= cur.flushAt) {
        effects.push({ type: "send", text: cur.buffer });
        cur = released(cur);
      }
      return { state: cur, effects };
    }
    case "reset": {
      // 关麦 / 换会话：扣着的、等着的都照样发出去——人确实说了
      const pending = joinSpoken(s.buffer, s.waiting?.text ?? "");
      return { state: HOLD_IDLE, effects: pending === "" ? [] : [{ type: "send", text: pending }] };
    }
  }
}
```

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/renderer/utteranceHold.test.ts && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/utteranceHold.ts tests/renderer/utteranceHold.test.ts
git commit -m "feat(voice): 「说完了吗」的扣住/合并状态机——判不出来就照今天的发，两道封顶兜住判错（#1281）"
```

---

### Task 13: 语音接线 —— 主进程那一问 + `speechJudge` IPC + `store.ts`

**Files:**
- Create: `src/main/endpointJudge.ts`
- Modify: `src/shared/shellBridge.ts`（`speechResume` 之后一行方法；`CHANNELS` 里 `speechResume` 之后一格）
- Modify: `src/preload/index.ts`（`speechResume` 之后）
- Modify: `src/main/index.ts`（speech 事件转发处约 :1431、IPC 处理器约 :3659、`decisionClient` 装配之后）
- Modify: `src/renderer/src/store.ts`（`speechOnEvent` 约 :2733、`startMic` / `stopMic` 约 :1374）
- Test: `tests/main/endpointJudge.test.ts`（新）、`tests/renderer/utteranceHoldWiring.test.ts`（新，读源码）

**Interfaces:**
- Consumes: Task 11 `DecisionClient`；Task 12 全部；`SpeechEvent`（`src/shared/shellBridge.ts`）
- Produces:
  - `ENDPOINT_DECISION_TIMEOUT_MS = 900`, `endpointQuestions(said, asked)`, `createEndpointJudge(deps): { judge(said, asked): Promise<number | null>; onSpeechEvent(ev): void }`
  - `ShellBridge.speechJudge(said: string, asked: string | null): Promise<number | null>`，`CHANNELS.speechJudge = "otter:speechJudge"`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/main/endpointJudge.test.ts
import { describe, expect, it } from "vitest";
import { createEndpointJudge, endpointQuestions } from "../../src/main/endpointJudge.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const done = (p: number): DecisionReply => ({ model: "jev-1.13.0", inputTokens: 30, answers: { done: { type: "noul", noul: p } } });
function rig(mode: "off" | "shadow" | "on", reply: DecisionReply | null = done(0.2)) {
  const logs: string[] = [];
  let t = 0;
  const calls: unknown[] = [];
  const judge = createEndpointJudge({
    decision: { mode: () => mode, decide: async (...a) => { calls.push(a); return reply; } },
    log: (l) => logs.push(l),
    now: () => t,
  });
  return { judge, logs, calls, at: (ms: number) => { t = ms; } };
}

describe("endpointQuestions", () => {
  it("一个 noul；对方刚问的那句进 state（「main」是对「哪个分支？」的完整回答）；两格都截断", () => {
    const { state, questions } = endpointQuestions("字".repeat(2000), "问".repeat(2000));
    expect(Object.keys(questions)).toEqual(["done"]);
    const s = state as { said: string; asked: string };
    expect(s.said.length).toBe(600);
    expect(s.asked.length).toBe(300);
    expect((endpointQuestions("main", null).state as { asked: string }).asked).toBe("");
  });
});

describe("judge", () => {
  it("off：不问，回 null", async () => {
    const r = rig("off");
    expect(await r.judge.judge("帮我看一下", null)).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
  it("开着：回 P(说完了)；没问出来回 null", async () => {
    expect(await rig("on", done(0.12)).judge.judge("我想让你。", null)).toBe(0.12);
    expect(await rig("shadow", null).judge.judge("我想让你。", null)).toBeNull();
  });
});

describe("真值日志：final 之后 1.8 秒内人有没有接着说", () => {
  it("接着说了 → resumed:true", async () => {
    const r = rig("shadow", done(0.1));
    await r.judge.judge("我想让你。", null);
    r.at(1000); r.judge.onSpeechEvent({ type: "final", text: "我想让你。" });
    r.at(1900); r.judge.onSpeechEvent({ type: "partial", text: "帮我" });
    const line = JSON.parse(r.logs.at(-1)!.replace("[decision] ", ""));
    expect(line).toMatchObject({ use: "endpoint", mode: "shadow", p: 0.1, resumed: true, chars: 5 });
  });
  it("没接着说 → 下一个事件过了 1.8 秒时记 resumed:false（level 事件 10Hz，是现成的钟）", async () => {
    const r = rig("shadow", done(0.9));
    await r.judge.judge("帮我看一下构建。", null);
    r.at(1000); r.judge.onSpeechEvent({ type: "final", text: "帮我看一下构建。" });
    r.at(2000); r.judge.onSpeechEvent({ type: "level", value: 0.01, active: false });
    expect(r.logs).toHaveLength(0);
    r.at(2801); r.judge.onSpeechEvent({ type: "level", value: 0.01, active: false });
    expect(JSON.parse(r.logs.at(-1)!.replace("[decision] ", ""))).toMatchObject({ p: 0.9, resumed: false });
  });
  it("这句 final 没被问过 → 不记（没有 p 可对照）", () => {
    const r = rig("shadow");
    r.at(1000); r.judge.onSpeechEvent({ type: "final", text: "没问过的一句" });
    r.at(5000); r.judge.onSpeechEvent({ type: "level", value: 0, active: false });
    expect(r.logs).toHaveLength(0);
  });
  it("日志里没有正文（只有字数）", async () => {
    const r = rig("shadow", done(0.1));
    await r.judge.judge("机密的一句话。", null);
    r.at(10); r.judge.onSpeechEvent({ type: "final", text: "机密的一句话。" });
    r.at(20); r.judge.onSpeechEvent({ type: "partial", text: "接着说" });
    expect(r.logs.join()).not.toContain("机密");
  });
});
```

```ts
// tests/renderer/utteranceHoldWiring.test.ts
// store.ts 的语音那一段没法在 vitest 里真跑（要 window.otter、要 helper 的事件流）。
// 状态机本身在 utteranceHold.test.ts 里钉死了；这里钉的是接线里三条**漏了不会报错**的：
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../src/renderer/src/store.ts", import.meta.url), "utf8");

describe("store.ts：语音扣住/合并的接线（#1281）", () => {
  it("开关读的是 endpoint 这一处", () => {
    expect(src).toMatch(/modeOf\(.*"endpoint"\)/);
  });
  it("没开时 final 直接发，不经状态机（零额外延迟由构造保证）", () => {
    expect(src).toMatch(/===\s*"off"\)\s*sendSpoken\(/);
  });
  it("只有 on 才真扣（shadow 照问、不扣）", () => {
    expect(src).toMatch(/hold:\s*[A-Za-z]+\s*===\s*"on"/);
  });
  it("关麦时把扣着的那句发出去", () => {
    expect(src).toMatch(/type:\s*"reset"/);
  });
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/main/endpointJudge.test.ts tests/renderer/utteranceHoldWiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/main/endpointJudge.ts
// endpointJudge —— 语音通话里「这句说完了吗」那一问的主进程半边（#1281，spec §5.4 ⑤）。
//
// 渲染层的 utteranceHold 状态机在人停嘴那一刻经 IPC 问到这里；这里拼问题、经
// decisionClient 走网关、回一个 P(说完了)。渲染层不能自己问：硬规则——渲染进程只通过
// ShellBridge 与后端通信，而那一问要带用户的 JWT。
//
// 另一半是**真值日志**。这一处与另外四处不同：别处的对照物是「今天那条 LLM 路怎么判」，
// 这里今天没有 LLM 路，但真值是**观测得到的**——final 之后 1.8 秒内人有没有接着说。
// 主进程本来就过手 helper 的每一条事件（转发给渲染层之前），所以在这里记最省事：
// 不用给渲染层另开一条回报通道。`level` 事件 10Hz，是现成的钟。
// **日志里没有正文**，只有字数——转写是人说的话，不该躺在控制台里。

import { noul, type DecisionQuestion, type DecisionState } from "../shared/decision.js";
import type { SpeechEvent } from "../shared/shellBridge.js";
import type { DecisionClient } from "./decisionClient.js";

/** 投机问发生在人停嘴那一刻，helper 最早 700ms 之后才 final——900ms 内回不来的答案，
    渲染层那侧再等 200ms 也就放弃了，这里不必等更久 */
export const ENDPOINT_DECISION_TIMEOUT_MS = 900;
const SAID_MAX = 600;
const ASKED_MAX = 300;
/** 与渲染层 utteranceHold 的 HOLD_MS 同一个数：真值问的就是「扣那么久值不值」。
    两边各写一份是因为主进程不该 import 渲染层；数字在两处的注释里互相指着 */
const RESUME_WINDOW_MS = 1800;

export function endpointQuestions(said: string, asked: string | null): { state: DecisionState; questions: Record<string, DecisionQuestion> } {
  return {
    state: { said: said.slice(0, SAID_MAX), asked: (asked ?? "").slice(0, ASKED_MAX) },
    questions: {
      done: noul(
        "语音通话里，一个人说了 `said` 这句话然后停了一下（`asked` 是对方刚才说的上一句，可能为空）。这句话说完了吗——意思已经表达完整、在等对方回应？",
        "意思完整，可以作为一句话单独成立；或者是对 `asked` 的一个完整回答，哪怕只有一两个词",
        "话说到一半：句子缺成分、以连接词或语气停顿收尾、明显还有下文",
      ),
    },
  };
}

export interface EndpointJudge {
  judge(said: string, asked: string | null): Promise<number | null>;
  /** helper 的每一条事件转发给渲染层之前先过这里（只读，不改事件） */
  onSpeechEvent(ev: SpeechEvent): void;
}

export function createEndpointJudge(deps: {
  decision: Pick<DecisionClient, "mode" | "decide">;
  log?: (line: string) => void;
  now?: () => number;
}): EndpointJudge {
  const now = deps.now ?? (() => Date.now());
  let lastAsked: { said: string; p: number } | null = null;
  let pending: { p: number; at: number; chars: number } | null = null;
  const line = (resumed: boolean): void => {
    if (pending === null) return;
    deps.log?.(`[decision] ${JSON.stringify({ use: "endpoint", mode: deps.decision.mode("endpoint"), p: pending.p, resumed, chars: pending.chars })}`);
    pending = null;
  };
  return {
    async judge(said, asked) {
      if (deps.decision.mode("endpoint") === "off") return null;
      const { state, questions } = endpointQuestions(said, asked);
      const a = (await deps.decision.decide("endpoint", state, questions, ENDPOINT_DECISION_TIMEOUT_MS))?.answers.done;
      if (!a || a.type !== "noul") return null;
      lastAsked = { said: said.trim(), p: a.noul };
      return a.noul;
    },
    onSpeechEvent(ev) {
      if (pending !== null && now() - pending.at > RESUME_WINDOW_MS) line(false);
      if (ev.type === "partial" && ev.text.trim() !== "" && pending !== null) line(true);
      if (ev.type === "final") {
        const text = ev.text.trim();
        // 问的是合起来的那句（扣着的 + 新那一段），final 带的只是新那一段——所以是 endsWith
        if (lastAsked !== null && text !== "" && lastAsked.said.endsWith(text)) {
          pending = { p: lastAsked.p, at: now(), chars: [...text].length };
        }
        lastAsked = null;
      }
    },
  };
}
```

`src/shared/shellBridge.ts`：`speechResume(): Promise<void>;` 之后加

```ts
  /** 「这句说完了吗」（#1281）：人停嘴那一刻渲染层投机问一次，回 P(说完了)；`null` =
      这一处没开 / 没问出来 = 照今天的发。`asked` 是对方刚才说的上一句（播放器最近读的那段）。
      这是语音这条桥上**唯一一条请求-响应**——别的全是 helper 自己冒出来的事件；它不经
      helper，走的是主进程 → edge 网关 */
  speechJudge(said: string, asked: string | null): Promise<number | null>;
```

`CHANNELS` 里 `speechResume: "otter:speechResume",` 之后加 `speechJudge: "otter:speechJudge",`。

`src/preload/index.ts`：`speechResume` 那一行之后加

```ts
  speechJudge: (said, asked) => ipcRenderer.invoke(CHANNELS.speechJudge, said, asked),
```

`src/main/index.ts`：

- import `createEndpointJudge, type EndpointJudge` from `"./endpointJudge.js"`。
- 照 `hostedQuotaRefresh` 那个「先声明、后赋值」的写法，在 speech 桥装配**之前**声明 `let endpointJudge: EndpointJudge | null = null;`。
- speech 事件转发那一处（`send(CHANNELS.speechEvent, ev);` 之前）加一行 `endpointJudge?.onSpeechEvent(ev);`，并注释「只读、先于转发：真值日志要看见每一条事件（#1281）」。
- `decisionClient` 装配之后：`endpointJudge = createEndpointJudge({ decision: decisionClient, log: (l) => console.warn(l) });`
- IPC 处理器区 `speechResume` 那一行之后：

```ts
  // 「这句说完了吗」（#1281）。入参来自渲染层，照这一区别的处理器一样先验形状
  ipcMain.handle(CHANNELS.speechJudge, (_e, said: unknown, asked: unknown) =>
    typeof said === "string" && said.trim() !== "" && endpointJudge !== null
      ? endpointJudge.judge(said, typeof asked === "string" ? asked : null)
      : null);
```

`src/renderer/src/store.ts`：

import 区加：

```ts
import { modeOf } from "../../shared/decision.js";
import { HOLD_IDLE, holdStep, joinSpoken, type HoldEvent, type HoldState } from "./lib/utteranceHold.js";
```

（相对路径以文件里别的 `shared/` import 为准。）

模块级（`startMic` 附近）：

```ts
// 语音「扣住再合并」（#1281）。模块级而不是 store 里的一格：它不是界面状态（没有任何
// 组件读它），是一段正在进行的对话的簿记——同 voiceFeed / voicePlayer 住在这里的理由
let hold: HoldState = HOLD_IDLE;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
```

`speechOnEvent` 改成（**保留原有注释**，下面只标出新增与改动的行）：

```ts
  speechOnEvent(ev) {
    if (helperAudioEvent(ev)) return;
    const v = get().voice;
    if (!v || v.mic.status === "off") return;
    const wasActive = v.mic.active;                                   // 新增
    const r = applySpeechEvent(v.mic, ev);
    // 扣着一句的时候字幕 = 扣着的 + 新 partial，不然那行字会先消失再冒出来（#1281）
    const shown = hold.buffer !== "" ? { ...r.state, transcript: joinSpoken(hold.buffer, r.state.transcript) } : r.state;   // 新增
    if (shown !== v.mic) set((s) => (s.voice ? { voice: { ...s.voice, mic: shown } } : s));                                  // 改：r.state → shown
    // …（插话那一段原样不动）…

    // 「这句说完了吗」（#1281）。**没开时整套状态机旁路**：零额外延迟由构造保证，
    // 不靠「那一问回得够快」
    const endpointMode = modeOf(get().billing?.me ?? null, "endpoint");                                                       // 新增
    const sessionId = v.sessionId;
    const sendSpoken = (text: string): void => {                                                                              // 原来那段 cloudSay 收成一个函数
      void get().cloudSay(text, [], [], true).then((ack) => {
        if (ack.ok) return;
        set((s) => (s.voice && s.voice.sessionId === sessionId ? { voice: { ...s.voice, mic: { ...s.voice.mic, error: ack.message } } } : s));
      });
    };
    const runHold = (e: HoldEvent): void => {                                                                                 // 新增
      const step = holdStep(hold, e, Date.now(), { hold: endpointMode === "on" });
      hold = step.state;
      for (const fx of step.effects) {
        if (fx.type === "send") sendSpoken(fx.text);
        else if (fx.type === "judge") {
          const asked = get().voice?.text ?? null;
          void window.otter.speechJudge(fx.text, asked).then(
            (p) => runHold({ type: "verdict", key: fx.key, p }),
            () => runHold({ type: "verdict", key: fx.key, p: null }),
          );
        } else {
          if (holdTimer !== null) clearTimeout(holdTimer);
          holdTimer = setTimeout(() => { holdTimer = null; runHold({ type: "tick" }); }, Math.max(0, fx.at - Date.now()));
        }
      }
    };
    if (endpointMode !== "off") {                                                                                             // 新增
      // 人停嘴那一刻（能量门从真变假）投机问一次：700ms 之后 final 到时答案通常已经回来
      if (ev.type === "level" && wasActive && !ev.active && r.state.transcript.trim() !== "") runHold({ type: "quiet", text: r.state.transcript });
      if (ev.type === "partial") runHold({ type: "partial", text: ev.text });
    }
    if (r.final === undefined) return;
    // …（原有那段「说完的一句 = 我在群里说的一句」注释保留）…
    if (endpointMode === "off") sendSpoken(r.final);
    else runHold({ type: "final", text: r.final });
  },
```

> `runHold` 在 `setTimeout` 回调里用的是**当时那一次** `speechOnEvent` 闭包里的 `endpointMode` / `sessionId`——表只走 ≤8 秒，期间开关翻动或换会话的后果是「那一句按旧档处理」，可接受；`sendSpoken` 里已经按 `sessionId` 防了串台。

关麦那条路（`setMicOn(false)` 分支里 `stopMic();` 之前）加：

```ts
      // 扣着的那句照样发出去——人确实说了（#1281）。用一次性的 send：此刻已经没有
      // speechOnEvent 的闭包可借
      if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
      const flushed = holdStep(hold, { type: "reset" }, Date.now(), { hold: false });
      hold = flushed.state;
      for (const fx of flushed.effects) if (fx.type === "send") void get().cloudSay(fx.text, [], [], true);
```

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/main/endpointJudge.test.ts tests/renderer/utteranceHoldWiring.test.ts tests/renderer/voiceMic.test.ts tests/main/speechBridge.test.ts tests/architecture.test.ts && npx tsc --noEmit -p .`
Expected: PASS。再 `rg -n "speechResume" src tests mobile --type ts -l` 看一眼有没有别的 `ShellBridge` 实现 / 夹具要补 `speechJudge`（tsc 会把必须补的那些点出来；`as unknown as ShellBridge` 的局部夹具不用动）。

- [ ] **Step 5: Commit**

```bash
git add src/main/endpointJudge.ts src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts src/renderer/src/store.ts tests/main/endpointJudge.test.ts tests/renderer/utteranceHoldWiring.test.ts
git commit -m "feat(voice): 语音断句接上决策模型——停嘴那一刻投机问，没开时整套旁路；真值日志记在主进程（#1281）"
```

---

### Task 14: 记忆写入分档核对

**Files:**
- Create: `src/shared/memoryTierJudge.ts`, `src/main/memoryTierJudge.ts`
- Modify: `src/shared/memoryStore.ts`（`tierRuleText` :27-39）
- Modify: `src/tools/memory.ts`（`createMemoryTool` :107、点名守卫之后约 :151）
- Modify: `src/main/agent.ts`（`createMemoryTool(memoryProject)` 约 :733）
- Test: `tests/shared/memoryTierJudge.test.ts`（新）、`tests/main/memoryTierJudge.test.ts`（新）、`tests/tools/memory.test.ts`（末尾加一组）、`tests/shared/memoryStore.test.ts`（`tierRuleText` 那组加一条）

**Interfaces:**
- Consumes: Task 1；Task 11 `DecisionClient`
- Produces:
  - `memoryStore.ts`：`tierFact(tier: "project" | "memory" | "user", at?: string): string`
  - `shared/memoryTierJudge.ts`：`type JudgedTier = "user" | "memory" | "project"`, `TIER_MISMATCH_AT = 0.85`, `TIER_DECISION_TIMEOUT_MS = 900`, `tierQuestions(contents, projectLabel)`, `tierMismatches(reply, target, count): TierMismatch[]`, `interface TierMismatch { index: number; suggested: JudgedTier; confidence: number }`, `type MemoryTierJudge = (contents: readonly string[], target: JudgedTier, projectLabel: string) => Promise<TierMismatch[] | null>`
  - `main/memoryTierJudge.ts`：`createMemoryTierJudge(decision: Pick<DecisionClient, "mode" | "decide">, log?): MemoryTierJudge`
  - `createMemoryTool(project, deps?: { judgeTier?: MemoryTierJudge })`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/memoryTierJudge.test.ts
import { describe, expect, it } from "vitest";
import { TIER_MISMATCH_AT, tierMismatches, tierQuestions } from "../../src/shared/memoryTierJudge.js";
import { tierFact } from "../../src/shared/memoryStore.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const reply = (rows: [string, number][]): DecisionReply => ({
  model: "jev-1.13.0", inputTokens: 80,
  answers: Object.fromEntries(rows.map(([c, conf], i) => [`e${i}`, { type: "choice" as const, choice: c, probabilities: { user: 0, memory: 0, project: 0, [c]: 1 }, confidence: conf }])),
});

describe("tierQuestions", () => {
  it("每条内容一个 choice，三个选项的说明与 tierRuleText 同源（tierFact）", () => {
    const { state, questions } = tierQuestions(["构建要先 npm --prefix mobile ci", "用户叫小红"], "Mr_Otto");
    expect(Object.keys(questions)).toEqual(["e0", "e1"]);
    const q = questions.e0!;
    expect(q.type === "choice" && q.criteria).toEqual({ project: tierFact("project"), memory: tierFact("memory"), user: tierFact("user") });
    expect(state).toEqual({ project: "Mr_Otto", entries: ["构建要先 npm --prefix mobile ci", "用户叫小红"] });
  });
});

describe("tierMismatches", () => {
  it("回的那一档 ≠ target 且把握到线才算", () => {
    expect(tierMismatches(reply([["project", TIER_MISMATCH_AT]]), "memory", 1)).toEqual([{ index: 0, suggested: "project", confidence: TIER_MISMATCH_AT }]);
    expect(tierMismatches(reply([["project", TIER_MISMATCH_AT - 0.01]]), "memory", 1)).toEqual([]);
    expect(tierMismatches(reply([["memory", 0.99]]), "memory", 1)).toEqual([]);
  });
  it("多条里只报对不上的那几条，带下标", () => {
    expect(tierMismatches(reply([["memory", 0.9], ["project", 0.95]]), "memory", 2).map((m) => m.index)).toEqual([1]);
  });
});
```

```ts
// tests/main/memoryTierJudge.test.ts
import { describe, expect, it } from "vitest";
import { createMemoryTierJudge } from "../../src/main/memoryTierJudge.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const says = (c: string, conf: number): DecisionReply => ({ model: "m", inputTokens: 1, answers: { e0: { type: "choice", choice: c, probabilities: { [c]: 1 }, confidence: conf } } });
const rig = (mode: "off" | "shadow" | "on", reply: DecisionReply | null) => {
  const logs: string[] = [];
  let asked = 0;
  const judge = createMemoryTierJudge({ mode: () => mode, decide: async () => { asked++; return reply; } }, (l) => logs.push(l));
  return { judge, logs, asked: () => asked };
};

describe("createMemoryTierJudge", () => {
  it("off：不问，回 null", async () => {
    const r = rig("off", says("project", 0.99));
    expect(await r.judge(["x"], "memory", "Mr_Otto")).toBeNull();
    expect(r.asked()).toBe(0);
  });
  it("on：回 mismatch", async () => {
    expect(await rig("on", says("project", 0.95)).judge(["x"], "memory", "Mr_Otto")).toEqual([{ index: 0, suggested: "project", confidence: 0.95 }]);
  });
  it("shadow：只记一行，回 null（工具那侧因此照常写）；日志里没有正文", async () => {
    const r = rig("shadow", says("project", 0.95));
    expect(await r.judge(["机密内容"], "memory", "Mr_Otto")).toBeNull();
    expect(r.logs[0]).toContain('"use":"memory"');
    expect(r.logs.join()).not.toContain("机密");
  });
  it("没问出来：null", async () => {
    expect(await rig("on", null).judge(["x"], "memory", "Mr_Otto")).toBeNull();
  });
});
```

`tests/tools/memory.test.ts` 末尾（`fakeWorld` 是文件顶部现成的帮手；工具失败是 **reject**，同「项目归位守卫」那组的写法）：

```ts
describe("分档核对（#1281）：更像另一档的事，劝一次", () => {
  const proj = { id: "github.com/x/mr_otto", root: "/Users/x/Github/Mr_Otto", dir: "memories/projects/d3d" };
  const ARGS = { target: "memory", action: "add", content: "门禁前要先装手机端依赖" };
  const mismatch = async () => [{ index: 0, suggested: "project" as const, confidence: 0.93 }];

  it("命中：抛一条指路的错，什么都没写；**原样再交一次放行**，且第二次不再问", async () => {
    let asked = 0;
    const tool = createMemoryTool(proj, { judgeTier: async () => { asked++; return mismatch(); } });
    const { world, store } = fakeWorld();
    await expect(tool.run(ARGS, world)).rejects.toThrow(/target: "project"[\s\S]*原样再提交一次会放行/);
    expect(store.get("memories/MEMORY.md")).toBeUndefined();
    await tool.run(ARGS, world);
    expect(store.get("memories/MEMORY.md")).toBe("门禁前要先装手机端依赖");
    expect(asked).toBe(1);
  });

  it("judge 回 null / 回 [] / 抛错：照常写", async () => {
    const judges = [async () => null, async () => [], async () => { throw new Error("x"); }];
    for (const judgeTier of judges) {
      const { world, store } = fakeWorld();
      await createMemoryTool(proj, { judgeTier }).run({ target: "memory", action: "add", content: "brew 装在 /opt/homebrew" }, world);
      expect(store.get("memories/MEMORY.md")).toBe("brew 装在 /opt/homebrew");
    }
  });

  it("judge 缺席：第二个参数不给，行为与改动前相同", async () => {
    const { world, store } = fakeWorld();
    await createMemoryTool(proj).run({ target: "memory", action: "add", content: "brew 装在 /opt/homebrew" }, world);
    expect(store.get("memories/MEMORY.md")).toBe("brew 装在 /opt/homebrew");
  });

  it("没有项目根 / remove：不问", async () => {
    let asked = 0;
    const judgeTier = async () => { asked++; return null; };
    await createMemoryTool(null, { judgeTier }).run({ target: "memory", action: "add", content: "一条全局事实" }, fakeWorld().world);
    // remove 定位不到会 reject——这里只关心「没问」，不关心它成没成
    await createMemoryTool(proj, { judgeTier }).run({ target: "memory", action: "remove", old_text: "不存在的条目" }, fakeWorld().world).catch(() => {});
    expect(asked).toBe(0);
  });

  it("target 是 project 也核（全局事实被投进了项目档是同一种错档）", async () => {
    const tool = createMemoryTool(proj, { judgeTier: async () => [{ index: 0, suggested: "memory" as const, confidence: 0.9 }] });
    await expect(tool.run({ target: "project", action: "add", content: "brew 装在 /opt/homebrew" }, fakeWorld().world)).rejects.toThrow(/target: "memory"/);
  });
});
```

`tests/shared/memoryStore.test.ts` 的 `tierRuleText` 那组加：

```ts
it("tierRuleText 由 tierFact 拼出来，逐字节与改动前相同（决策模型的选项说明与它同源，#1281）", () => {
  expect(tierRuleText({ upper: true, projectRoot: "/p" })).toBe(
    "PROJECT 记与当前项目（/p）绑定的事（它的代码路径、分支/worktree、构建/门禁怪癖、数据目录、项目约定）；" +
    "MEMORY 记换个项目还成立的事（本机 PATH、CLI 登录态、全局工具怪癖）——机器/环境事实不进 PROJECT；" +
    "USER 记关于用户本人的事。" +
    "判据一句话：换个项目还成立吗？成立写 MEMORY，不成立写 PROJECT。" +
    "一个事实只住一档，别跨档重复；MEMORY 条目不点名具体项目（点名会被拒，改投 PROJECT）。",
  );
});
```

- [ ] **Step 2: 确认它红**

Run: `npx vitest run tests/shared/memoryTierJudge.test.ts tests/main/memoryTierJudge.test.ts tests/tools/memory.test.ts tests/shared/memoryStore.test.ts`
Expected: FAIL（新模块不存在、`tierFact` 不存在；`tierRuleText` 那条逐字节断言**此刻应该是绿的**——它钉的是改动前的输出，重构之后必须仍然绿）

- [ ] **Step 3: 实现**

`src/shared/memoryStore.ts`：`tierRuleText` 之前加 `tierFact`，并让 `tierRuleText` 由它拼：

```ts
/** 三档各记什么，一档一句。`tierRuleText`（给模型读的那段判据）与决策模型那道分档核对的
    选项说明（shared/memoryTierJudge.ts，#1281）**都从这里取**：两处各写一份的话，哪天
    改了一处，模型被告知的判据与核对它的判据就分家了，而分家不报错 */
export function tierFact(tier: "project" | "memory" | "user", at = ""): string {
  if (tier === "project") return `与当前项目${at}绑定的事（它的代码路径、分支/worktree、构建/门禁怪癖、数据目录、项目约定）`;
  if (tier === "memory") return "换个项目还成立的事（本机 PATH、CLI 登录态、全局工具怪癖）";
  return "关于用户本人的事";
}
```

`tierRuleText` 的 `return (` 里前三行换成：

```ts
    `${P} 记${tierFact("project", at)}；` +
    `${M} 记${tierFact("memory")}——机器/环境事实不进 ${P}；` +
    `${U} 记${tierFact("user")}。` +
```

```ts
// src/shared/memoryTierJudge.ts
// memoryTierJudge —— 记忆写入的分档核对（#1281，spec §5.4 ⑥）。纯逻辑。
//
// 病（ADR-0269 的同一族）：模型自己挑 target，点名守卫只做子串匹配——不点名的项目事实
// （「门禁前要先装手机端依赖」）照样落进全局档。真机数据：全局档 11 条里 7 条是项目事实。
//
// 这里问决策模型一道多选一：这条内容属于哪一档。**这是卫生劝告，不是安全闸**——命中时
// 工具抛一条指路的错，模型原样再交一次就放行（不然判错一次就把一条真事实永久挡在外面，
// 三次失败工具会进终态）。所以阈值取高：宁可漏劝，不要错劝。
//
// 只核 user / memory / project 三档：要治的病是「项目事实落进全局档」；topic 要连桶一起挑，
// 不在这次范围里。

import { choice, type DecisionQuestion, type DecisionReply, type DecisionState } from "./decision.js";
import { tierFact } from "./memoryStore.js";

export type JudgedTier = "user" | "memory" | "project";
/** 回的那一档 ≠ target 且 confidence 到它才劝。**初值**，由影子期那几条命中人读一遍之后改 */
export const TIER_MISMATCH_AT = 0.85;
/** 此刻一把锁都没拿（落点在文件锁之前），900ms 的等待不占任何东西 */
export const TIER_DECISION_TIMEOUT_MS = 900;
const ENTRY_MAX = 800;

export interface TierMismatch { index: number; suggested: JudgedTier; confidence: number }
/** 工具那一侧看到的注入点。`null` = 没开 / 没问出来 / 影子期 = 照常写 */
export type MemoryTierJudge = (contents: readonly string[], target: JudgedTier, projectLabel: string) => Promise<TierMismatch[] | null>;

const isTier = (v: string): v is JudgedTier => v === "user" || v === "memory" || v === "project";

export function tierQuestions(contents: readonly string[], projectLabel: string): { state: DecisionState; questions: Record<string, DecisionQuestion> } {
  const questions: Record<string, DecisionQuestion> = {};
  contents.forEach((_c, i) => {
    questions[`e${i}`] = choice(
      `\`entries[${i}]\` 是要写进 agent 长期记忆的一条事实，当前项目叫 \`project\`。它该记在哪一档？判据一句话：换个项目还成立吗。`,
      { project: tierFact("project"), memory: tierFact("memory"), user: tierFact("user") },
    );
  });
  return { state: { project: projectLabel, entries: contents.map((c) => c.slice(0, ENTRY_MAX)) }, questions };
}

export function tierMismatches(reply: DecisionReply, target: JudgedTier, count: number): TierMismatch[] {
  const out: TierMismatch[] = [];
  for (let i = 0; i < count; i++) {
    const a = reply.answers[`e${i}`];
    if (!a || a.type !== "choice" || !isTier(a.choice)) continue;
    if (a.choice !== target && a.confidence >= TIER_MISMATCH_AT) out.push({ index: i, suggested: a.choice, confidence: a.confidence });
  }
  return out;
}
```

```ts
// src/main/memoryTierJudge.ts
// 记忆分档核对的主进程装配（#1281）：把 decisionClient 包成工具认得的那个注入函数。
// 工具不 import 网络（硬规则：工具只依赖 ExecutionWorld），所以判断从这里递进去。
// 三态在这一层收口：off 不问；shadow 只记一行、回 null（工具照常写）；on 回 mismatch。
// **日志里没有正文**——记忆条目可能是关于用户本人的事。

import { TIER_DECISION_TIMEOUT_MS, tierMismatches, tierQuestions, type MemoryTierJudge } from "../shared/memoryTierJudge.js";
import type { DecisionClient } from "./decisionClient.js";

export function createMemoryTierJudge(decision: Pick<DecisionClient, "mode" | "decide">, log?: (line: string) => void): MemoryTierJudge {
  return async (contents, target, projectLabel) => {
    const mode = decision.mode("memory");
    if (mode === "off" || contents.length === 0) return null;
    const { state, questions } = tierQuestions(contents, projectLabel);
    const reply = await decision.decide("memory", state, questions, TIER_DECISION_TIMEOUT_MS);
    if (reply === null) return null;
    const hits = tierMismatches(reply, target, contents.length);
    log?.(`[decision] ${JSON.stringify({ use: "memory", mode, target, entries: contents.length, mismatches: hits.map((h) => ({ suggested: h.suggested, confidence: h.confidence })) })}`);
    return mode === "on" ? hits : null;
  };
}
```

`src/tools/memory.ts`：

```ts
import type { JudgedTier, MemoryTierJudge } from "../shared/memoryTierJudge.js";
```

签名：

```ts
export function createMemoryTool(
  project: { id: string; root: string; dir: string } | null,
  /** 分档核对（#1281）。**注入进来的一个函数**——工具不 import 网络；缺席 = 行为与改动前
      逐字相同 */
  deps?: { judgeTier?: MemoryTierJudge },
): Tool {
  let consecutiveFailures = 0;
  // 「被劝过一次、模型坚持」的那些（target + 内容）。这是卫生劝告不是安全闸：决策模型判错
  // 一次不该把一条真事实永久挡在外面（三次失败工具会进终态）。封顶 64 条，够一个会话用
  const insisted = new Set<string>();
```

点名守卫那个 `if (target === "memory" && project) { … }` 块之后、`const rel = memoryRelPath(…)` 之前加：

```ts
    // 分档核对（#1281）：点名守卫只认得出「点了名」的项目事实；不点名的那些
    // （「门禁前要先装手机端依赖」）问决策模型一道多选一。落点在拿文件锁**之前**——
    // 这一问最多等 900ms，此刻一把锁都没占。只在有项目根、且是这三档时问：要治的病是
    // 「项目事实落进全局档」，没有项目档时那个选项不存在；topic 要连桶一起挑，不在范围里
    if (deps?.judgeTier && project && (target === "user" || target === "memory" || target === "project")) {
      const tier: JudgedTier = target;
      const key = (c: string): string => `${tier}\n${c}`;
      const pending = ops.flatMap((op) => (op.action === "remove" || insisted.has(key(op.content)) ? [] : [op.content]));
      if (pending.length > 0) {
        const label = project.root.split(/[\\/]/).filter(Boolean).pop() ?? project.root;
        const hits = await deps.judgeTier(pending, tier, label).catch(() => null);
        if (hits && hits.length > 0) {
          for (const c of pending) {
            if (insisted.size >= 64) insisted.clear();
            insisted.add(key(c));
          }
          const h = hits[0]!;
          throw new Error(
            `这条内容更像 ${h.suggested} 档的事（把握 ${Math.round(h.confidence * 100)}%）——改写 target: "${h.suggested}"。` +
            `判据一句话：换个项目还成立吗。确认就是 ${tier} 档的话，原样再提交一次会放行。`,
          );
        }
      }
    }
```

`src/main/agent.ts`：

```ts
import { createMemoryTierJudge } from "./memoryTierJudge.js";
```

`buildTools` 之外（闭包上方，只建一次——`insisted` 那份簿记住在工具实例里，而 `buildTools` 每轮重建工具；**所以记忆工具要提到 `buildTools` 外面建一次**，否则「原样再交一次放行」永远不成立）：

```ts
  // 记忆工具建**一次**而不是每轮重建（#1281）：分档核对那份「被劝过一次」的簿记住在工具
  // 实例里，每轮重建就每轮失忆——模型原样再交一次仍然被劝，三次之后工具进终态。
  // 它不依赖任何会在会话中途变的东西（memoryProject 装配时就定了），所以提出来是安全的；
  // 顺带：原来那个「连续失败计数」每轮清零的行为也一并没了，那本来就更接近它的本意
  const dc = opts.hosted?.decision;
  const memoryTool = world.config
    ? createMemoryTool(memoryProject, dc ? { judgeTier: createMemoryTierJudge(dc, (l) => console.warn(l)) } : undefined)
    : null;
```

`buildTools` 里那一行改成 `...(memoryTool ? [memoryTool] : []),`（原注释保留）。

> **先核实再动**：`rg -n "consecutiveFailures" src/tools/memory.ts tests/tools/memory.test.ts` 读一遍那个计数的语义与测试。如果既有测试依赖「每轮一个新实例、计数清零」，**停下来报告**，不要改测试——那种情况下退回方案 B：`insisted` 提成 `createMemoryTool` 的第三个可选参数由 agent.ts 持有，工具照旧每轮重建。

- [ ] **Step 4: 绿**

Run: `npx vitest run tests/shared/memoryTierJudge.test.ts tests/main/memoryTierJudge.test.ts tests/tools/memory.test.ts tests/shared/memoryStore.test.ts tests/main/agent.test.ts tests/architecture.test.ts && npx tsc --noEmit -p .`
Expected: PASS（`tests/architecture.test.ts` 钉着「工具不许 import 网络 / main」——`src/tools/memory.ts` 只 import 了 `shared/` 里的类型，应当是绿的）

- [ ] **Step 5: Commit**

```bash
git add src/shared/memoryTierJudge.ts src/main/memoryTierJudge.ts src/shared/memoryStore.ts src/tools/memory.ts src/main/agent.ts tests/shared/memoryTierJudge.test.ts tests/main/memoryTierJudge.test.ts tests/tools/memory.test.ts tests/shared/memoryStore.test.ts
git commit -m "feat(memory): 写入前的分档核对——不点名的项目事实也劝一次；是劝告不是闸，模型坚持就放行（#1281）"
```

---

### Task 15: ADR + 索引 + 术语

**Files:**
- Create: `docs/adr/0297-决策模型经网关接入-五处分类器前置LLM兜底-分处三态开关.md`
- Modify: `AGENTS.md`（Where to find things 末尾加一条）
- Modify: `CONTEXT.md`（`## 产品 / 技术术语（Mr Otto）` 一节末尾、`## Key invariants` 之前加两条）
- Test: `tests/docs/adrNumbers.test.ts`, `tests/architecture.noControlChars.test.ts`

**Interfaces:** 无代码接口。ADR 编号**合并时认领**：先 `git fetch origin && git ls-tree --name-only origin/main docs/adr/ | tail -2`，最大号不是 0296 就顺延，文件名与正文里的号一起改。

- [ ] **Step 1: 写 ADR**（全文如下，编号按上一步核过的填）

```markdown
# ADR-0297：决策模型（Jev）经网关接入——五处分类器前置、LLM 兜底、分处三态开关

- 日期：2026-09-20
- 状态：已接受
- 相关：#1281、spec `docs/superpowers/specs/2026-09-20-jev-decision-model-design.md`、ADR-0237 / 0244（Auto）、ADR-0270 / 0275（派活）、ADR-0283（云会话标题）、ADR-0273 / 0277（语音断句）、ADR-0269 / 0143（记忆分档）、ADR-0257 / 0271（网关加新 kind 的先例）、ADR-0248（订阅用户不带 key）、#1280

## 背景

Otto 里有五处拿便宜聊天模型当分类器：写一段「只回一个词」的提示词，再用正则去认它回了什么——派活、Auto 判难度、云会话重命名、语音断句（这一处今天是标点启发式）、记忆写入分档。它们共同的毛病是**判据里混着「模型听不听话」**：「拿不准算 hard」是提示词里的一句请求，none 与 picked 之间没有可调的量，`"KEEP"` 被引号包住就成了一个真标题。

Jev（TypeSafe AI，2026-09-15 发布）是为这个形状造的：不生成文字，收 `state` + 一组类型化问题（是/否、多选一、打分），一次前向回类型化答案 + 校准概率。

## 决定

1. **只经 edge 网关**：`model_route` 多一种 `kind='decision'`、网关多一扇门 `/llm/v1/decision`（照 `serveTts` 的骨架），上游走 OpenRouter 的 Decisions 端点（维护者选的：那把 key 已经在 Worker secret 里，TypeSafe 直连要排 early access）。不给 BYOK 用户加这一家 provider——五处里三处本来就只在托管路上存在（ADR-0248）。
2. **前置，不替换**：每一处都是「决策模型优先，没问出来 / 拿不准 → 今天那条路」。`withDecision` 是五处共用的三态包装；`requestDecision` 从不抛。于是没有哪一处会因为决策模型不可用而比今天更差，除了一段有上限的等待。
3. **拿不准的交给慢而聪明的那条路（escalate）**，而不是硬猜——这是校准概率真正值钱的地方。派活的判决表与重命名的 KEEP 闸都有这一格。
4. **不信上游的「0% 类型错误」**：`parseDecisionReply` 逐题验，任何一处不对整份回 null。那句宣传说的是形状，不是对错；而形状我们自己验得了。
5. **开关是 edge 里一个三态常量**（`DECISION_USES`：没列 / `shadow` / `on`），随 `/billing/v1/me` 下发三端，初始 `{}`。`shadow` = 今天那条路说了算，决策模型并行问一次、只记一行 `[decision]` 对照日志。
6. **只许加严，不许放行**：审批、`gitSafety`、沙箱免审、`scanThreat`、周期护栏、接力上限、额度闸一处都不接。决策模型读的也是不可信输入；这五处每一个判错的代价都是有界的。
7. **不改 SessionEvent schema、不进协议位**：判决的结果已经在日志里，概率是调参用的诊断量，走日志行。

## 为什么

- **为什么是常量不是 `model_route` 上的一列**：加列要「migration 先、worker 后」，新 kind 要「worker 先、migration 后」——两条顺序相反的规则压在同一次上线上。常量改一行走 PR，git 历史里留着「哪天凭什么数据开的」。
- **为什么多一档 shadow**：整件事最大的未知数是中文校准（官方自认英语为主），而本机没有 OpenRouter 的 key——第一次真调用只能发生在网关部署之后。`shadow` 用生产里真实的中文输入、在不影响任何人的前提下量一致率与校准，替掉了「拉真库记录离线对拍」（那条路要从日志重建每一次派活当时的名册，重建本身就是一份会错的逻辑）。语音那一处的真值是**观测得到的**（final 之后 1.8 秒内人有没有接着说），主进程在记。
- **为什么 runtime 只动 `daemon.ts`**：三处本来就是 `sessionService` 的可选注入。这同时是与 #1280 的约定——那条 lane 要动群聊的形状，这边只换分类器那一格；`tests/runtime/daemonDecisionWiring.test.ts` 钉着「sessionService 不认识决策模型」。
- **为什么语音不动 Swift**：重编 helper 要维护者重新点一次 TCC 授权。渲染层扣住再合并只治「切碎」那一半；另一半（没标点的整句白等 2.5s）要给 helper 加 `commit` 命令，留给切碎那一半验证有效之后。
- **为什么记忆那一处是劝告不是闸**：决策模型判错一次不该把一条真事实永久挡在外面（三次失败工具会进终态）。模型原样再交一次就放行；阈值取高，宁可漏劝。

## 部署顺序

**worker 先，migration 0037 后。** 旧 worker 把认不出的 `kind` 按 chat 处理，而这一行输出价是 0、`routesQuery` 按输出价升序——反过来跑，它会排到 `me.models[0]`，变成所有订阅用户的默认聊天款与 Auto 的 simple 档，而它不会聊天。0033 写过同一条规则；那次漏的是清单末尾，这次是开头。

## 代价与已知未做

1. 合进去的那天什么都不会变好：五处全关。真机一次没跑过；OpenRouter 那条路的真实形状要等第一次真调用才算验过。
2. `alpha` 端点：OpenRouter 改路径或形状那天五处一起回落——不会坏，但会安静地失效，只有 `[decision]` 日志里的失败行会说话。
3. 新增两家数据处理方（OpenRouter、TypeSafe）。发过去的内容与今天给便宜 LLM 的同类；**语音是新的**：转写片段在人还没说完时就出了门；**记忆也是新的**：USER 档的条目（关于用户本人的事）会经过它们。
4. 每次决策调用一行 `usage_event`；一场 10 分钟的通话约 200 行。这几笔钱 `CostPanel` 看不到、`relayStateSince.spentMicro` 也数不到（同出图、同 Auto 今天那次分类调用）。
5. 七个阈值全是初值。
6. 挂住不回时的额外等待：派活 / Auto +1.2s，记忆 +0.9s，语音 +0.2s。
7. **一个有意的行为改动**：Auto 今天那条 LLM 路补上了 8s 超时（原来没有，一次挂住的网关调用会把 turn 的起跑永久卡住）。
8. 记忆工具从「每轮重建」改成「每会话一个实例」（那份「被劝过一次」的簿记要活过一轮）。
9. 主题桶归档不做（住在桌面那次合并调用里，抽出来一次 LLM 调用都省不掉）。

## 被否掉的

- TypeSafe 直连（要排队；翻回去的路：加一行 `platform='typesafe'` 的 route + `upstreamPathFor` 按平台分 `/systemone`，纯层与五处不动）。
- 单一开关（一处校准不行就得五处一起关）。
- 概率落进 SessionEvent（每一格都是永远的）。
- 对冲式并发（决策 600ms 没回就同时起 LLM：每次慢一点的决策都白烧一次 LLM，先量真实延迟分布再说）。
- 拿它做审批风险分级（放行类的闸）。
```

- [ ] **Step 2: `AGENTS.md` 索引一条**（加在 Where to find things 列表**最末**，一段）

```markdown
- `src/shared/decision.ts` / `services/edge/src/decisionUses.ts` / `services/edge/src/llmGateway.ts` 的 `serveDecision` / `services/runtime/src/dispatchDecision.ts` / `src/renderer/src/lib/utteranceHold.ts` / `src/shared/memoryTierJudge.ts` — **决策模型（Jev）经网关接入：五处分类器前置、LLM 兜底、分处三态开关**（ADR-0297，#1281）。五处（派活 / Auto 判难度 / 云会话重命名的 KEEP 闸 / 语音断句 / 记忆写入分档）今天都是「便宜 LLM 回一个词、正则去认」，判据里混着「模型听不听话」；决策模型不生成文字，收 `state` + 类型化问题回**类型化答案 + 校准概率**，于是「拿不准算 hard」从提示词里的一句请求变成一个阈值。**前置不替换**：没问出来 / 拿不准（`escalate`）→ 今天那条路，`requestDecision` 从不抛，`withDecision` 是五处共用的三态包装——没有哪一处会比改动前更差，除了一段有上限的等待。**不信上游的「0% 类型错误」**：`parseDecisionReply` 逐题验，一处不对整份 null（那句宣传说的是形状不是对错，而形状我们自己验得了；`Object.hasOwn` 不是 `in`——`"toString" in {}` 是 true）。**开关是 edge 里的三态常量** `DECISION_USES`（没列 / `shadow` / `on`，初始 `{}`），随 `/me` 的 `decision` 一格下发三端，翻一格最迟一分钟生效、不用发桌面版；不做成 `model_route` 上的一列，因为加列要「migration 先」而新 kind 要「worker 先」，两条相反的顺序压在同一次上线上。`shadow` = 今天那条路说了算、决策并行问一次只记一行 `[decision]` 日志——整件事最大的未知数是**中文校准**，而本机没有 OpenRouter 的 key，只能在生产上量；语音那一处的真值是**观测得到的**（final 之后 1.8 秒内人有没有接着说，`src/main/endpointJudge.ts` 在记，日志里只有字数没有正文）。**部署顺序 worker 先、migration 0037 后**：这一行输出价是 0，旧 worker 把认不出的 kind 按 chat，反过来跑它就是所有订阅用户的默认聊天款 + Auto 的 simple 档（0033 写过同一条，那次漏的是清单末尾，这次是开头）。runtime 三处**只动 `daemon.ts` 的注入点**，`sessionService.ts` 不认识决策模型（与 #1280 的约定，`tests/runtime/daemonDecisionWiring.test.ts` 钉着；daemon.ts 进不了 vitest，所以那是一条读源码的断言）。语音**不动 Swift**（重编 helper 要重新点 TCC）：渲染层的纯状态机扣住再合并，没开时整套旁路（零额外延迟由构造保证），只治「切碎」不治「没标点的整句白等 2.5s」。记忆那一处是**劝告不是闸**：模型原样再交一次就放行（判错一次不该把一条真事实永久挡在外面），为此记忆工具从每轮重建改成每会话一个实例。**只许加严不许放行**：审批 / `gitSafety` / 沙箱免审 / 护栏 / 额度闸一处都不接。已知代价九条在 ADR-0297，最要紧的三条：合进去那天五处全关、`alpha` 端点改形状时五处安静地回落（只有 `[decision]` 的失败行会说话）、新增两家数据处理方且语音转写与 USER 档记忆是新出门的内容。**要部署 edge + 跑 0037 + 部署 runtime 才生效**（#791），桌面三处还要等一次发版
```

- [ ] **Step 3: `CONTEXT.md` 两条术语**（`## Key invariants` 之前）

```markdown
- **决策模型（ADR-0297）**：不生成文字的那一类模型（今天只有 Jev）：收 `state` + 一组类型化问题（`noul` 是/否、`choice` 多选一、`score` 打分），一次前向回类型化答案 + **校准概率**。在 Otto 里只用来给五处分类器做**前置判断**（派活 / Auto / 重命名 / 语音断句 / 记忆分档），今天那条 LLM 路永远是兜底；**只许加严不许放行**，审批与各种闸一处都不接。三端共用的纯层在 `src/shared/decision.ts`，只经 edge 网关的 `/llm/v1/decision`（`model_route.kind='decision'`）。
- **影子模式（shadow，ADR-0297）**：决策模型分处开关的中间一档（没列 / `shadow` / `on`）。今天那条路说了算，决策模型并行问一次、**不等它**，回来之后记一行 `[decision] {json}` 对照日志（一致率与校准都从它 grep）。存在的理由是中文校准只能在生产上量；一处从 `shadow` 翻到 `on` 是一个一行 PR，正文贴那一处的数据。
```

- [ ] **Step 4: 跑文档断言**

Run: `npx vitest run tests/docs/ tests/architecture.noControlChars.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/adr/ AGENTS.md CONTEXT.md
git commit -m "docs: ADR-0297 + 索引一条 + 两条术语（决策模型经网关接入，#1281）"
```

---

### 收尾（主会话执行，不派子 agent）

- [ ] 全门禁：`npm test`，判据只认日志末尾的退出码（后台跑时 wrapper 的退出码不算数）。
- [ ] 终审：整分支（`origin/main..HEAD`）按 **spec** 而不是按本 plan 核，明确让它追 cross-task seams：`DecisionUses` 在 edge 常量 → `/me` → `parseBillingMe` → `modeOf` 三端是不是同一个形状；`use` 字符串在五处调用点与 `DECISION_USES` 的键是不是同一组；`withDecision` 的 `escalate` 在派活与重命名两处的语义；`hostedDeps.decision` 在子 agent / 子会话重建两处有没有真的接住；记忆工具提到 `buildTools` 外面之后有没有别的每轮重建的假设被打破。
- [ ] 留一轮修复 + scoped 复审。
- [ ] 合并前 `git fetch`：核 ADR 号与 migration 号有没有被别的 lane 占掉；核 `src/shared/remote/cloudSession.ts` 的协议号本分支没动过。
- [ ] PR（`Closes #1281`）→ CI 绿 → merge commit → `#1281` 关闭 → 交接 issue（五部分；要维护者动手的两步写清：部署 edge worker，**再**跑 0037）。
