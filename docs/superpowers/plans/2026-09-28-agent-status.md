# 智能体的状态画在头像上 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机上的会话列表、通讯录、资料页、聊天页按智能体此刻的真实状态画像素脸与角标（#1282）。

**Architecture:** 判定只写一份（`src/shared/agentActivity.ts`，与 `openTurns` 对拍）。runtime 在 `notify()` 里逐条折叠，经 `CloudSessionMeta.setActivity` 合帧写进新表 `agent_activity`，此刻在进行的几档每 60 秒心跳。手机全量拉一次、订 Supabase 实时推送，列表读那一行，聊天页用同一份判定本地现算。动效是 ADR-0316 现成的 17 档，不改画料。

**Tech Stack:** TypeScript（strict + exactOptionalPropertyTypes）、vitest、Supabase（Postgres + RLS + Realtime postgres_changes）、Node runtime daemon、Expo / React Native。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-status-design.md`

## Global Constraints

- 动效不改：用 `src/shared/ottoFace/states.ts` 现成的状态，不加画料、不改 `FACE_STATES`。
- 列表里闲着画 `plain`（静止）；单张大脸（资料页）闲着照旧 `alive`。不知道（读不到 / 过期 / 认不出）一律 `plain`、不画角标。
- 状态角标放头像右下，右上照旧是未读。
- 此刻在进行的几档（排队 / 思考 / 检索 / 执行 / 作答 / 等你处理）心跳 60 秒、3 分钟没心跳 = 不知道；出错、额度用完不心跳、不过期。
- `agent_activity` 闲下来写 `idle`，不删行；客户端只订 INSERT / UPDATE，不订 DELETE。不给 authenticated 任何写策略。
- 不改任何帧、不进协议位。桌面一行不动（等 #1403）。
- 部署顺序：0044（生产库，要维护者点头）→ 部署 runtime → 打手机包。任何一步没做都退回今天的样子。
- 门禁：`npm test`（tsc ×4 + vitest）。跑门禁的日志以 `GATE_EXIT=` 那一行为准。
- 注释用中文，写「为什么」，照仓里现有的密度。
- ADR 编号合并时才占（ADR-0074）：先写 0330，合并前 re-fetch，被占了就改成 max+1 并加 `原为 ADR-0330` 一行。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/agentActivity.ts` | 新建 | 判定：状态枚举、从日志折叠事实、事实到状态、次序、脸与角标、常量 |
| `src/shared/agentActivityRows.ts` | 新建 | 客户端这一侧：解析一行、判陈旧、按会话 / 按工作区取、全量拉、订推送、推送里的最后一句 |
| `supabase/migrations/0044_agent_activity.sql` | 新建 | 表、RLS 读策略、两张表进 publication |
| `services/runtime/src/activityWriter.ts` | 新建 | 每条会话一个：合帧写库、心跳、收摊 |
| `services/runtime/src/cloudSessionMeta.ts` | 改 | `setActivity`、`resetAgentActivity`、Supabase 版多收 `workspaceId` |
| `services/runtime/src/sessionService.ts` | 改 | 装配时折叠、`notify` / 流式 / 归档接线 |
| `services/runtime/src/daemon.ts` | 改 | `workspaceId` 传进 meta；启动先归零再补开房间 |
| `services/runtime/src/hostedRoute.ts` | 改 | 已知额度用完那条 blocked 带 `reroute` 分类 |
| `src/shared/wechatInbox.ts` | 改 | 九宫格每格带状态、每行带 `activity` |
| `src/shared/mobileChat.ts` | 改 | 「此刻」那一行用完整六档 |
| `mobile/src/activity/activityStore.ts` | 新建 | 本机一份 + 实时推送 + 换号清空 |
| `mobile/src/activity/ActivityFace.tsx` | 新建 | 带状态的脸 + 右下角标（通讯录、资料页共用） |
| `mobile/src/home/homeStore.ts` / `mobile/src/inbox/teamsStore.ts` | 改 | 各加一个就地补最后一句的口 |
| `mobile/src/wx/Badge.tsx` / `mobile/src/wx/Avatar.tsx` | 改 | `StatusBadge`；格子与单脸带上状态 |
| `mobile/src/tabs/ChatListRow.tsx` / `mobile/src/inbox/useInbox.ts` | 改 | 列表行的角标与读屏文字；拼行时传查状态的函数 |
| `mobile/src/tabs/ContactsScreen.tsx` / `mobile/src/agent/AgentScreen.tsx` / `mobile/src/chat/ChatScreen.tsx` | 改 | 通讯录、资料页、聊天头部状态字 |
| `docs/adr/0330-…md` / `AGENTS.md` | 新建 / 改 | 决定记录与索引 |

---

### Task 0: 准备 lane 的依赖

lane 是新开的，没有 `node_modules`。门禁只要能解析依赖，软链主 checkout 的就行（`mobile/` 那份在 Task 11 打真机包前要换成真装的，ADR-0329 附录）。

- [ ] **Step 1: 软链两份 node_modules**

```bash
ln -s /Users/stanyan/Github/Mr_Otto/node_modules node_modules
ln -s /Users/stanyan/Github/Mr_Otto/mobile/node_modules mobile/node_modules
```

- [ ] **Step 2: 确认基线是绿的**

Run: `npx vitest run tests/shared/turnLedger.test.ts tests/shared/wechatInbox.test.ts tests/shared/mobileChat.test.ts tests/runtime/cloudSessionMeta.test.ts tests/runtime/hostedRoute.test.ts`
Expected: 全部 PASS。

（不提交。注意 `.gitignore` 写的是 `node_modules/`，只匹配目录，软链是文件，所以 `git status` 会把这两个软链列成未跟踪。全程按路径 `git add`，**不许 `git add -A` / `git add .`**。）

---

### Task 1: 判定（`src/shared/agentActivity.ts`）

**Files:**
- Create: `src/shared/agentActivity.ts`
- Test: `tests/shared/agentActivity.test.ts`

**Interfaces:**
- Consumes: `openTurns`（`src/shared/turnLedger.ts`，只在测试里对拍）；`FACE_STATES`、`FaceBadge`、`FaceState`（`src/shared/ottoFace/states.ts`）；`generateLog`、`GEN_AGENTS`（`tests/helpers/relayLog.ts`）。
- Produces:
  - `type AgentActivity = "queued" | "composing" | "searching" | "working" | "solving" | "waiting" | "limited" | "failed" | "idle"`
  - `ACTIVITY_ORDER: readonly AgentActivity[]`、`ACTIVITY_TEXT: Record<AgentActivity, string>`、`LIVE_ACTIVITIES: ReadonlySet<AgentActivity>`
  - `ACTIVITY_THROTTLE_MS = 1_000`、`ACTIVITY_BEAT_MS = 60_000`、`ACTIVITY_STALE_MS = 180_000`
  - `isAgentActivity(v: unknown): v is AgentActivity`、`SEARCH_TOOLS`、`toolKind(name: string): "search" | "work"`
  - `interface ActivityFold`、`emptyActivityFold(): ActivityFold`、`foldActivity(fold: ActivityFold, e: SessionEvent): void`、`activityFoldOf(events: readonly SessionEvent[]): ActivityFold`
  - `activityOf(fold: ActivityFold, agentId: string, streaming: boolean): AgentActivity`
  - `turnStateOf(fold: ActivityFold, agentId: string): "none" | "queued" | "running"`、`knownAgents(fold: ActivityFold): string[]`
  - `mostUrgent(states: Iterable<AgentActivity>): AgentActivity | null`
  - `activityFace(a: AgentActivity | null, idle?: FaceState): FaceState`、`activityBadge(a: AgentActivity | null): FaceBadge | null`

- [ ] **Step 1: 写失败的测试**

`tests/shared/agentActivity.test.ts`：

```ts
// agentActivity —— 一只智能体此刻在干嘛（#1282，spec §1）。
// 逐档造日志断言状态；「欠不欠、在不在跑」在 200 份伪随机日志的每个前缀上与 openTurns 对拍。
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_ORDER, activityBadge, activityFace, activityFoldOf, activityOf, emptyActivityFold, foldActivity,
  isAgentActivity, knownAgents, mostUrgent, toolKind, turnStateOf,
} from "../../src/shared/agentActivity.js";
import { openTurns } from "../../src/shared/turnLedger.js";
import type { SessionEvent } from "../../src/session/events.js";
import { GEN_AGENTS, generateLog } from "../helpers/relayLog.js";

let seq = 0;
beforeEach(() => {
  seq = 0;
});
const ev = (e: Record<string, unknown>): SessionEvent => ({ sessionId: "s1", ts: seq, seq: seq++, ...e }) as unknown as SessionEvent;
const mention = (agentId: string) => ev({ type: "user_message", content: "[Stan]: 看下", fromUid: "me", mentions: [agentId] });
const envelope = (agentId: string) => ev({ type: "request_envelope", agentId });
const ask = (agentId: string, calls: [string, string][]) =>
  ev({ type: "assistant_message", content: "", model: "m", agentId, toolCalls: calls.map(([id, name]) => ({ id, name, args: {} })) });
const say = (agentId: string) => ev({ type: "assistant_message", content: "好了", model: "m", agentId });
const result = (toolCallId: string) => ev({ type: "tool_result", toolCallId, status: "ok", output: "" });
const end = (agentId: string, extra: Record<string, unknown> = {}) => ev({ type: "turn_ended", outcome: "completed", agentId, ...extra });
const state = (events: SessionEvent[], agentId: string, streaming = false) => activityOf(activityFoldOf(events), agentId, streaming);

describe("activityOf：逐档（spec §1.1）", () => {
  it("点了名还没动静 = 排队中；这只有任何一条动静 = 思考中；收口 = 闲着", () => {
    const events = [mention("ops")];
    expect(state(events, "ops")).toBe("queued");
    events.push(envelope("ops"));
    expect(state(events, "ops")).toBe("composing");
    events.push(say("ops"), end("ops"));
    expect(state(events, "ops")).toBe("idle");
  });
  it("要了只读的刀 = 检索中；要了别的刀 = 执行中；混着要 = 执行中；认不出的刀 = 执行中", () => {
    expect(state([mention("ops"), ask("ops", [["c1", "read_file"]])], "ops")).toBe("searching");
    expect(state([mention("ops"), ask("ops", [["c1", "wiki_read"]])], "ops")).toBe("searching");
    expect(state([mention("ops"), ask("ops", [["c1", "bash"]])], "ops")).toBe("working");
    expect(state([mention("ops"), ask("ops", [["c1", "read_file"], ["c2", "git_push"]])], "ops")).toBe("working");
    expect(state([mention("ops"), ask("ops", [["c1", "px_shopify_orders"]])], "ops")).toBe("working");
  });
  it("刀的结果回来 = 回到思考中；只回来一把时按剩下的那把算", () => {
    expect(state([mention("ops"), ask("ops", [["c1", "read_file"]]), result("c1")], "ops")).toBe("composing");
    expect(state([mention("ops"), ask("ops", [["c1", "bash"], ["c2", "read_file"]]), result("c1")], "ops")).toBe("searching");
  });
  it("在吐字 = 作答中，压过手上的刀；审批没批 = 等你处理，压过吐字；批了回到手上的刀", () => {
    const events = [mention("ops"), ask("ops", [["c1", "bash"]])];
    expect(state(events, "ops", true)).toBe("solving");
    events.push(ev({ type: "approval_request", callId: "c1", toolName: "bash", argsSummary: "", initiatorUid: "me", expiresTs: 0, agentId: "ops" }));
    expect(state(events, "ops", true)).toBe("waiting");
    events.push(ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }));
    expect(state(events, "ops")).toBe("working");
  });
  it("收口：error = 出错；error + reroute = 额度用完；按停止（aborted）与 interrupted 都不算出错", () => {
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "error", error: "x" })], "ops")).toBe("failed");
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "error", error: "x", errorClass: "reroute" })], "ops")).toBe("limited");
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "aborted" })], "ops")).toBe("idle");
    expect(state([mention("ops"), envelope("ops"), end("ops", { outcome: "interrupted" })], "ops")).toBe("idle");
  });
  it("出错一直挂着，直到又欠它一轮：新的点名 = 排队中；跑完 = 闲着", () => {
    const events = [mention("ops"), envelope("ops"), end("ops", { outcome: "error", error: "x" }), say("ads")];
    expect(state(events, "ops")).toBe("failed");
    events.push(mention("ops"));
    expect(state(events, "ops")).toBe("queued");
    events.push(envelope("ops"));
    expect(state(events, "ops")).toBe("composing");
    events.push(end("ops"));
    expect(state(events, "ops")).toBe("idle");
  });
  it("跑到一半才到的点名不随这一轮收口（readUpToSeq）：收口后仍是排队中", () => {
    // seq 0 点名、seq 1 动静、seq 2 又点名、seq 3 收口（这一轮开跑时只看到 seq 1）
    const events = [mention("ops"), envelope("ops"), mention("ops"), end("ops", { readUpToSeq: 1 })];
    expect(state(events, "ops")).toBe("queued");
  });
  it("收口顺手清掉手上的刀与审批；别只的收口不算数", () => {
    const events = [mention("ops"), ask("ops", [["c1", "bash"]]), end("ads")];
    expect(state(events, "ops")).toBe("working");
    events.push(end("ops"));
    expect(state(events, "ops")).toBe("idle");
  });
  it("没见过的智能体 = 闲着；knownAgents 列出点过名或有过动静的", () => {
    const fold = activityFoldOf([mention("ops"), say("ads")]);
    expect(activityOf(fold, "nobody", false)).toBe("idle");
    expect(knownAgents(fold).sort()).toEqual(["ads", "ops"]);
  });
});

describe("次序与画法", () => {
  it("mostUrgent：等你处理 > 作答 > 执行 > 检索 > 思考 > 排队 > 额度用完 > 出错 > 闲着；空 = null", () => {
    expect(ACTIVITY_ORDER).toEqual(["waiting", "solving", "working", "searching", "composing", "queued", "limited", "failed", "idle"]);
    expect(mostUrgent(["idle", "failed", "queued"])).toBe("queued");
    expect(mostUrgent(["composing", "waiting"])).toBe("waiting");
    expect(mostUrgent([])).toBeNull();
  });
  it("activityFace：不知道 = plain；闲着按调用方给；其余同名", () => {
    expect(activityFace(null)).toBe("plain");
    expect(activityFace("idle")).toBe("plain");
    expect(activityFace("idle", "alive")).toBe("alive");
    expect(activityFace("working")).toBe("working");
    expect(activityFace("limited")).toBe("limited");
  });
  it("activityBadge：不知道 / 闲着不画；排队灰、干活蓝、等你与额度琥珀、出错红", () => {
    expect(activityBadge(null)).toBeNull();
    expect(activityBadge("idle")).toBeNull();
    expect(activityBadge("queued")).toBe("mute");
    expect(activityBadge("solving")).toBe("work");
    expect(activityBadge("waiting")).toBe("need");
    expect(activityBadge("limited")).toBe("need");
    expect(activityBadge("failed")).toBe("bad");
  });
  it("isAgentActivity / toolKind", () => {
    expect(isAgentActivity("working")).toBe(true);
    expect(isAgentActivity("speaking")).toBe(false);
    expect(toolKind("read_file")).toBe("search");
    expect(toolKind("whatever")).toBe("work");
  });
});

describe("与 openTurns 对拍（spec §1.5）", () => {
  it("200 份伪随机日志的每一个前缀上，「欠不欠、在不在跑」逐只相同", () => {
    for (let s = 1; s <= 200; s++) {
      const log = generateLog(s);
      const fold = emptyActivityFold();
      for (let i = 0; i <= log.length; i++) {
        if (i > 0) foldActivity(fold, log[i - 1]!);
        const turns = openTurns(log.slice(0, i));
        for (const a of GEN_AGENTS) {
          const mine = turns.filter((t) => t.agentId === a);
          const want = mine.some((t) => t.state === "running") ? "running" : mine.length > 0 ? "queued" : "none";
          expect(turnStateOf(fold, a), `seed=${s} i=${i} agent=${a}`).toBe(want);
        }
      }
    }
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/shared/agentActivity.test.ts`
Expected: FAIL，报 `Failed to resolve import "../../src/shared/agentActivity.js"`。

- [ ] **Step 3: 写实现**

`src/shared/agentActivity.ts`：

```ts
// agentActivity —— 一只智能体此刻在干嘛（#1282，spec docs/superpowers/specs/2026-09-28-agent-status-design.md §1）。
//
// 判定只写这一份：runtime 按它写 agent_activity 那张表（列表画的是那一行），手机聊天页按它现算
// （头部与「此刻」那一行）。两处由构造就是同一个判据，不会一处说在跑、一处说闲着。
//
// 「欠不欠它一轮、在不在跑」与 turnLedger.openTurns 逐条同语义（tests/shared/agentActivity.test.ts
// 在 200 份伪随机日志的每个前缀上对拍），这里是它的增量版：runtime 每条事件推进一次，不回头读日志。
// 纯函数零 IO；foldActivity 就地改 fold（runtime 一条会话一份，跟着 notify 走）。

import type { SessionEvent } from "../session/events.js";
import { FACE_STATES, type FaceBadge, type FaceState } from "./ottoFace/states.js";

export type AgentActivity =
  | "queued"
  | "composing"
  | "searching"
  | "working"
  | "solving"
  | "waiting"
  | "limited"
  | "failed"
  | "idle";

/** 最要紧的在前（spec §1.4），下标就是次序：通讯录、群头像那枚角标、聊天页「此刻」那一行都按它取 */
export const ACTIVITY_ORDER: readonly AgentActivity[] = [
  "waiting", "solving", "working", "searching", "composing", "queued", "limited", "failed", "idle",
];

export const ACTIVITY_TEXT: Readonly<Record<AgentActivity, string>> = {
  queued: "排队中",
  composing: "思考中",
  searching: "检索中",
  working: "执行中",
  solving: "作答中",
  waiting: "等你处理",
  limited: "额度用完",
  failed: "出错",
  idle: "闲着",
};

/** 此刻在进行的几档：要心跳，过期了就当不知道。出错 / 额度用完说的是上一轮的结局，不过期（spec §3.3） */
export const LIVE_ACTIVITIES: ReadonlySet<AgentActivity> = new Set<AgentActivity>([
  "queued", "composing", "searching", "working", "solving", "waiting",
]);

/** runtime 写库的合帧窗口 */
export const ACTIVITY_THROTTLE_MS = 1_000;
/** 此刻在进行的几档多久补一次心跳 */
export const ACTIVITY_BEAT_MS = 60_000;
/** 连着丢三次心跳 = 不知道 */
export const ACTIVITY_STALE_MS = 3 * ACTIVITY_BEAT_MS;

export function isAgentActivity(v: unknown): v is AgentActivity {
  return typeof v === "string" && (ACTIVITY_ORDER as readonly string[]).includes(v);
}

/** 只读的刀（spec §1.2）。其余一律算执行，认不出的也是：宁可说它在动手，不说它在翻资料 */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set(["read_file", "wiki_read"]);

export function toolKind(name: string): "search" | "work" {
  return SEARCH_TOOLS.has(name) ? "search" : "work";
}

interface AgentFacts {
  /** 还没见过它动静的点名（开场白 seq） */
  queued: number[];
  /** 见过动静、还没收口的点名 */
  running: number[];
  /** 它最近一条 assistant_message 要的工具里还没等到 tool_result 的：callId → 哪一类 */
  tools: Map<string, "search" | "work">;
  /** 还没批的审批（callId） */
  approvals: Set<string>;
  /** 上一轮怎么收口的 */
  lastEnd: "ok" | "failed" | "limited";
}

export interface ActivityFold {
  readonly agents: Map<string, AgentFacts>;
  /** callId → 哪一只：tool_result / approval_decision 身上不一定带 agentId */
  readonly callOwner: Map<string, string>;
}

export function emptyActivityFold(): ActivityFold {
  return { agents: new Map(), callOwner: new Map() };
}

function factsOf(fold: ActivityFold, agentId: string): AgentFacts {
  let f = fold.agents.get(agentId);
  if (f === undefined) {
    f = { queued: [], running: [], tools: new Map(), approvals: new Set(), lastEnd: "ok" };
    fold.agents.set(agentId, f);
  }
  return f;
}

/**
 * 推进一条事件（就地改 fold）。顺序讲究同 openTurns ①：一条事件**先当「这只的动静」、再当「新的点名」**——
 * 护栏私话是带 agentId 的 user_message，也可能带 mentions。
 *
 * 手上的刀从「模型要了」那一刻算起（assistant_message.toolCalls），不等 tool_execution_started：
 * 中间那段它在等审批或等容器锁，干的就是这件事，不是在思考（spec §1.2）。
 */
export function foldActivity(fold: ActivityFold, e: SessionEvent): void {
  const owner = "agentId" in e ? e.agentId : undefined;
  if (owner !== undefined) {
    const f = factsOf(fold, owner);
    if (e.type === "turn_ended") {
      // 这一轮开跑时还没看见的点名（readUpToSeq < 那条的 seq）不随它收口；缺席 = 老日志，一律收口
      const stillOpen = (s: number): boolean => e.readUpToSeq !== undefined && e.readUpToSeq < s;
      f.queued = f.queued.filter(stillOpen);
      f.running = f.running.filter(stillOpen);
      for (const id of f.tools.keys()) fold.callOwner.delete(id);
      for (const id of f.approvals) fold.callOwner.delete(id);
      f.tools.clear();
      f.approvals.clear();
      f.lastEnd = e.outcome !== "error" ? "ok" : e.errorClass === "reroute" ? "limited" : "failed";
    } else {
      if (f.queued.length > 0) {
        f.running.push(...f.queued);
        f.queued = [];
      }
      if (e.type === "assistant_message") {
        for (const id of f.tools.keys()) fold.callOwner.delete(id);
        f.tools.clear();
        for (const c of e.toolCalls ?? []) {
          f.tools.set(c.id, toolKind(c.name));
          fold.callOwner.set(c.id, owner);
        }
      } else if (e.type === "approval_request") {
        f.approvals.add(e.callId);
        fold.callOwner.set(e.callId, owner);
      }
    }
  }
  if (e.type === "approval_decision") {
    const who = fold.callOwner.get(e.toolCallId);
    if (who !== undefined) fold.agents.get(who)?.approvals.delete(e.toolCallId);
  } else if (e.type === "tool_result") {
    // 批了 / 拒了之后都还有一条 tool_result，callOwner 在这里才收
    const who = fold.callOwner.get(e.toolCallId);
    if (who !== undefined) {
      fold.agents.get(who)?.tools.delete(e.toolCallId);
      fold.callOwner.delete(e.toolCallId);
    }
  }
  if (e.type === "user_message" && e.mentions) {
    for (const agentId of e.mentions) factsOf(fold, agentId).queued.push(e.seq);
  }
}

export function activityFoldOf(events: readonly SessionEvent[]): ActivityFold {
  const fold = emptyActivityFold();
  for (const e of events) foldActivity(fold, e);
  return fold;
}

/** 点过名或有过动静的那几只（runtime 每次推进后逐只交给 writer） */
export function knownAgents(fold: ActivityFold): string[] {
  return [...fold.agents.keys()];
}

/** 与 openTurns 对拍用的那一格：欠不欠它、在不在跑 */
export function turnStateOf(fold: ActivityFold, agentId: string): "none" | "queued" | "running" {
  const f = fold.agents.get(agentId);
  if (f === undefined) return "none";
  if (f.running.length > 0) return "running";
  return f.queued.length > 0 ? "queued" : "none";
}

/** 从事实到状态（spec §1.3），取第一条成立的。`streaming` = 这一步已经在吐字（碎片不是事件，由调用方给） */
export function activityOf(fold: ActivityFold, agentId: string, streaming: boolean): AgentActivity {
  const f = fold.agents.get(agentId);
  if (f === undefined) return "idle";
  if (f.running.length > 0) {
    if (f.approvals.size > 0) return "waiting";
    if (streaming) return "solving";
    if (f.tools.size > 0) return [...f.tools.values()].includes("work") ? "working" : "searching";
    return "composing";
  }
  if (f.queued.length > 0) return "queued";
  if (f.lastEnd === "limited") return "limited";
  if (f.lastEnd === "failed") return "failed";
  return "idle";
}

/** 几个状态里最要紧的那个（spec §1.4）。一个都没有 = null */
export function mostUrgent(states: Iterable<AgentActivity>): AgentActivity | null {
  let best: AgentActivity | null = null;
  for (const s of states) {
    if (best === null || ACTIVITY_ORDER.indexOf(s) < ACTIVITY_ORDER.indexOf(best)) best = s;
  }
  return best;
}

const ACTIVITY_FACE: Readonly<Record<Exclude<AgentActivity, "idle">, FaceState>> = {
  queued: "queued",
  composing: "composing",
  searching: "searching",
  working: "working",
  solving: "solving",
  waiting: "waiting",
  limited: "limited",
  failed: "failed",
};

/** 画哪张脸。不知道（null）一律 plain（ADR-0316：plain 不声称任何事）；闲着按调用方给——
    列表里 plain（一列头像一起呼吸是噪音，动 = 在干活），单张大脸 alive */
export function activityFace(a: AgentActivity | null, idle: FaceState = "plain"): FaceState {
  if (a === null) return "plain";
  return a === "idle" ? idle : ACTIVITY_FACE[a];
}

/** 角标颜色（ADR-0316 的语义色）。不知道 / 闲着不画 */
export function activityBadge(a: AgentActivity | null): FaceBadge | null {
  if (a === null || a === "idle") return null;
  return FACE_STATES[ACTIVITY_FACE[a]].badge;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/shared/agentActivity.test.ts`
Expected: PASS（对拍那条在几秒内跑完）。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add src/shared/agentActivity.ts tests/shared/agentActivity.test.ts
git commit -m "feat(shared): 智能体此刻在干嘛的判定，与 openTurns 对拍（#1282）

runtime 写库与手机聊天页共用这一份，列表与聊天页由构造就是同一个判据。
手上的刀从模型要了那一刻算起，不等 tool_execution_started：中间那段在等审批或等容器锁。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 客户端这一侧的行（`src/shared/agentActivityRows.ts`）

**Files:**
- Create: `src/shared/agentActivityRows.ts`
- Test: `tests/shared/agentActivityRows.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ACTIVITY_STALE_MS`、`LIVE_ACTIVITIES`、`isAgentActivity`、`mostUrgent`、`AgentActivity`；`SessionLast`（`src/shared/sessionLast.ts`）。
- Produces:
  - `interface ActivityRow { sessionId: string; agentId: string; workspaceId: string; state: string; since: number; beat: number }`、`type ActivityIndex = ReadonlyMap<string, ActivityRow>`
  - `activityKey(sessionId: string, agentId: string): string`
  - `activityRowOf(raw: unknown): ActivityRow | null`
  - `liveActivity(row: ActivityRow, now: number): AgentActivity | null`
  - `sessionAgentActivity(rows: ActivityIndex, sessionId: string, agentId: string, now: number): AgentActivity | null`
  - `workspaceAgentActivity(rows: ActivityIndex, workspaceId: string, agentId: string, now: number): AgentActivity | null`
  - `fetchAgentActivity(client: SupabaseClient): Promise<ActivityRow[] | null>`
  - `sessionLastOfRow(raw: unknown): { sessionId: string; last: SessionLast } | null`
  - `subscribeAgentActivity(client: SupabaseClient, uid: string, h: { onRow: (r: ActivityRow) => void; onSession: (raw: unknown, kind: "insert" | "update") => void }): () => void`

- [ ] **Step 1: 写失败的测试**

`tests/shared/agentActivityRows.test.ts`：

```ts
// agentActivityRows —— agent_activity 在客户端这一侧（#1282，spec §3.3 / §3.4）：解析、陈旧、取状态、拉取、订阅。
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVITY_STALE_MS } from "../../src/shared/agentActivity.js";
import {
  activityKey, activityRowOf, fetchAgentActivity, liveActivity, sessionAgentActivity, sessionLastOfRow,
  subscribeAgentActivity, workspaceAgentActivity, type ActivityRow,
} from "../../src/shared/agentActivityRows.js";

const T = Date.parse("2026-09-28T10:00:00.000Z");
const raw = (o: Record<string, unknown> = {}) => ({
  session_id: "s1", agent_id: "ops", workspace_id: "w1", state: "working",
  since: "2026-09-28T09:59:00.000Z", beat: "2026-09-28T10:00:00.000Z", ...o,
});
const rowOf = (o: Record<string, unknown> = {}): ActivityRow => activityRowOf(raw(o))!;
const index = (...rows: ActivityRow[]) => new Map(rows.map((r) => [activityKey(r.sessionId, r.agentId), r]));

describe("activityRowOf", () => {
  it("解析一行；时间转毫秒", () => {
    expect(activityRowOf(raw())).toEqual({ sessionId: "s1", agentId: "ops", workspaceId: "w1", state: "working", since: T - 60_000, beat: T });
  });
  it("缺格 / 形状不对 / 时间解析不出 → null", () => {
    expect(activityRowOf(null)).toBeNull();
    expect(activityRowOf(raw({ agent_id: 3 }))).toBeNull();
    expect(activityRowOf(raw({ beat: "garbage" }))).toBeNull();
  });
});

describe("liveActivity（spec §3.3）", () => {
  it("此刻在进行的几档：3 分钟没心跳 = 不知道", () => {
    const r = rowOf();
    expect(liveActivity(r, T + ACTIVITY_STALE_MS)).toBe("working");
    expect(liveActivity(r, T + ACTIVITY_STALE_MS + 1)).toBeNull();
  });
  it("出错 / 额度用完 / 闲着不过期", () => {
    expect(liveActivity(rowOf({ state: "failed" }), T + 10 * ACTIVITY_STALE_MS)).toBe("failed");
    expect(liveActivity(rowOf({ state: "limited" }), T + 10 * ACTIVITY_STALE_MS)).toBe("limited");
    expect(liveActivity(rowOf({ state: "idle" }), T + 10 * ACTIVITY_STALE_MS)).toBe("idle");
  });
  it("认不出的状态（将来 runtime 多了一档）= 不知道", () => {
    expect(liveActivity(rowOf({ state: "dreaming" }), T)).toBeNull();
  });
});

describe("按会话 / 按工作区取", () => {
  const rows = index(
    rowOf({ session_id: "dm", state: "working" }),
    rowOf({ session_id: "g1", state: "waiting" }),
    rowOf({ session_id: "g2", state: "failed" }),
    rowOf({ session_id: "t1", workspace_id: "w2", state: "solving" }),
    rowOf({ session_id: "dm", agent_id: "ads", state: "idle" }),
  );
  it("sessionAgentActivity：有行按行，没行 = null", () => {
    expect(sessionAgentActivity(rows, "dm", "ops", T)).toBe("working");
    expect(sessionAgentActivity(rows, "dm", "nobody", T)).toBeNull();
  });
  it("workspaceAgentActivity：只看这个工作区、取最要紧；一行都不知道 = null；过期的不算", () => {
    expect(workspaceAgentActivity(rows, "w1", "ops", T)).toBe("waiting");
    expect(workspaceAgentActivity(rows, "w2", "ops", T)).toBe("solving");
    expect(workspaceAgentActivity(rows, "w1", "ads", T)).toBe("idle");
    expect(workspaceAgentActivity(rows, "w1", "nobody", T)).toBeNull();
    expect(workspaceAgentActivity(rows, "w1", "ops", T + ACTIVITY_STALE_MS + 1)).toBe("failed");
  });
});

describe("fetchAgentActivity", () => {
  const client = (res: { data?: unknown; error?: unknown }, calls: string[] = []) =>
    ({
      from: (t: string) => {
        calls.push(`from:${t}`);
        return { select: async (c: string) => { calls.push(`select:${c}`); return { data: res.data ?? null, error: res.error ?? null }; } };
      },
    }) as unknown as SupabaseClient;
  it("一条查询全量拉，解析不了的行丢掉", async () => {
    const calls: string[] = [];
    const rows = await fetchAgentActivity(client({ data: [raw(), { junk: true }] }, calls));
    expect(calls).toEqual(["from:agent_activity", "select:session_id,agent_id,workspace_id,state,since,beat"]);
    expect(rows).toEqual([rowOf()]);
  });
  it("读不到（表还不在 / 断网）→ null，不是空数组（读不到 ≠ 没有）", async () => {
    expect(await fetchAgentActivity(client({ error: { message: "relation does not exist", code: "42P01" } }))).toBeNull();
    const throwing = { from: () => { throw new Error("offline"); } } as unknown as SupabaseClient;
    expect(await fetchAgentActivity(throwing)).toBeNull();
  });
});

describe("sessionLastOfRow", () => {
  it("推送里那一行的最后一句（同 fetchCloudLasts 的解析）", () => {
    expect(sessionLastOfRow({ id: "s1", last_ts: "2026-09-28T10:00:00.000Z", last_excerpt: "好了", last_from: "agent:ops" }))
      .toEqual({ sessionId: "s1", last: { ts: T, excerpt: "好了", from: "agent:ops" } });
  });
  it("还没人说过话 / 解析不出 → null；另两格形状不对退回空串", () => {
    expect(sessionLastOfRow({ id: "s1", last_ts: null })).toBeNull();
    expect(sessionLastOfRow({ id: "s1", last_ts: "x" })).toBeNull();
    expect(sessionLastOfRow(null)).toBeNull();
    expect(sessionLastOfRow({ id: "s1", last_ts: "2026-09-28T10:00:00.000Z" })).toEqual({ sessionId: "s1", last: { ts: T, excerpt: "", from: "" } });
  });
});

describe("subscribeAgentActivity", () => {
  it("一条频道订两张表的 INSERT / UPDATE，不订 DELETE；退订 = removeChannel", () => {
    const handlers: { filter: { event: string; table: string }; cb: (p: { new: unknown }) => void }[] = [];
    const channel = {
      on: (_type: string, filter: { event: string; table: string }, cb: (p: { new: unknown }) => void) => {
        handlers.push({ filter, cb });
        return channel;
      },
      subscribe: () => channel,
    };
    const channelFn = vi.fn(() => channel);
    const removeChannel = vi.fn(async () => "ok");
    const client = { channel: channelFn, removeChannel } as unknown as SupabaseClient;
    const onRow = vi.fn();
    const onSession = vi.fn();
    const stop = subscribeAgentActivity(client, "me", { onRow, onSession });
    expect(channelFn).toHaveBeenCalledWith("agent-activity-me");
    expect(handlers.map((h) => `${h.filter.table}:${h.filter.event}`)).toEqual([
      "agent_activity:INSERT", "agent_activity:UPDATE", "workspace_sessions:INSERT", "workspace_sessions:UPDATE",
    ]);
    handlers[1]!.cb({ new: raw({ state: "solving" }) });
    expect(onRow).toHaveBeenCalledWith(rowOf({ state: "solving" }));
    handlers[0]!.cb({ new: { junk: true } });
    expect(onRow).toHaveBeenCalledTimes(1);
    handlers[3]!.cb({ new: { id: "s1" } });
    expect(onSession).toHaveBeenCalledWith({ id: "s1" }, "update");
    stop();
    expect(removeChannel).toHaveBeenCalledWith(channel);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/shared/agentActivityRows.test.ts`
Expected: FAIL，报找不到 `agentActivityRows.js`。

- [ ] **Step 3: 写实现**

`src/shared/agentActivityRows.ts`：

```ts
// agentActivityRows —— agent_activity 那张表在客户端这一侧（#1282，spec §3.3 / §3.4）：
// 解析一行、判陈旧、按会话 / 按工作区取状态、全量拉、订实时推送。判据在 agentActivity.ts，
// 这里只管「表里那一行此刻说明什么」。手机现在用，桌面等 #1403 之后接同一份。

import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVITY_STALE_MS, LIVE_ACTIVITIES, isAgentActivity, mostUrgent, type AgentActivity } from "./agentActivity.js";
import type { SessionLast } from "./sessionLast.js";

export interface ActivityRow {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  /** 原样留着字符串：认不出的值（将来 runtime 多了一档）由 liveActivity 判成「不知道」 */
  state: string;
  since: number;
  beat: number;
}

export type ActivityIndex = ReadonlyMap<string, ActivityRow>;

export function activityKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

export function activityRowOf(raw: unknown): ActivityRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.session_id !== "string" || typeof r.agent_id !== "string" || typeof r.workspace_id !== "string") return null;
  if (typeof r.state !== "string" || typeof r.since !== "string" || typeof r.beat !== "string") return null;
  const since = Date.parse(r.since);
  const beat = Date.parse(r.beat);
  if (Number.isNaN(since) || Number.isNaN(beat)) return null;
  return { sessionId: r.session_id, agentId: r.agent_id, workspaceId: r.workspace_id, state: r.state, since, beat };
}

/** 这一行此刻说明什么。null = 不知道：认不出的状态，或此刻在进行的几档过了 3 分钟没心跳。
    出错 / 额度用完 / 闲着不过期：前两样说的是上一轮的结局，闲着不需要证明（spec §3.3） */
export function liveActivity(row: ActivityRow, now: number): AgentActivity | null {
  if (!isAgentActivity(row.state)) return null;
  if (LIVE_ACTIVITIES.has(row.state) && now - row.beat > ACTIVITY_STALE_MS) return null;
  return row.state;
}

export function sessionAgentActivity(rows: ActivityIndex, sessionId: string, agentId: string, now: number): AgentActivity | null {
  const r = rows.get(activityKey(sessionId, agentId));
  return r === undefined ? null : liveActivity(r, now);
}

/** 一只智能体在一个工作区所有会话里最要紧的那个（通讯录、资料页只有一张脸）。一行都不知道 = null */
export function workspaceAgentActivity(rows: ActivityIndex, workspaceId: string, agentId: string, now: number): AgentActivity | null {
  const known: AgentActivity[] = [];
  for (const r of rows.values()) {
    if (r.workspaceId !== workspaceId || r.agentId !== agentId) continue;
    const a = liveActivity(r, now);
    if (a !== null) known.push(a);
  }
  return mostUrgent(known);
}

/** 全量拉一次。RLS 已经把范围收在我能看的会话里。读不到回 null，不是空数组：读不到 ≠ 没有 */
export async function fetchAgentActivity(client: SupabaseClient): Promise<ActivityRow[] | null> {
  try {
    const res = await client.from("agent_activity").select("session_id,agent_id,workspace_id,state,since,beat");
    if (res.error) return null;
    const out: ActivityRow[] = [];
    for (const raw of (res.data ?? []) as unknown[]) {
      const r = activityRowOf(raw);
      if (r !== null) out.push(r);
    }
    return out;
  } catch {
    return null;
  }
}

/** 实时推送里 workspace_sessions 那一行带来的最后一句（解析同 supabaseWorkspacesApi.fetchCloudLasts）。
    last_ts 为 null（还没人说过一句算数的话）或解析不出 = null */
export function sessionLastOfRow(raw: unknown): { sessionId: string; last: SessionLast } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.last_ts !== "string") return null;
  const ts = Date.parse(r.last_ts);
  if (Number.isNaN(ts)) return null;
  return {
    sessionId: r.id,
    last: {
      ts,
      excerpt: typeof r.last_excerpt === "string" ? r.last_excerpt : "",
      from: typeof r.last_from === "string" ? r.last_from : "",
    },
  };
}

/**
 * 订 agent_activity 与 workspace_sessions 的 INSERT / UPDATE，一条频道。
 * **不订 DELETE**：Realtime 对 DELETE 不查 RLS，会把别人的主键推给所有订阅者（spec §3.1）。
 * 回退订函数。
 */
export function subscribeAgentActivity(
  client: SupabaseClient,
  uid: string,
  h: { onRow: (r: ActivityRow) => void; onSession: (raw: unknown, kind: "insert" | "update") => void },
): () => void {
  const row = (p: { new: unknown }): void => {
    const r = activityRowOf(p.new);
    if (r !== null) h.onRow(r);
  };
  const ch = client
    .channel(`agent-activity-${uid}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_activity" }, row)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agent_activity" }, row)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "workspace_sessions" }, (p) => h.onSession(p.new, "insert"))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspace_sessions" }, (p) => h.onSession(p.new, "update"))
    .subscribe();
  return () => {
    void client.removeChannel(ch);
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/shared/agentActivityRows.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查（根与手机两份 supabase-js 类型都要过）**

Run: `npx tsc --noEmit && npm --prefix mobile run typecheck`
Expected: 无错误。手机那份此刻还没 import 这个文件，第二条只是基线；Task 9 之后再跑一次才算数。

- [ ] **Step 6: 提交**

```bash
git add src/shared/agentActivityRows.ts tests/shared/agentActivityRows.test.ts
git commit -m "feat(shared): agent_activity 在客户端这一侧——陈旧判定、取状态、拉取与订阅（#1282）

只订 INSERT / UPDATE：Realtime 对 DELETE 不查 RLS。读不到回 null 不回空，读不到 ≠ 没有。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: migration 0044

**Files:**
- Create: `supabase/migrations/0044_agent_activity.sql`
- Test: `tests/docs/agentActivityMigration.test.ts`

**Interfaces:**
- Consumes: `public.is_ws_member(uuid, uuid)`（0015 起）、`public.is_session_guest(text, uuid)`（0043）。
- Produces: 表 `public.agent_activity(session_id uuid, agent_id text, workspace_id uuid, state text, since timestamptz, beat timestamptz)`，主键 `(session_id, agent_id)`；`agent_activity` 与 `workspace_sessions` 进 `supabase_realtime`。

- [ ] **Step 1: 写失败的测试**

`tests/docs/agentActivityMigration.test.ts`：

```ts
// 0044_agent_activity.sql 的可执行版（#1282，spec §3.1）。migration 是在生产手动执行的，门禁跑不到它；
// 这几条钉的是「写方只有 runtime」「客户端只读在籍的」「两张表进了实时推送」在 SQL 上的样子。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../supabase/migrations/0044_agent_activity.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("0044_agent_activity", () => {
  it("一行 = 一条会话里的一只；会话删了跟着删", () => {
    expect(code).toMatch(/create table if not exists public\.agent_activity/);
    expect(code).toMatch(/session_id\s+uuid not null references public\.workspace_sessions\(id\) on delete cascade/);
    expect(code).toMatch(/primary key \(session_id, agent_id\)/);
  });
  it("RLS 开着；只有一条 select 策略（在籍成员或这条群的客人）；不给 authenticated 任何写策略", () => {
    expect(code).toMatch(/alter table public\.agent_activity enable row level security/);
    expect(code).toMatch(/create policy aa_select on public\.agent_activity for select to authenticated/);
    expect(code).toMatch(/is_ws_member\(workspace_id, auth\.uid\(\)\)/);
    expect(code).toMatch(/is_session_guest\(session_id::text, auth\.uid\(\)\)/);
    expect(code).not.toMatch(/on public\.agent_activity for (insert|update|delete|all)/);
  });
  it("state 不加 CHECK：旧手机把认不出的值当「不知道」，以后多一档状态库不用跟着改", () => {
    expect(code).not.toMatch(/check\s*\(/i);
  });
  it("两张表都进 supabase_realtime（幂等：已在里面时吞掉 duplicate_object）", () => {
    expect(code).toMatch(/alter publication supabase_realtime add table public\.agent_activity;/);
    expect(code).toMatch(/alter publication supabase_realtime add table public\.workspace_sessions;/);
    expect(code.match(/exception when duplicate_object then null/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/docs/agentActivityMigration.test.ts`
Expected: FAIL，`ENOENT` 找不到 0044。

- [ ] **Step 3: 写 migration**

`supabase/migrations/0044_agent_activity.sql`：

```sql
-- 0044_agent_activity.sql —— 每只智能体此刻在干嘛（#1282，spec docs/superpowers/specs/2026-09-28-agent-status-design.md §3.1）。
-- 幂等，重跑不炸。与 0030 / 0040 同一约定：Supabase SQL editor / Management API 手动执行一次（那个端点
-- 只回最后一条语句的结果，逐条发）。**部署顺序：先跑这份、再部署 runtime**——反过来 runtime 每条会话
-- 记一行「表不存在」，列表照旧静止，不出别的事。
--
-- 为什么要一张新表：聊天页外面拿不到「谁在跑」（手机同一时刻只连一条云会话），列表只能画静止的脸。
-- 这张表是 runtime 手上那份日志的**投影**（判据 src/shared/agentActivity.ts，runtime 写库与手机聊天页
-- 现算共用一份）。整表丢掉也没关系：daemon 重启时各会话按日志重新写回来。
--
-- 一行 = 一条会话里的一只智能体。闲下来写 'idle'，**不删行**：Realtime 对 DELETE 不查 RLS，会把主键推给
-- 所有订阅者（客户端也只订 INSERT / UPDATE）。会话删了，这几行跟着级联删。
-- state 不加 CHECK：以后 runtime 多一档状态时，旧手机把认不出的值当「不知道」，库不用跟着改。
--
-- 写方只有 runtime（service key，绕过 RLS）。**不给 authenticated 任何写策略**：给了就是让任何在籍成员
-- 伪造「某只智能体正在等你审批」。
--
-- since : 进入这个状态的时刻
-- beat  : 最后一次心跳。此刻在进行的几档每 60 秒补一次，客户端 3 分钟没收到就当「不知道」

create table if not exists public.agent_activity (
  session_id   uuid not null references public.workspace_sessions(id) on delete cascade,
  agent_id     text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  state        text not null,
  since        timestamptz not null,
  beat         timestamptz not null,
  primary key (session_id, agent_id)
);

alter table public.agent_activity enable row level security;

-- 读：这个工作区的在籍成员，或这条群的客人（0043）。与 workspace_sessions 那两条读策略同一个范围
drop policy if exists aa_select on public.agent_activity;
create policy aa_select on public.agent_activity for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()) or public.is_session_guest(session_id::text, auth.uid()));

-- Realtime：进 publication 才有 postgres_changes 可推（RLS 照常生效）。
-- workspace_sessions 顺带进来：列表里的最后一句、排序要跟着脸一起实时变（spec §3.1）。
-- 幂等：add table 对已在 publication 里的表会报 42710，用 exception 吞掉（同 0013 / 0030）
do $$
begin
  alter publication supabase_realtime add table public.agent_activity;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.workspace_sessions;
exception when duplicate_object then null;
end $$;
```

- [ ] **Step 4: 跑测试，确认通过（含编号唯一那条）**

Run: `npx vitest run tests/docs/agentActivityMigration.test.ts tests/docs/migrationNumbers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add supabase/migrations/0044_agent_activity.sql tests/docs/agentActivityMigration.test.ts
git commit -m "feat(db): agent_activity 表 + workspace_sessions 进实时推送（#1282）

写方只有 runtime；闲下来写 idle 不删行（Realtime 对 DELETE 不查 RLS）；state 不加 CHECK。
要先在生产跑这份、再部署 runtime。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: runtime 的写库节流与心跳（`activityWriter.ts`）

**Files:**
- Create: `services/runtime/src/activityWriter.ts`
- Test: `tests/runtime/activityWriter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LIVE_ACTIVITIES`、`AgentActivity`。
- Produces:
  - `interface ActivityWrite { agentId: string; state: AgentActivity; since: number; beat: number }`
  - `interface ActivityWriter { set(agentId: string, state: AgentActivity): void; close(): void }`
  - `createActivityWriter(o: { write: (rows: ActivityWrite[]) => Promise<void>; throttleMs: number; beatMs: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown }): ActivityWriter`

- [ ] **Step 1: 写失败的测试**

`tests/runtime/activityWriter.test.ts`：

```ts
// activityWriter —— agent_activity 写库的合帧 + 心跳（#1282，spec §3.2）。时钟与定时器注入，不动 vi 的假定时器。
import { describe, expect, it } from "vitest";
import { createActivityWriter, type ActivityWrite } from "../../services/runtime/src/activityWriter.js";

function rig(o: { fail?: boolean } = {}) {
  let t = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  const writes: ActivityWrite[][] = [];
  const w = createActivityWriter({
    write: async (rows) => {
      writes.push(rows);
      if (o.fail) throw new Error("boom");
    },
    throttleMs: 1_000,
    beatMs: 60_000,
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ at: t + ms, fn });
    },
  });
  /** 时钟走到 to，途中到点的定时器按时刻先后执行 */
  const advance = (to: number): void => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > to) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = to;
  };
  return { w, writes, advance };
}
const states = (rows: ActivityWrite[]) => rows.map((r) => `${r.agentId}:${r.state}`);

describe("createActivityWriter", () => {
  it("第一次就是非 idle：当场写（首沿）；第一次就是 idle：不写（没有那一行 = 闲着）", () => {
    const r = rig();
    r.w.set("ads", "idle");
    expect(r.writes).toEqual([]);
    r.w.set("ops", "queued");
    expect(r.writes.map(states)).toEqual([["ops:queued"]]);
    expect(r.writes[0]![0]).toMatchObject({ since: 1_000, beat: 1_000 });
  });
  it("窗口里的几次变化合成一次尾沿写，带每只最后的状态；同一个状态再 set 不写", () => {
    const r = rig();
    r.w.set("ops", "queued");
    r.w.set("ops", "composing");
    r.w.set("ops", "composing");
    r.w.set("ads", "queued");
    r.w.set("ops", "working");
    expect(r.writes).toHaveLength(1);
    r.advance(2_000);
    expect(r.writes.map(states)).toEqual([["ops:queued"], ["ops:working", "ads:queued"]]);
  });
  it("心跳：此刻在进行的几档每 beatMs 补写一次（同状态同 since、新 beat）；闲下来就停", () => {
    const r = rig();
    r.w.set("ops", "working");
    r.advance(61_000);
    expect(r.writes).toHaveLength(2);
    expect(r.writes[1]).toEqual([{ agentId: "ops", state: "working", since: 1_000, beat: 61_000 }]);
    r.w.set("ops", "idle");
    r.advance(201_000);
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:working"], ["ops:idle"]]);
  });
  it("出错 / 额度用完不心跳（说的是上一轮的结局，不过期）", () => {
    const r = rig();
    r.w.set("ops", "failed");
    r.advance(301_000);
    expect(r.writes.map(states)).toEqual([["ops:failed"]]);
  });
  it("close：不在 idle 的当场写成 idle；之后的 set 与到点的定时器一律不理", () => {
    const r = rig();
    r.w.set("ops", "working");
    r.w.set("ads", "failed"); // 窗口内，挂在尾沿
    r.w.close();
    expect(r.writes.map(states)).toEqual([["ops:working"], ["ops:idle", "ads:idle"]]);
    r.w.set("ops", "queued");
    r.advance(301_000);
    expect(r.writes).toHaveLength(2);
  });
  it("写失败不抛（这是日志的投影，下一次变化盖掉）", async () => {
    const r = rig({ fail: true });
    expect(() => r.w.set("ops", "working")).not.toThrow();
    await Promise.resolve();
    expect(r.writes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/runtime/activityWriter.test.ts`
Expected: FAIL，找不到 `activityWriter.js`。

- [ ] **Step 3: 写实现**

`services/runtime/src/activityWriter.ts`：

```ts
// activityWriter —— agent_activity 那张表的写库节流 + 心跳（#1282，spec §3.2）。每条会话一个。
//
// 形状同 lastWriter：首尾两沿，窗口从上一次**写**算起；一次把这条会话里变了的几只一起写。
// 另有一件 lastWriter 没有的事：心跳。此刻在进行的几档（LIVE_ACTIVITIES）每 beatMs 补写一次 beat，
// 客户端 3 次没收到就当「不知道」——daemon 崩了、没来得及写 idle 时，列表不会永远停在「在跑」上。
// 出错 / 额度用完不心跳：它们说的是上一轮的结局，不过期（spec §3.3）。
//
// 一只智能体第一次出现就是 idle 的不写：没有那一行 = 闲着（客户端两者画法相同），而 daemon 启动时
// 已经把上一个进程留下的行全部写回了 idle（cloudSessionMeta.resetAgentActivity）。
// 写的是日志的投影：失败只丢这一次（CloudSessionMeta 的实现自己记日志），下一次变化盖掉。
// 时钟与定时器可注入，测试不必动 vi 的假定时器。

import { LIVE_ACTIVITIES, type AgentActivity } from "../../../src/shared/agentActivity.js";

export interface ActivityWrite {
  agentId: string;
  state: AgentActivity;
  since: number;
  beat: number;
}

export interface ActivityWriter {
  set(agentId: string, state: AgentActivity): void;
  /** 收摊（归档）：不在 idle 的当场写成 idle，之后的 set 与到点的定时器一律不理 */
  close(): void;
}

export function createActivityWriter(o: {
  write: (rows: ActivityWrite[]) => Promise<void>;
  throttleMs: number;
  beatMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}): ActivityWriter {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number): unknown => {
    const t = setTimeout(fn, ms);
    // 一个待写的状态投影不该拖着进程不退（daemon 收摊、测试结束时）
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const current = new Map<string, { state: AgentActivity; since: number }>();
  const dirty = new Set<string>();
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let armed = false;
  let beating = false;
  let closed = false;

  const send = (ids: Iterable<string>): void => {
    const at = now();
    const rows: ActivityWrite[] = [];
    for (const id of ids) {
      const c = current.get(id);
      if (c !== undefined) rows.push({ agentId: id, state: c.state, since: c.since, beat: at });
    }
    if (rows.length === 0) return;
    void o.write(rows).catch(() => undefined);
  };

  const liveIds = (): string[] => [...current].filter(([, c]) => LIVE_ACTIVITIES.has(c.state)).map(([id]) => id);

  const armBeat = (): void => {
    if (beating || closed || liveIds().length === 0) return;
    beating = true;
    setTimer(beat, o.beatMs);
  };

  function beat(): void {
    beating = false;
    if (closed) return;
    const live = liveIds();
    if (live.length === 0) return;
    send(live);
    armBeat();
  }

  const fire = (): void => {
    armed = false;
    if (closed || dirty.size === 0) return;
    lastWriteAt = now();
    const ids = [...dirty];
    dirty.clear();
    send(ids);
    armBeat();
  };

  return {
    set(agentId, state) {
      if (closed) return;
      const prev = current.get(agentId);
      if (prev?.state === state) return;
      current.set(agentId, { state, since: now() });
      if (prev === undefined && state === "idle") return;
      dirty.add(agentId);
      if (armed) return;
      const wait = lastWriteAt + o.throttleMs - now();
      if (wait <= 0) {
        fire();
        return;
      }
      armed = true;
      setTimer(fire, wait);
    },
    close() {
      if (closed) return;
      const t = now();
      const idle: string[] = [];
      for (const [id, c] of current) {
        if (c.state === "idle") continue;
        current.set(id, { state: "idle", since: t });
        idle.push(id);
      }
      closed = true;
      dirty.clear();
      send(idle);
    },
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/runtime/activityWriter.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p services/runtime`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src/activityWriter.ts tests/runtime/activityWriter.test.ts
git commit -m "feat(runtime): agent_activity 写库的合帧与心跳（#1282）

形状同 lastWriter。此刻在进行的几档 60 秒一次心跳，daemon 崩了列表最多 3 分钟回到静止；
出错 / 额度用完不心跳。第一次就是 idle 的不写：没有那一行就是闲着。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `CloudSessionMeta.setActivity` 与启动归零

**Files:**
- Modify: `services/runtime/src/cloudSessionMeta.ts`
- Test: `tests/runtime/cloudSessionMeta.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `ActivityWrite`。
- Produces:
  - `CloudSessionMeta.setActivity(rows: ActivityWrite[]): Promise<void>`（接口方法，所有实现都要有）
  - `createInMemoryCloudSessionMeta()` 多一格 `activity: ActivityWrite[][]`
  - `createSupabaseCloudSessionMeta(client, sessionId, log, workspaceId: string)`（第四个参数新增、必填）
  - `resetAgentActivity(client: SupabaseClient, log: (msg: string) => void, now?: number): Promise<void>`

- [ ] **Step 1: 改现有用例的调用、加新用例（先红）**

`tests/runtime/cloudSessionMeta.test.ts`：
1. 把文件里 6 处 `createSupabaseCloudSessionMeta(f.client, "sess-1", ...)` 都补上第四个参数 `"ws-1"`（用编辑器全文替换 `, () => {})` / `, log)` 结尾前加 `, "ws-1"`，逐处核对）。
2. import 改成 `import { createInMemoryCloudSessionMeta, createSupabaseCloudSessionMeta, resetAgentActivity } from "../../services/runtime/src/cloudSessionMeta.js";`
3. 文件末尾追加：

```ts
describe("setActivity（#1282）", () => {
  it("内存版记下每一批", async () => {
    const meta = createInMemoryCloudSessionMeta();
    await meta.setActivity([{ agentId: "ops", state: "working", since: 1, beat: 2 }]);
    expect(meta.activity).toEqual([[{ agentId: "ops", state: "working", since: 1, beat: 2 }]]);
  });

  function upsertClient(result: { error: { message: string; code?: string } | null } | Error) {
    const upsert = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const from = vi.fn().mockReturnValue({ upsert });
    return { client: { from } as never, from, upsert };
  }

  it("真库版：一批 upsert 进 agent_activity，按 (session_id, agent_id) 覆盖，时间写 ISO", async () => {
    const f = upsertClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}, "ws-1").setActivity([
      { agentId: "ops", state: "working", since: Date.parse("2026-09-28T10:00:00.000Z"), beat: Date.parse("2026-09-28T10:01:00.000Z") },
    ]);
    expect(f.from).toHaveBeenCalledWith("agent_activity");
    expect(f.upsert).toHaveBeenCalledWith(
      [{ session_id: "sess-1", agent_id: "ops", workspace_id: "ws-1", state: "working", since: "2026-09-28T10:00:00.000Z", beat: "2026-09-28T10:01:00.000Z" }],
      { onConflict: "session_id,agent_id" },
    );
  });

  it("表还不在（0044 没跑：42P01 / PGRST205）：这条会话只记一行，不刷屏", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      const log = vi.fn();
      const f = upsertClient({ error: { message: "relation does not exist", code } });
      const meta = createSupabaseCloudSessionMeta(f.client, "sess-1", log, "ws-1");
      await meta.setActivity([{ agentId: "ops", state: "working", since: 1, beat: 1 }]);
      await meta.setActivity([{ agentId: "ops", state: "idle", since: 2, beat: 2 }]);
      expect(log).toHaveBeenCalledTimes(1);
    }
  });

  it("别的错每次都记；网络层 reject 记日志不抛", async () => {
    const log = vi.fn();
    const f = upsertClient({ error: { message: "boom", code: "XX000" } });
    const meta = createSupabaseCloudSessionMeta(f.client, "sess-1", log, "ws-1");
    await meta.setActivity([{ agentId: "ops", state: "working", since: 1, beat: 1 }]);
    await meta.setActivity([{ agentId: "ops", state: "idle", since: 2, beat: 2 }]);
    expect(log).toHaveBeenCalledTimes(2);
    const log2 = vi.fn();
    const g = upsertClient(new Error("offline"));
    await expect(
      createSupabaseCloudSessionMeta(g.client, "sess-1", log2, "ws-1").setActivity([{ agentId: "ops", state: "working", since: 1, beat: 1 }]),
    ).resolves.toBeUndefined();
    expect(log2).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});

describe("resetAgentActivity（#1282）", () => {
  it("上一个进程留下的非 idle 行全部写回 idle", async () => {
    const neq = vi.fn(async () => ({ error: null }));
    const update = vi.fn().mockReturnValue({ neq });
    const from = vi.fn().mockReturnValue({ update });
    await resetAgentActivity({ from } as never, () => {}, Date.parse("2026-09-28T10:00:00.000Z"));
    expect(from).toHaveBeenCalledWith("agent_activity");
    expect(update).toHaveBeenCalledWith({ state: "idle", since: "2026-09-28T10:00:00.000Z", beat: "2026-09-28T10:00:00.000Z" });
    expect(neq).toHaveBeenCalledWith("state", "idle");
  });
  it("失败只记日志不抛", async () => {
    const log = vi.fn();
    const neq = vi.fn(async () => ({ error: { message: "boom" } }));
    await resetAgentActivity({ from: () => ({ update: () => ({ neq }) }) } as never, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/runtime/cloudSessionMeta.test.ts`
Expected: FAIL（`setActivity is not a function` / `resetAgentActivity` 未导出）。

- [ ] **Step 3: 改实现**

`services/runtime/src/cloudSessionMeta.ts`：

1. 文件头注释第一段后加一句：

```ts
// #1282 起这里也是 agent_activity 那张表的写入口（`setActivity` / `resetAgentActivity`）：同是这条会话
// 的日志投影、同是 service key、同是「失败只记日志不抛」，不另开一个装配参数。
```

2. import 加：`import type { ActivityWrite } from "./activityWriter.js";`

3. 接口加一格：

```ts
  /** agent_activity 那张表（#1282，spec §3.2）：这条会话里几只智能体的状态，一次写一批。节流与心跳在
      调用方（activityWriter）。接口方法而不是可选依赖：漏实现编译不过，而不是安静地永远不写 */
  setActivity(rows: ActivityWrite[]): Promise<void>;
```

4. 内存版：

```ts
export function createInMemoryCloudSessionMeta(): CloudSessionMeta & {
  title: string | null;
  participants: ParticipantWindow | null;
  last: SessionLast | null;
  /** setActivity 收到的每一批，按先后 */
  activity: ActivityWrite[][];
} {
  const state: { title: string | null; participants: ParticipantWindow | null; last: SessionLast | null; activity: ActivityWrite[][] } = {
    title: null,
    participants: null,
    last: null,
    activity: [],
  };
  return {
    get title() { return state.title; },
    get participants() { return state.participants; },
    get last() { return state.last; },
    get activity() { return state.activity; },
    async setTitle(title) { state.title = title; },
    async setParticipants(w) { state.participants = { window: w.window, uids: [...w.uids] }; },
    async setLast(l) { state.last = { ...l }; },
    async setActivity(rows) { state.activity.push(rows.map((r) => ({ ...r }))); },
  };
}
```

5. 真库版签名加 `workspaceId: string`（第四个参数），`return` 之前加一格、对象里加一个方法：

```ts
export function createSupabaseCloudSessionMeta(
  client: SupabaseClient,
  sessionId: string,
  log: (msg: string) => void,
  workspaceId: string,
): CloudSessionMeta {
  // ……原有的 write() 不动……

  /** 0044 还没跑时每一次写都撞「表不存在」（Postgres 42P01 / PostgREST PGRST205）：这条会话只说一次 */
  let activityMissingSaid = false;

  return {
    // ……原有三个方法不动……
    async setActivity(rows) {
      try {
        const { error } = await client.from("agent_activity").upsert(
          rows.map((r) => ({
            session_id: sessionId,
            agent_id: r.agentId,
            workspace_id: workspaceId,
            state: r.state,
            since: new Date(r.since).toISOString(),
            beat: new Date(r.beat).toISOString(),
          })),
          { onConflict: "session_id,agent_id" },
        );
        if (!error) return;
        if (error.code === "42P01" || error.code === "PGRST205") {
          if (activityMissingSaid) return;
          activityMissingSaid = true;
        }
        log(`[otto-runtime] 智能体状态写入失败（session=${sessionId}）：${error.message}`);
      } catch (err: unknown) {
        log(`[otto-runtime] 智能体状态写入抛出异常（session=${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
```

6. 文件末尾加：

```ts
/** daemon 启动时、补开房间**之前**调（spec §3.2）：上一个进程留下的非 idle 行全部写回 idle。
    只有一个 daemon，所以这些行都是它自己上一次留下的。各房间装配时再按自己的日志把真状态写回来；
    顺序反过来，这一步会把刚写回的真状态盖成 idle。不抛：写不进去只是列表多静止一会儿 */
export async function resetAgentActivity(client: SupabaseClient, log: (msg: string) => void, now: number = Date.now()): Promise<void> {
  const at = new Date(now).toISOString();
  try {
    const { error } = await client.from("agent_activity").update({ state: "idle", since: at, beat: at }).neq("state", "idle");
    if (error) log(`[otto-runtime] 启动时把智能体状态归零失败：${error.message}`);
  } catch (err: unknown) {
    log(`[otto-runtime] 启动时把智能体状态归零抛出异常：${err instanceof Error ? err.message : String(err)}`);
  }
}
```

7. `services/runtime/src/daemon.ts` 的唯一调用点（`sessionMeta: createSupabaseCloudSessionMeta(supabase, sessionId, (m) => console.warn(m)),`）先补上 `, workspaceId`，让 tsc 过（接线断言在 Task 6）：

```ts
      sessionMeta: createSupabaseCloudSessionMeta(supabase, sessionId, (m) => console.warn(m), workspaceId),
```

（`openSessionRoom(workspaceId, sessionId, ...)` 的参数里就有 `workspaceId`。）

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/runtime/cloudSessionMeta.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查（内存版的所有使用点：sessionService.test.ts、checks/smokeAssembly.ts 自动拿到 setActivity）**

Run: `npx tsc --noEmit -p services/runtime && npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src/cloudSessionMeta.ts services/runtime/src/daemon.ts tests/runtime/cloudSessionMeta.test.ts
git commit -m "feat(runtime): CloudSessionMeta 多一个 setActivity，加启动归零（#1282）

状态表同是这条会话的日志投影，走同一个写入口。表不在时每条会话只记一行。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: sessionService 与 daemon 接线

**Files:**
- Modify: `services/runtime/src/sessionService.ts`（import、`CloudSessionOpts`、装配处 ≈ `lastWriter` 之后、`notify()`、`onAssistantDelta`、`archive()`）
- Modify: `services/runtime/src/daemon.ts`（启动补开房间之前）
- Test: `tests/runtime/sessionService.test.ts`（追加一个 describe）
- Test: `tests/runtime/daemonActivityWiring.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `activityFoldOf`、`foldActivity`、`activityOf`、`knownAgents`、`ACTIVITY_THROTTLE_MS`、`ACTIVITY_BEAT_MS`；Task 4 的 `createActivityWriter`；Task 5 的 `setActivity`、`resetAgentActivity`。
- Produces: `CloudSessionOpts.activityThrottleMs?: number`（测试传 0）。

- [ ] **Step 1: 写失败的测试**

`tests/runtime/sessionService.test.ts` 文件末尾追加（`baseOpts`、`testWiki`、`newStore`、`echoAdapter`、`createInMemoryCloudSessionMeta` 都是文件里现成的）：

```ts
describe("智能体状态（#1282）", () => {
  it("一轮：排队 → 思考 → 检索 → 思考 → 闲着，逐次写进 agent_activity", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let round = 0;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        round++;
        return round === 1 ? { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] } : { content: "看完了" };
      },
    };
    const meta = createInMemoryCloudSessionMeta();
    const session = createCloudSession({ ...baseOpts(store, events, adapter), sessionMeta: meta, wiki: testWiki(), activityThrottleMs: 0 });
    await session.say("u1", "alice", "看下 a.txt", true);
    await session.settled();
    expect(meta.activity.flat().filter((r) => r.agentId === "default").map((r) => r.state)).toEqual([
      "queued", "composing", "searching", "composing", "idle",
    ]);
    store.close();
  });

  it("装配时按日志写回：上一轮出错的那只写成出错；归档时写成 idle，之后不再写", () => {
    const store = newStore();
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: 在吗", fromUid: "u1", mentions: ["default"] } as never);
    store.append({ sessionId: "s1", ts: 2, type: "request_envelope", agentId: "default" } as never);
    store.append({ sessionId: "s1", ts: 3, type: "turn_ended", outcome: "error", error: "boom", agentId: "default" } as never);
    const meta = createInMemoryCloudSessionMeta();
    const session = createCloudSession({ ...baseOpts(store, [], echoAdapter), sessionMeta: meta, wiki: testWiki(), activityThrottleMs: 0 });
    expect(meta.activity.flat().map((r) => `${r.agentId}:${r.state}`)).toEqual(["default:failed"]);
    expect(session.archive("alice")).toBe(true);
    expect(meta.activity.flat().map((r) => `${r.agentId}:${r.state}`)).toEqual(["default:failed", "default:idle"]);
    store.close();
  });
});
```

注：第二条里的 `request_envelope` 只带 `type` / `agentId`，所以要 `as never`。`EventStore.append` 运行时只查这个类型能不能落盘（`shouldPersist`），不校验 payload 形状，`request_envelope` 是落盘的类型。

`tests/runtime/daemonActivityWiring.test.ts`：

```ts
// daemon.ts 进不了 vitest（import 即连 docker / Supabase）。状态表（#1282）在它身上两处接线，漏了都是安静的：
// 状态永远写不进库（列表静止，与今天一样，没人发现），或者启动归零排在补开房间之后、把刚写回的真状态盖成 idle。
// 所以判据落在源码上（同 daemonNewAgentWiring.test.ts / daemonDecisionWiring.test.ts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：智能体状态的接线（#1282）", () => {
  it("每条会话的 sessionMeta 带上 workspaceId（agent_activity 那一列要它）", () => {
    expect(src).toMatch(/createSupabaseCloudSessionMeta\(supabase, sessionId, \(m\) => console\.warn\(m\), workspaceId\)/);
  });
  it("启动时先归零、再补开房间", () => {
    const reset = src.indexOf("await resetAgentActivity(supabase");
    const reopen = src.indexOf("const { data: cloudSessions, error: cloudErr } = await supabase");
    expect(reset).toBeGreaterThan(-1);
    expect(reopen).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(reopen);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/runtime/sessionService.test.ts -t "智能体状态" && npx vitest run tests/runtime/daemonActivityWiring.test.ts`
Expected: FAIL（`meta.activity` 为空；daemon 里找不到 `resetAgentActivity`）。

- [ ] **Step 3: 接 sessionService**

`services/runtime/src/sessionService.ts`：

1. import（放在 `import { createLastWriter } from "./lastWriter.js";` 旁边）：

```ts
import { ACTIVITY_BEAT_MS, ACTIVITY_THROTTLE_MS, activityFoldOf, activityOf, foldActivity, knownAgents } from "../../../src/shared/agentActivity.js";
import { createActivityWriter } from "./activityWriter.js";
```

2. `CloudSessionOpts` 里 `lastThrottleMs?: number;` 下面加：

```ts
  /** agent_activity 写库的合帧窗口（#1282）。**可选**：缺席 = ACTIVITY_THROTTLE_MS（1 秒）。
      只有测试传 0（每次变化都当场写，断言不用等定时器） */
  activityThrottleMs?: number;
```

3. `const lastWriter = createLastWriter({...});` 之后加：

```ts
  /** 每只智能体此刻在干嘛（#1282，spec §3.2）。装配时整份折叠一次（就是下面重启补跑 `openTurns(seed)` 用的
      那份 seed），之后在 notify 里逐条推进——同 bounds / voiceCall 的手法。流式正文不是事件，「在不在吐字」
      另记一格，终态事件落盘时清掉（同 deltas.clearAgent）。判据在 shared/agentActivity.ts，与手机聊天页共用 */
  const activityFold = activityFoldOf(seed);
  const streamingNow = new Set<string>();
  const activity = createActivityWriter({
    write: (rows) => opts.sessionMeta.setActivity(rows),
    throttleMs: opts.activityThrottleMs ?? ACTIVITY_THROTTLE_MS,
    beatMs: ACTIVITY_BEAT_MS,
  });
  /** 各只的新状态交给 writer；没变的 writer 自己跳过 */
  const pushActivity = (): void => {
    for (const id of knownAgents(activityFold)) activity.set(id, activityOf(activityFold, id, streamingNow.has(id)));
  };
  pushActivity();
```

4. `notify()` 里 `if (last !== null) lastWriter.push(last);` 之后、`opts.onEvent(e);` 之前加：

```ts
    // 智能体状态（#1282）：同 advanceRelayBounds 的推理——daemon.ts 绕过 notify 直接 append 的那四类
    // （chat_message / model_usage / route_changed / session_created）与状态无关，漏不掉
    foldActivity(activityFold, e);
    if ((e.type === "assistant_message" || e.type === "turn_ended") && e.agentId) streamingNow.delete(e.agentId);
    pushActivity();
```

5. `onAssistantDelta` 改成（行为对 deltas 逐字不变，只多喂一格）：

```ts
            onAssistantDelta: (text: string, kind: DeltaKind) => {
              if (kind !== "content") return;
              deltas.push(spec.agentId, "content", text);
              // 这一步开始吐字 = 作答中（#1282）。只在第一片时推一次，后面几十片不必逐片过一遍 writer
              if (!streamingNow.has(spec.agentId)) {
                streamingNow.add(spec.agentId);
                pushActivity();
              }
            },
```

6. `archive()` 里最后一个 `notify(store.append({ ... type: "session_archived", reason: "user" }));` 之后、`return true;` 之前加：

```ts
      // 收摊（#1282）：还挂着的状态全部写成 idle，之后不再写——归档的会话不会再有人来答它。
      // 删除先走归档（ADR-0245），不另写
      activity.close();
```

- [ ] **Step 4: 接 daemon**

`services/runtime/src/daemon.ts`：

1. import 改成：`import { createSupabaseCloudSessionMeta, resetAgentActivity } from "./cloudSessionMeta.js";`
2. 在 `// ── 存量云会话补开房间：…` 那段注释**之前**加：

```ts
  // 智能体状态表（#1282）：上一个进程留下的「在跑」全部写回 idle，**排在补开房间之前**——各房间装配时
  // 按自己的日志把真状态写回来；顺序反过来，这一步会把刚写回的真状态盖成 idle。写不进去只记日志
  await resetAgentActivity(supabase, (m) => console.warn(m));
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npx vitest run tests/runtime/sessionService.test.ts tests/runtime/daemonActivityWiring.test.ts`
Expected: 全部 PASS（新旧用例都绿：`onEvent` 收到的事件序列没有任何变化）。

- [ ] **Step 6: 类型检查 + runtime 冒烟装配**

Run: `npx tsc --noEmit -p services/runtime && npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 7: 提交**

```bash
git add services/runtime/src/sessionService.ts services/runtime/src/daemon.ts tests/runtime/sessionService.test.ts tests/runtime/daemonActivityWiring.test.ts
git commit -m "feat(runtime): 云会话把每只智能体的状态写进 agent_activity（#1282）

装配时按日志折叠一次、notify 里逐条推进，流式第一片翻成作答中，归档收摊写 idle。
daemon 启动先归零再补开房间，顺序反了会盖掉刚写回的真状态（读源码的断言钉着）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 已知额度用完那条错带 `reroute` 分类

**Files:**
- Modify: `services/runtime/src/hostedRoute.ts`（`RuntimeRoute` 类型、`decideRuntimeRoute` 的 exhausted 分支、adapter 的 `chat()`）
- Test: `tests/runtime/hostedRoute.test.ts`

**Interfaces:**
- Consumes: `markErrorClass`（已 import）。
- Produces: `RuntimeRoute` 的 blocked 变体多一格 `quota?: true`。`probeModelRoute` 只取 `kind`，不外泄。

- [ ] **Step 1: 写失败的测试**

放进 `tests/runtime/hostedRoute.test.ts` 里定义了 `adapterBase` 的那个 describe（D4「429 quota_exhausted」那几条旁边）：

```ts
  it("已知额度用完那一挡抛的错带 reroute 分类（状态表画「额度用完」不画「出错」，#1282）；没订阅那一挡不带", async () => {
    const memo = createRouteMemo();
    memo.noteExhausted(10_000);
    const exhausted = createHostedRuntimeAdapter({ ...adapterBase, routeMemo: memo, now: () => 0, probe: { me: async () => me } });
    const err1 = await exhausted.chat([{ role: "user", content: "1" }]).catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(Error);
    expect((err1 as Error).message).toMatch(/额度用完/);
    expect(errorClassOf(err1)).toBe("reroute");
    const none = createHostedRuntimeAdapter({ ...adapterBase, routeMemo: createRouteMemo(), probe: { me: async () => null } });
    const err2 = await none.chat([{ role: "user", content: "1" }]).catch((e: unknown) => e);
    expect(errorClassOf(err2)).toBeUndefined();
  });
```

以及放进「decideRuntimeRoute」那个 describe：

```ts
  it("exhausted 那一挡带 quota 记号；没订阅那一挡不带（#1282）", () => {
    expect(decideRuntimeRoute({ me, requestedModels: [], exhausted: true, ...base })).toMatchObject({ kind: "blocked", quota: true });
    expect(decideRuntimeRoute({ me: null, requestedModels: [], ...base })).not.toHaveProperty("quota");
  });
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/runtime/hostedRoute.test.ts`
Expected: FAIL（`errorClassOf(err1)` 是 `undefined`；blocked 上没有 `quota`）。

- [ ] **Step 3: 改实现**

`services/runtime/src/hostedRoute.ts`：

1. 类型：

```ts
export type RuntimeRoute =
  | { kind: "hosted"; endpoint: ResolvedEndpoint; model: string }
  /** `quota` = 已知额度用完（网关刚说过、窗口还没到）。只影响抛出去的那条错的分类：收口时
      turn_ended.errorClass = reroute，状态表画「额度用完」不画「出错」（#1282）。措辞不因它变 */
  | { kind: "blocked"; reason: string; quota?: true };
```

2. `decideRuntimeRoute` 的 `if (o.exhausted) { return { kind: "blocked", reason: … } }` 返回值里加 `quota: true`：

```ts
  if (o.exhausted) {
    return {
      kind: "blocked",
      reason:
        "团队所有者的订阅额度用完了，这个 turn 起不了。等这扇额度窗口刷新，或所有者加购额度后再 @。",
      quota: true,
    };
  }
```

3. adapter `chat()` 里：

```ts
      if (route.kind === "blocked") {
        // 已知额度用完那一挡带 reroute 分类（同网关 429 那条，openaiCompatible.ts）：turn_ended.errorClass
        // 从这里来，状态表据此画「额度用完」而不是「出错」（#1282）
        const err = new Error(route.reason);
        throw route.quota === true ? markErrorClass(err, "reroute") : err;
      }
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/runtime/hostedRoute.test.ts`
Expected: PASS（原有 D4 用例照绿：措辞没变，引擎只拿 errorClass 落日志，不据它重试）。

- [ ] **Step 5: 提交**

```bash
git add services/runtime/src/hostedRoute.ts tests/runtime/hostedRoute.test.ts
git commit -m "fix(runtime): 已知额度用完那一挡的错带 reroute 分类（#1282）

网关 429 那条一直带，窗口内直接 blocked 的这条不带，于是收口时 errorClass 缺席，
状态表会把「额度用完」画成「出错」。措辞不动。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 列表拼行与「此刻」那一行（shared）

**Files:**
- Modify: `src/shared/wechatInbox.ts`（`FaceCell`、`InboxRow`、`inboxRows`）
- Modify: `src/shared/mobileChat.ts`（`NowPhase`、`NOW_PHASE_TEXT`、`nowRowOf`）
- Test: `tests/shared/wechatInbox.test.ts`、`tests/shared/mobileChat.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `activityFace`、`mostUrgent`、`activityFoldOf`、`activityOf`、`ACTIVITY_ORDER`、`ACTIVITY_TEXT`、`AgentActivity`。
- Produces:
  - `FaceCell.state?: FaceState`（只在不是 plain 时出现）
  - `InboxRow.activity?: AgentActivity`（这一行最要紧的那个；闲着 / 不知道不出现）
  - `inboxRows({ …, activity?: (sessionId: string, agentId: string) => AgentActivity | null })`
  - `type NowPhase = "waiting" | "solving" | "working" | "searching" | "composing" | "queued"`；`NOW_PHASE_TEXT: Record<NowPhase, string>`

- [ ] **Step 1: 写失败的测试**

`tests/shared/wechatInbox.test.ts`：import 里加 `import type { AgentActivity } from "../../src/shared/agentActivity.js";`，在 `describe("inboxRows", ...)` 里（`base` 定义之后）追加：

```ts
  it("状态（#1282）：私聊那格脸带状态、行带 activity；群里每格各带各的、行取最要紧；闲着 / 不知道不带", () => {
    const look = (sid: string, aid: string): AgentActivity | null =>
      sid === "dm1" && aid === "a_000000000001" ? "working"
      : sid === "grp1" && aid === "admin" ? "idle"
      : sid === "grp1" && aid === "a_000000000002" ? "waiting"
      : null;
    const rows = inboxRows({ ...base, activity: look });
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("a:a_000000000001").avatar).toMatchObject({ kind: "face", id: "a_000000000001", state: "working" });
    expect(by("a:a_000000000001").activity).toBe("working");
    const grid = by("g:grp1").avatar;
    expect(grid.kind === "grid" ? grid.cells.map((c) => (c.kind === "face" ? c.state ?? "plain" : c.name)) : []).toEqual(["plain", "waiting"]);
    expect(by("g:grp1").activity).toBe("waiting");
    expect(by("t:ts1").activity).toBeUndefined();
    expect("activity" in by("f:u_aj")).toBe(false);
  });
  it("不给查状态的函数：输出与改动前逐字相同（脸上没有 state、行上没有 activity）", () => {
    const rows = inboxRows(base);
    expect(rows.some((r) => "activity" in r)).toBe(false);
    for (const r of rows) {
      const cells = r.avatar.kind === "grid" ? r.avatar.cells : [r.avatar];
      expect(cells.some((c) => "state" in c)).toBe(false);
    }
  });
```

`tests/shared/mobileChat.test.ts`：import 里加 `NOW_PHASE_TEXT`，在 `describe("nowRowOf", ...)` 里追加：

```ts
  it("完整六档（#1282）：没要刀 = 思考中；要了只读的刀 = 检索中；审批没批 = 等你处理，压过作答", () => {
    const think = { seq: 4, sessionId: "s1", ts: DAY + 4, type: "request_envelope", agentId: "a_000000000001" } as unknown as SessionEvent;
    expect(nowRowOf({ events: [opening("a_000000000001", 3), think], streaming: {}, ws: WS })).toMatchObject({ phase: "composing", face: "composing", canStop: true });
    const read = { seq: 4, sessionId: "s1", ts: DAY + 4, type: "assistant_message", content: "", model: "m", agentId: "a_000000000001", toolCalls: [{ id: "r", name: "read_file", args: {} }] } as unknown as SessionEvent;
    expect(nowRowOf({ events: [opening("a_000000000001", 3), read], streaming: {}, ws: WS })).toMatchObject({ phase: "searching", face: "searching" });
    const approval = { seq: 7, sessionId: "s1", ts: DAY + 7, type: "approval_request", callId: "c", toolName: "bash", argsSummary: "", initiatorUid: "me", expiresTs: 0, agentId: "a_000000000002" } as unknown as SessionEvent;
    const events = [opening("a_000000000001", 3), step("a_000000000001", 4), opening("a_000000000002", 5), step("a_000000000002", 6), approval];
    expect(nowRowOf({ events, streaming: { a_000000000001: "字" }, ws: WS })).toMatchObject({ agentId: "a_000000000002", phase: "waiting", face: "waiting" });
  });
  it("NOW_PHASE_TEXT 与 agentActivity 的说法一致", () => {
    expect(NOW_PHASE_TEXT).toEqual({ waiting: "等你处理", solving: "作答中", working: "执行中", searching: "检索中", composing: "思考中", queued: "排队中" });
  });
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/shared/wechatInbox.test.ts tests/shared/mobileChat.test.ts`
Expected: FAIL（`state` / `activity` 不存在；`phase` 是 `working` 不是 `composing`）。

- [ ] **Step 3: 改 `wechatInbox.ts`**

1. import 加：

```ts
import { activityFace, mostUrgent, type AgentActivity } from "./agentActivity.js";
import type { FaceState } from "./ottoFace/states.js";
```

2. `FaceCell`：

```ts
export interface FaceCell {
  kind: "face";
  id: string;
  slot: number;
  /** 此刻的状态（#1282）。只在不是 plain 时出现：不知道 / 闲着的脸与今天逐字相同 */
  state?: FaceState;
}
```

3. `InboxRow` 加一格（放在 `unread` 后面）：

```ts
  /** 这一行最要紧的那个状态（#1282，角标颜色与读屏文字从它来）。闲着 / 不知道不出现 */
  activity?: AgentActivity;
```

4. `inboxRows` 的入参类型加：

```ts
  /** 查某条会话里某只此刻的状态（#1282）。null = 不知道。缺席 = 输出与改动前逐字相同 */
  activity?: (sessionId: string, agentId: string) => AgentActivity | null;
```

5. 函数体开头（`const dot = …` 之后）加两个小工具：

```ts
  const look = o.activity;
  /** 一格智能体的脸带上它在这条会话里的状态；不知道 / 闲着原样返回（与今天逐字相同） */
  const stated = (cell: FaceCell, sessionId: string): FaceCell => {
    const state = activityFace(look?.(sessionId, cell.id) ?? null);
    return state === "plain" ? cell : { ...cell, state };
  };
  const statedCells = (cells: GridCell[], sessionId: string): GridCell[] =>
    cells.map((c) => (c.kind === "face" ? stated(c, sessionId) : c));
  /** 整个头像那一枚角标说谁：这条会话里几只里最要紧的那个（闲着 / 不知道 = 不带这一格） */
  const rowActivity = (sessionId: string, agentIds: readonly string[]): { activity?: AgentActivity } => {
    if (look === undefined) return {};
    const known = agentIds.map((id) => look(sessionId, id)).filter((a): a is AgentActivity => a !== null);
    const a = mostUrgent(known);
    return a === null || a === "idle" ? {} : { activity: a };
  };
```

6. 四处拼行改成（只改列出的字段，其余不动）：
   - 智能体私聊：`avatar: stated(faceCell(ws, r.agentId), r.sessionId),`，对象末尾加 `...rowActivity(r.sessionId, [r.agentId]),`
   - 主场群：`avatar: { kind: "grid", cells: statedCells(people.length > 0 ? mixedCells(ws, people, g.agentIds) : g.agentIds.slice(0, GRID_MAX).map((id) => faceCell(ws, id)), g.sessionId) },`，末尾加 `...rowActivity(g.sessionId, g.agentIds),`
   - 别人拉我进的群：`avatar: { kind: "grid", cells: statedCells(mixedCells(g.ws, people, g.session.agentIds), g.session.id) },`，末尾加 `...rowActivity(g.session.id, g.session.agentIds),`
   - 团队群：`avatar: { kind: "grid", cells: statedCells(cells, s.id) },`，末尾加 `...rowActivity(s.id, agentIds),`
   - 朋友私聊不动。

- [ ] **Step 4: 改 `mobileChat.ts`**

1. import 加 `import { ACTIVITY_ORDER, ACTIVITY_TEXT, activityFace, activityFoldOf, activityOf, type AgentActivity } from "./agentActivity.js";`，删掉不再用的 `dmFaceState` import（它只在 `nowRowOf` 里用过）。
2. 替换 `NowPhase` / `NOW_PHASE_TEXT` / `PHASE_RANK` 三行：

```ts
/** 「此刻」那一行的六档（#1282）：欠着一轮的那只，状态必然落在这六档里（出错 / 额度用完 / 闲着说的是没欠） */
export type NowPhase = "waiting" | "solving" | "working" | "searching" | "composing" | "queued";
const NOW_PHASES: ReadonlySet<AgentActivity> = new Set<AgentActivity>(["waiting", "solving", "working", "searching", "composing", "queued"]);
const isNowPhase = (a: AgentActivity): a is NowPhase => NOW_PHASES.has(a);
export const NOW_PHASE_TEXT: Record<NowPhase, string> = {
  waiting: ACTIVITY_TEXT.waiting,
  solving: ACTIVITY_TEXT.solving,
  working: ACTIVITY_TEXT.working,
  searching: ACTIVITY_TEXT.searching,
  composing: ACTIVITY_TEXT.composing,
  queued: ACTIVITY_TEXT.queued,
};
```

3. `NowRow.face` 的注释改成 `/** 那张脸的表情（判据同 runtime 写库那一份：shared/agentActivity.ts） */`。
4. `nowRowOf` 的文档注释第一句改成「作答 > 执行 > 排队」→「等你处理 > 作答 > 执行 > 检索 > 思考 > 排队（ACTIVITY_ORDER）」，函数体里选 `best` 的那段换成：

```ts
  const fold = activityFoldOf(o.events);
  let best: { t: OpenTurn; phase: NowPhase } | null = null;
  for (const t of earliest.values()) {
    const a = activityOf(fold, t.agentId, (o.streaming[t.agentId] ?? "") !== "");
    // 欠着一轮的那只必然落在六档里（与 openTurns 对拍过）；万一没有，按 openTurns 那一格兜底
    const phase: NowPhase = isNowPhase(a) ? a : t.state === "queued" ? "queued" : "composing";
    if (
      best === null ||
      ACTIVITY_ORDER.indexOf(phase) < ACTIVITY_ORDER.indexOf(best.phase) ||
      (phase === best.phase && t.seq < best.t.seq)
    ) {
      best = { t, phase };
    }
  }
```

   返回对象里 `face: dmFaceState(turns, o.streaming, t.agentId),` 改成 `face: activityFace(phase),`。

- [ ] **Step 5: 跑测试，确认通过**

Run: `npx vitest run tests/shared/wechatInbox.test.ts tests/shared/mobileChat.test.ts`
Expected: PASS（原有 nowRowOf 用例照绿：要了 bash 的那一步 = 执行中，有正文 = 作答中）。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit && npm --prefix mobile run typecheck`
Expected: 手机那份会报 `ChatScreen.tsx` 的 `PHASE_STATUS` 缺三个键——这是预期的，Task 9 修；根那份无输出。

- [ ] **Step 7: 提交**

```bash
git add src/shared/wechatInbox.ts src/shared/mobileChat.ts tests/shared/wechatInbox.test.ts tests/shared/mobileChat.test.ts
git commit -m "feat(shared): 列表拼行带上状态，「此刻」那一行用完整六档（#1282）

九宫格每格带自己的状态，行上一格 activity 取最要紧；不给查状态的函数时输出与改动前逐字相同。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 手机端

**Files:**
- Create: `mobile/src/activity/activityStore.ts`
- Create: `mobile/src/activity/ActivityFace.tsx`
- Modify: `mobile/src/home/homeStore.ts`（加 `patchHomeLast`）
- Modify: `mobile/src/inbox/teamsStore.ts`（加 `patchTeamLast`）
- Modify: `mobile/src/wx/Badge.tsx`（加 `StatusBadge`）
- Modify: `mobile/src/wx/Avatar.tsx`（`SpecAvatar` / `GridTile` 带状态，文件头注释）
- Modify: `mobile/src/tabs/ChatListRow.tsx`、`mobile/src/inbox/useInbox.ts`、`mobile/src/tabs/ContactsScreen.tsx`、`mobile/src/agent/AgentScreen.tsx`、`mobile/src/chat/ChatScreen.tsx`

**Interfaces:**
- Consumes: Task 2 的全部导出；Task 1 的 `activityBadge`、`activityFace`、`ACTIVITY_TEXT`、`AgentActivity`；Task 8 的 `InboxRow.activity`、`FaceCell.state`、`NowPhase`。
- Produces: `useActivity(): { uid: string | null; rows: ReadonlyMap<string, ActivityRow> }`；`patchHomeLast(sessionId, last): boolean`；`patchTeamLast(sessionId, last): boolean`；`StatusBadge`；`ActivityFace`。

手机组件不进 vitest（RN 渲染没有测试装配），这一片的判据全在 Task 1 / 2 / 8 的 shared 里；这里靠手机那份 tsc + 模拟器 / 真机看。

- [ ] **Step 1: `homeStore.patchHomeLast`**

`mobile/src/home/homeStore.ts` 末尾加：

```ts
/** 实时推送带来的一句（#1282，spec §3.4）：这条是主场的聊天就当场补进 lasts，回 true；不是回 false。
    只往前走：推送晚到、比手上那句还旧的不覆盖 */
export function patchHomeLast(sessionId: string, last: SessionLast): boolean {
  const s = store.get();
  if (!s.chats.some((c) => c.id === sessionId)) return false;
  const cur = s.lasts.get(sessionId);
  if (cur !== undefined && cur.ts >= last.ts) return true;
  const lasts = new Map(s.lasts);
  lasts.set(sessionId, last);
  store.set({ lasts });
  return true;
}
```

- [ ] **Step 2: `teamsStore.patchTeamLast`**

`mobile/src/inbox/teamsStore.ts` 末尾加：

```ts
/** 同 homeStore.patchHomeLast：团队群、别人拉我进的群。不在手上 = 回 false（节流重拉会接住它） */
export function patchTeamLast(sessionId: string, last: SessionLast): boolean {
  const s = store.get();
  const ti = s.teams.findIndex((t) => t.sessions.some((x) => x.id === sessionId));
  if (ti >= 0) {
    const t = s.teams[ti]!;
    const cur = t.lasts.get(sessionId);
    if (cur !== undefined && cur.ts >= last.ts) return true;
    const lasts = new Map(t.lasts);
    lasts.set(sessionId, last);
    const teams = s.teams.slice();
    teams[ti] = { ...t, lasts };
    store.set({ teams });
    return true;
  }
  const gi = s.guests.findIndex((g) => g.session.id === sessionId);
  if (gi < 0) return false;
  const g = s.guests[gi]!;
  if (g.last !== null && g.last.ts >= last.ts) return true;
  const guests = s.guests.slice();
  guests[gi] = { ...g, last };
  store.set({ guests });
  return true;
}
```

- [ ] **Step 3: `activityStore`**

`mobile/src/activity/activityStore.ts`：

```ts
// 每只智能体此刻在干嘛（#1282，spec §3.4）：agent_activity 那张表的本机一份 + 实时推送。
// 判据全在 shared（agentActivity / agentActivityRows），这里只管拉、订、换号清空。
//
// 三条纪律（同 homeStore / friendsStore）：
// · 读不到 ≠ 空：拉失败时手上那份照旧留着；一份都没有时全部画 plain（= 改动前的样子）；
// · 换号整份清掉、退订，旧号的推送不许落进新号那一份（epoch 核一遍）；
// · 回前台重拉一次：切后台那段时间里推送可能断过。
// 顺带订 workspace_sessions：UPDATE 带来的最后一句当场补进主场 / 团队那两份，不重拉；结构变化
// （新会话、改名、归档）另外节流重拉，最多 10 秒一次。agent 说话时最后一句最快 3 秒写一次，
// 每次都重拉整份清单太贵。
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { activityKey, fetchAgentActivity, sessionLastOfRow, subscribeAgentActivity, type ActivityRow } from "../../../src/shared/agentActivityRows.js";
import { createStore } from "../externalStore.js";
import { patchHomeLast, refreshHome } from "../home/homeStore.js";
import { patchTeamLast, refreshTeams } from "../inbox/teamsStore.js";
import { supabase } from "../supabase.js";

export interface ActivityState {
  uid: string | null;
  rows: ReadonlyMap<string, ActivityRow>;
}

const INITIAL: ActivityState = { uid: null, rows: new Map() };
const store = createStore<ActivityState>(INITIAL);

export function useActivity(): ActivityState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 结构变化最多多久重拉一次清单 */
const LIST_REFRESH_MS = 10_000;

let epoch = 0;
let unsubscribe: (() => void) | null = null;
let listTimer: ReturnType<typeof setTimeout> | null = null;

function upsert(r: ActivityRow): void {
  store.set((s) => {
    const rows = new Map(s.rows);
    rows.set(activityKey(r.sessionId, r.agentId), r);
    return { rows };
  });
}

async function refreshActivity(): Promise<void> {
  const mine = epoch;
  const rows = await fetchAgentActivity(supabase);
  if (mine !== epoch || rows === null) return;
  store.set({ rows: new Map(rows.map((r) => [activityKey(r.sessionId, r.agentId), r])) });
}

function onSession(raw: unknown): void {
  const p = sessionLastOfRow(raw);
  if (p !== null && !patchHomeLast(p.sessionId, p.last)) patchTeamLast(p.sessionId, p.last);
  if (listTimer !== null) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    void refreshHome().then(() => refreshTeams());
  }, LIST_REFRESH_MS);
}

async function adopt(uid: string | null): Promise<void> {
  if (uid === store.get().uid) return;
  epoch += 1;
  const mine = epoch;
  unsubscribe?.();
  unsubscribe = null;
  store.set({ ...INITIAL, uid });
  if (uid === null) return;
  await refreshActivity();
  if (mine !== epoch) return;
  unsubscribe = subscribeAgentActivity(supabase, uid, {
    onRow: (r) => {
      if (mine === epoch) upsert(r);
    },
    onSession: (raw) => {
      if (mine === epoch) onSession(raw);
    },
  });
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_event, session) => void adopt(session?.user.id ?? null));

AppState.addEventListener("change", (s) => {
  if (s === "active" && store.get().uid !== null) void refreshActivity();
});
```

- [ ] **Step 4: `StatusBadge`**

`mobile/src/wx/Badge.tsx`：import 加 `import { BADGE_COLORS, type FaceBadge } from "../../../src/shared/ottoFace/index.js";`，末尾加：

```tsx
/** 状态角标（#1282，ADR-0316 的语义色）：头像右下一个圆点，外面一圈底色的环。右上是未读，两枚不打架。
    这里的红只在「出错」时出现，与上面那条「红只用来说出事了」同一个意思 */
export function StatusBadge({ badge, ring, size }: { badge: FaceBadge; ring: string; size: number }) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2 + RING, backgroundColor: BADGE_COLORS[badge],
        borderWidth: RING, borderColor: ring, boxSizing: "content-box",
      }}
    />
  );
}
```

- [ ] **Step 5: `ActivityFace`**

`mobile/src/activity/ActivityFace.tsx`：

```tsx
// 一张带状态的脸 + 右下角标（#1282）。通讯录、资料页共用：脸的表情与角标出自同一个 activity，
// 不会一个说在跑、一个说闲着。会话列表那一行走 SpecAvatar（九宫格每格各带各的），角标在 ChatListRow 里画。
import { View } from "react-native";
import { activityBadge, activityFace, type AgentActivity } from "../../../src/shared/agentActivity.js";
import type { FaceState } from "../../../src/shared/ottoFace/index.js";
import { StatusBadge } from "../wx/Badge.js";
import { FaceTile } from "../wx/Avatar.js";

export function ActivityFace({ slot, size, activity, ring, badgeSize, idle = "plain", radius, phase }: {
  slot: number;
  size: number;
  /** null = 不知道：画 plain、不画角标 */
  activity: AgentActivity | null;
  /** 角标外圈的颜色 = 头像底下那一层的颜色 */
  ring: string;
  badgeSize: number;
  /** 闲着画哪张：列表 plain，单张大脸 alive */
  idle?: FaceState;
  radius?: number;
  phase?: number;
}) {
  const badge = activityBadge(activity);
  return (
    <View>
      <FaceTile
        slot={slot}
        size={size}
        state={activityFace(activity, idle)}
        {...(radius !== undefined ? { radius } : {})}
        {...(phase !== undefined ? { phase } : {})}
      />
      {badge !== null ? (
        <View style={{ position: "absolute", bottom: -3, right: -3 }}>
          <StatusBadge badge={badge} ring={ring} size={badgeSize} />
        </View>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 6: `Avatar.tsx`**

1. 文件头第 7–8 行那两句换成：

```ts
// 会不会动由状态说（faceAnimates）：状态由调用方给（#1282 起列表也按真状态画，判据 shared/agentActivity.ts）；
// 不知道、闲着一律 plain（静止一帧）。九宫格里的小格只动脸、不画角标，角标由那一行统一挂一枚。
```

2. `GridTile` 里 `<FaceTile key={`${ri}-${x.id}-${k}`} slot={x.slot} size={cell} radius={2} />` 改成：

```tsx
              <FaceTile key={`${ri}-${x.id}-${k}`} slot={x.slot} size={cell} radius={2} state={x.state ?? "plain"} />
```

3. `SpecAvatar` 第一行改成：

```tsx
  if (spec.kind === "face") return <FaceTile slot={spec.slot} size={size} state={spec.state ?? "plain"} />;
```

- [ ] **Step 7: `ChatListRow.tsx`**

1. import 加：

```ts
import { ACTIVITY_TEXT, activityBadge } from "../../../src/shared/agentActivity.js";
import { CountBadge, DotBadge, StatusBadge } from "../wx/Badge.js";
```

（替换原来的 `import { CountBadge, DotBadge } from "../wx/Badge.js";`）

2. 组件里 `const unreadText = …` 下面加：

```ts
  const badge = activityBadge(row.activity ?? null);
  const activityText = row.activity !== undefined ? `，${ACTIVITY_TEXT[row.activity]}` : "";
```

3. `accessibilityLabel` 里 `${row.title}` 后面接 `${activityText}`：

```tsx
      accessibilityLabel={`${row.title}${activityText}${unreadText}${row.mention ? "，有人@我" : ""}，${draft !== "" ? `草稿：${draft}` : row.preview}${time !== "" ? `，${time}` : ""}`}
```

4. 头像那个 `<View>` 里、未读那段三元表达式之后加：

```tsx
        {badge !== null ? (
          <View style={{ position: "absolute", bottom: -3, right: -3 }}>
            <StatusBadge badge={badge} ring={c.card} size={10} />
          </View>
        ) : null}
```

- [ ] **Step 8: `useInbox.ts`**

import 加：

```ts
import type { AgentActivity } from "../../../src/shared/agentActivity.js";
import { sessionAgentActivity } from "../../../src/shared/agentActivityRows.js";
import { useActivity } from "../activity/activityStore.js";
import { useNow } from "../ui.js";
```

`useInbox()` 里 `const { seen, openKey } = useSeenStore();` 之后加：

```ts
  const activity = useActivity();
  // 30 秒重判一次陈旧（spec §3.3）：心跳停了的那一行 3 分钟内翻回 plain
  const now = useNow(30_000);
  const look = useMemo(
    () => (sessionId: string, agentId: string): AgentActivity | null => sessionAgentActivity(activity.rows, sessionId, agentId, now),
    [activity.rows, now],
  );
```

`inboxRows({...})` 的入参里加 `activity: look,`，那个 `useMemo` 的依赖数组末尾加 `look`。

- [ ] **Step 9: `ContactsScreen.tsx`**

import 加：

```ts
import { workspaceAgentActivity } from "../../../src/shared/agentActivityRows.js";
import { ActivityFace } from "../activity/ActivityFace.js";
import { useActivity } from "../activity/activityStore.js";
```

（`useNow` 从 `../ui.js` 引，若该文件已 import `../ui.js` 就并进去。）在渲染智能体那一段的组件里（`const { c } = usePalette();` 那一行附近）加：

```ts
  const activity = useActivity();
  const now = useNow(30_000);
```

`agents.map(...)` 里的 `avatar={<FaceTile slot={agentFaceSlot(ws, a.agentId)} size={40} />}` 改成：

```tsx
                avatar={
                  <ActivityFace
                    slot={agentFaceSlot(ws, a.agentId)}
                    size={40}
                    activity={workspaceAgentActivity(activity.rows, ws.id, a.agentId, now)}
                    ring={c.card}
                    badgeSize={9}
                  />
                }
```

（若 `FaceTile` 在这个文件里因此不再被用到，删掉它的 import。）

- [ ] **Step 10: `AgentScreen.tsx`**

import 加：

```ts
import { workspaceAgentActivity } from "../../../src/shared/agentActivityRows.js";
import { ActivityFace } from "../activity/ActivityFace.js";
import { useActivity } from "../activity/activityStore.js";
```

（`useNow` 同上。）`TeamAgent` 与 `AgentScreen` 两个组件各自加：

```ts
  const activity = useActivity();
  const now = useNow(30_000);
```

两处 `avatar={<FaceTile slot={agentFaceSlot(ws, …)} size={68} radius={12} state="alive" phase={facePhase(…)} />}` 分别改成：

```tsx
        avatar={
          <ActivityFace
            slot={agentFaceSlot(ws, agent.agentId)}
            size={68}
            radius={12}
            idle="alive"
            phase={facePhase(agent.agentId)}
            activity={workspaceAgentActivity(activity.rows, ws.id, agent.agentId, now)}
            ring={c.card}
            badgeSize={13}
          />
        }
```

（`AgentScreen` 里那一处用的是 `agentId` 变量，照原样替换 `agent.agentId`。`TeamAgent` 里若没有 `c`，加 `const { c } = usePalette();`。）

- [ ] **Step 11: `ChatScreen.tsx` 头部状态字**

```ts
const PHASE_STATUS: Record<NowRow["phase"], string> = {
  waiting: "等你处理…",
  solving: "正在输入…",
  working: "正在干活…",
  searching: "正在查资料…",
  composing: "正在想…",
  queued: "排队中…",
};
```

文件头注释里「第二行状态（正在输入 / 正在干活 / 排队中 / 正在重连，nowRowOf 推）」改成「第二行状态（等你处理 / 正在输入 / 正在干活 / 正在查资料 / 正在想 / 排队中 / 正在重连，nowRowOf 推）」。

- [ ] **Step 12: 类型检查**

Run: `npm --prefix mobile run typecheck && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 13: 模拟器上看一遍（登录前能看到的有限，登录后要人输密码）**

按 memory「手机端模拟器冒烟怎么跑」：Metro CI 模式不热更，改完要重启 Metro；登录后的屏用 `index.ts` 临时换根组件 + 假数据验完还原。至少确认：列表里私聊那一行在假数据 `working` 时脸在动、右下有蓝点；`failed` 时晕眼、红点；`idle` / 无数据时静止无点；深色模式下角标外圈是底色。截图发给维护者。

- [ ] **Step 14: 提交**

```bash
git add mobile/src/activity mobile/src/home/homeStore.ts mobile/src/inbox/teamsStore.ts mobile/src/wx/Badge.tsx mobile/src/wx/Avatar.tsx mobile/src/tabs/ChatListRow.tsx mobile/src/inbox/useInbox.ts mobile/src/tabs/ContactsScreen.tsx mobile/src/agent/AgentScreen.tsx mobile/src/chat/ChatScreen.tsx
git commit -m "feat(mobile): 列表、通讯录、资料页、聊天页按真实状态画像素脸与角标（#1282）

agent_activity 全量拉一次 + 实时推送；最后一句就地补、结构变化 10 秒内重拉一次。
角标在右下，右上照旧是未读。闲着静止，动 = 在干活。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: ADR 与索引

**Files:**
- Create: `docs/adr/0330-智能体状态画在头像上-新表加实时推送-判定一份放shared.md`
- Modify: `AGENTS.md`（Where to find things 末尾加一条）

- [ ] **Step 1: 写 ADR**

```markdown
# ADR-0330：智能体的状态画在头像上——新表 + 实时推送，判定一份放 shared

- 日期：2026-09-28
- 状态：已采纳
- 关联：#1282。spec `docs/superpowers/specs/2026-09-28-agent-status-design.md`，计划 `docs/superpowers/plans/2026-09-28-agent-status.md`
- 关系：接 ADR-0316（像素脸 17 档，动效不改）；「欠不欠、在不在跑」沿用 `openTurns` 的语义（#932）

## 背景

- 维护者 2026-09-28：「在智能体不同的运行状态下，没有用动态来展示」。动效是现成的，缺的是数据和接线。
- 聊天页外面拿不到谁在跑：手机同一时刻只连一条云会话，列表、通讯录只能画静止的脸（ADR-0316 的 `plain`）。

## 决定

1. **判定只写一份**：`src/shared/agentActivity.ts`。runtime 写库、手机聊天页现算都调它，列表和聊天页由构造就是同一个判据。
   「欠不欠、在不在跑」与 `openTurns` 在 200 份伪随机日志的每个前缀上对拍。
2. **新表 `agent_activity`（0044）+ Supabase 实时推送**。一行 = 一条会话里的一只。闲下来写 `idle` 不删行，客户端只订 INSERT / UPDATE：Realtime 对 DELETE 不查 RLS。
   `workspace_sessions` 顺带进推送，列表的最后一句跟着脸一起变。
3. **runtime 在 `notify()` 里逐条折叠**，经 `CloudSessionMeta.setActivity` 合帧写库（1 秒）。它是接口方法，漏实现编译不过。
4. **心跳与陈旧**：此刻在进行的几档 60 秒心跳、3 分钟没心跳就当不知道。出错、额度用完是上一轮的结局，不心跳不过期。
   daemon 启动先归零、再补开房间，顺序由读源码的断言钉着。
5. **工具「在手上」从模型要了那一刻算起**，不等 `tool_execution_started`：中间那段在等审批或容器锁。
6. **已知额度用完那一挡的错补上 `reroute` 分类**：不补的话会被画成「出错」。

## 否决的

- **状态塞进 `workspace_sessions` 一列 jsonb**：状态与最后一句两种写入节奏搅在同一行，每翻一次状态推一次整行。
- **runtime 经中继直接广播**：要新造房间、长连接、快照三样；手机已经在用 Supabase 实时推送（好友）。
- **runtime 按自己的队列判**（比日志更准）：那样列表与聊天页就是两份判据。

## 代价与推翻前提

- 写库：每条活跃会话最多 1 秒一次，每只在忙的智能体每分钟一次心跳。
- Realtime 每次变更按订阅者各查一遍 RLS；量大了换 Broadcast from Database，表和判据不变。
- 「不知道」与「闲着」在列表上长得一样，这是有意的。
- daemon 崩了之后最多 3 分钟还画旧状态。
- `openTurns` 的已知缺陷（同一只被点第二次读成在跑）跟着进来。
- 聊天页只载尾巴（ADR-0300），很久以前那次出错不在窗口里时，头部不画出错，列表照画。
- 桌面这一版不动，等 #1403。
- 要先跑 0044、再部署 runtime，手机要打新包（#791）。
```

- [ ] **Step 2: AGENTS.md 索引加一条**（放在「Where to find things」最后一条 `mobile/plugins/withSceneLifecycle.js` 之后）

```markdown
- `src/shared/agentActivity.ts` / `agentActivityRows.ts` / `services/runtime/src/activityWriter.ts` / `supabase/migrations/0044_agent_activity.sql` / `mobile/src/activity/` — **智能体此刻在干嘛，画在头像上**（ADR-0330，#1282）。判定只写一份：runtime 按它写 `agent_activity`（每条会话每只一行），手机聊天页按它现算，列表读那一行加实时推送，两处由构造就是同一个判据。「欠不欠、在不在跑」与 `openTurns` 对拍；工具「在手上」从模型要了那一刻算起。闲下来写 `idle` 不删行：Realtime 对 DELETE 不查 RLS，客户端也只订 INSERT / UPDATE。此刻在进行的几档 60 秒心跳、3 分钟没心跳当不知道；出错、额度用完不过期。daemon 启动先归零再补开房间，顺序反了会盖掉真状态（读源码的断言钉着）。已知额度用完那一挡的错补了 `reroute` 分类，不补会画成「出错」。桌面等 #1403。**要先跑 0044、再部署 runtime**（#791）
```

- [ ] **Step 3: 跑 ADR 编号与文档用例**

Run: `npx vitest run tests/docs`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add docs/adr/0330-智能体状态画在头像上-新表加实时推送-判定一份放shared.md AGENTS.md
git commit -m "docs: ADR-0330 智能体状态画在头像上 + 索引（#1282）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 门禁、PR、部署、真机

- [ ] **Step 1: 全量门禁**

```bash
npm test > /private/tmp/claude-501/-Users-stanyan-Github-Mr-Otto--claude-worktrees-issue-1302-d5947b/0a664fd3-dba3-40b9-99fb-d404c4e3ab75/scratchpad/gate-1282.log 2>&1; echo "GATE_EXIT=$?" >> /private/tmp/claude-501/-Users-stanyan-Github-Mr-Otto--claude-worktrees-issue-1302-d5947b/0a664fd3-dba3-40b9-99fb-d404c4e3ab75/scratchpad/gate-1282.log
```

Expected: 日志末行 `GATE_EXIT=0`。不是 0 就修，别往下走。

- [ ] **Step 2: 推分支、开 PR**（正文写清：做了什么、没覆盖到什么、部署顺序；`Closes #1282`），然后 `mcp__ccd_pr__get_status` 绑定，不轮询 CI。

- [ ] **Step 3: 在生产库跑 0044 之前问维护者**（生产库动作要明说才放行）。放行后用 scratchpad 的 `sql.py` 逐条发，跑完核：
  - `select count(*) from public.agent_activity` → 0
  - `select relrowsecurity from pg_class where relname = 'agent_activity'` → true
  - `select polname, polcmd from pg_policy where polrelid = 'public.agent_activity'::regclass` → 只有 `aa_select` / `r`
  - `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('agent_activity','workspace_sessions')` → 两行

- [ ] **Step 4: CI 绿了合并**：re-fetch，核 ADR 编号（`git -c core.quotePath=false ls-tree --name-only origin/main docs/adr/`）；0330 被 #1403 占了就改号为 max+1，顶上加 `原为 ADR-0330`，同步改 AGENTS.md 那条引用。`gh pr merge <N> --merge`，合完再核一遍编号不重。

- [ ] **Step 5: 部署 runtime（从合并后的 main）**

```bash
RUNTIME_SSH=stan@65.109.113.168 npm run runtime:deploy
```

```bash
RUNTIME_SSH=stan@65.109.113.168 npm run deploy:check
```

Expected: runtime 指纹 `current`。部署后在 VPS journal 里确认没有「智能体状态写入失败」刷屏。

- [ ] **Step 6: 打真机包**（ADR-0329 附录的三个环境坑：UTF-8 locale、lane 里 `mobile/node_modules` 真装、prebuild 在 `mobile/` 里跑）

```bash
rm mobile/node_modules && npm --prefix mobile ci
```

```bash
cd mobile && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run ios -- --device 00008140-00112D4E1AF1801C --configuration Release
```

- [ ] **Step 7: 真机验收**（登录要维护者自己输密码）：给一只智能体派个要读文件、跑命令的活，回到会话列表看那一行的脸从排队 → 思考 → 检索 / 执行 → 作答 → 静止；通讯录那只同步；锁屏再回来列表照旧对。把结果写进 #1282 的评论，合并时 `Closes #1282`。
